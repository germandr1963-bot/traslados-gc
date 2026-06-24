const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const ExcelJS = require('exceljs');
const { medirPxTitulo, medirPxDescripcion } = require('./medidor-pixeles');

const app = express();

// ─── Email (Nodemailer / Gmail) ───────────────────────────────────────────────
// ─── Email via Resend ─────────────────────────────────────────────────────────
async function enviarEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('Email no configurado — falta RESEND_API_KEY');
    return false;
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      from: 'Traslados GC <onboarding@resend.dev>',
      to: [to],
      subject: subject,
      html: html
    })
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error('Resend error ' + response.status + ': ' + error);
  }
  return true;
}
const PORT = process.env.PORT || 3000;

// Motor de plantillas EJS para las páginas de ruta renderizadas en servidor
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Si una conexión guardada en el pool se queda muerta (por ejemplo, porque
// Neon "duerme" la base de datos por inactividad), esto evita que todo el
// servidor se caiga. El pool simplemente descarta esa conexión y abre una
// nueva la próxima vez que haga falta.
pool.on('error', function (err) {
  console.error('Error inesperado en una conexión inactiva del pool:', err.message);
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB para permitir Excel de traducciones
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new pgSession({ pool: pool, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'cambia-este-secreto',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 }
}));

// ─── Idiomas y secciones ────────────────────────────────────────────────────
// Estas dos ya NO están escritas a mano: se cargan de la tabla `idiomas_web`
// al arrancar el servidor (y se recargan al añadir un idioma nuevo desde el
// admin), para que añadir un idioma no requiera tocar código nunca más.
let IDIOMAS_PERMITIDOS = [];
let SECCIONES_TRASLADO = {};
let IDIOMA_BASE = 'es';

async function cargarIdiomasCache() {
  const result = await pool.query(
    'SELECT codigo, palabra_traslado, es_base FROM idiomas_web WHERE activo = TRUE ORDER BY orden, codigo'
  );
  IDIOMAS_PERMITIDOS = result.rows.map(function (r) { return r.codigo; });
  SECCIONES_TRASLADO = {};
  for (const fila of result.rows) {
    SECCIONES_TRASLADO[fila.codigo] = fila.palabra_traslado;
    if (fila.es_base) IDIOMA_BASE = fila.codigo;
  }
  IDIOMAS_TRADUCIBLES = IDIOMAS_PERMITIDOS.filter(function (l) { return l !== IDIOMA_BASE; });
}

// URL base del sitio — se usa para construir canonical y hreflang
const BASE_URL = process.env.BASE_URL || 'https://traslados-gc.onrender.com';

// ─── Sistema de traducción de la interfaz de la web ──────────────────────────
// Caché en memoria de todos los textos fijos y sus traducciones, para no
// consultar la base de datos en cada visita. Se recarga al arrancar el
// servidor y cada vez que se guarda o importa una traducción desde el admin.
let TEXTOS_CACHE = {};

async function cargarTextosCache() {
  const textos = await pool.query('SELECT id, clave, modulo, contexto, texto_es FROM textos_interfaz');
  const traducciones = await pool.query('SELECT texto_id, lang_code, texto FROM textos_interfaz_traducciones');

  const nuevaCache = {};
  for (const fila of textos.rows) {
    nuevaCache[fila.clave] = {
      id: fila.id, modulo: fila.modulo, contexto: fila.contexto,
      texto_es: fila.texto_es, traducciones: {}
    };
  }
  for (const fila of traducciones.rows) {
    const entrada = Object.values(nuevaCache).find(function (e) { return e.id === fila.texto_id; });
    if (entrada) entrada.traducciones[fila.lang_code] = fila.texto;
  }
  TEXTOS_CACHE = nuevaCache;
}

// Devuelve el texto traducido de una clave en un idioma. Si falta la
// traducción, cae al español; si la clave ni existe, devuelve la propia
// clave entre corchetes para que sea fácil detectar el fallo durante pruebas.
function obtenerTexto(clave, lang) {
  const entrada = TEXTOS_CACHE[clave];
  if (!entrada) return '[[' + clave + ']]';
  if (lang !== 'es' && entrada.traducciones[lang]) return entrada.traducciones[lang];
  return entrada.texto_es;
}

// ─── Helpers generales ───────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session && req.session.adminId) {
    return next();
  }
  return res.status(401).json({ error: 'No autorizado' });
}

// Envuelve cada ruta que habla con la base de datos: si algo falla (por
// ejemplo, una consulta justo cuando la conexión se estaba reconectando),
// se devuelve un error claro al navegador en vez de dejarlo colgado o
// romper el servidor entero. El error real se imprime en los registros de
// Render para poder diagnosticarlo.
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(function (err) {
      console.error('Error en ' + req.method + ' ' + req.originalUrl + ':', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error temporal del servidor. Intenta de nuevo en unos segundos.' });
      }
    });
  };
}

// ─── Helpers SEO ─────────────────────────────────────────────────────────────

// Limpia cualquier texto para usarlo como slug en una URL:
// quita tildes, caracteres especiales, cirílico, etc.
// Solo permite letras latinas (a-z), números y guiones.
function slugify(texto) {
  return String(texto)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quita tildes y diacríticos
    .replace(/[^a-z0-9\s-]/g, '')    // quita todo lo que no sea latín básico
    .trim()
    .replace(/\s+/g, '-')            // espacios → guiones
    .replace(/-+/g, '-');            // guiones múltiples → uno solo
}

// Convierte "Las Palmas de Gran Canaria" + "Maspalomas"
// en "las-palmas-de-gran-canaria-a-maspalomas"
function generarSlug(origen, destino) {
  return slugify(origen) + '-a-' + slugify(destino);
}

// Crea las 8 fichas SEO (una por idioma) para una ruta nueva.
// Si ya existen, no hace nada (ON CONFLICT DO NOTHING).
async function crearFichasSEOSiFaltan(rutaId, origen, destino) {
  const slug = generarSlug(origen, destino);
  for (const lang of IDIOMAS_PERMITIDOS) {
    await pool.query(
      `INSERT INTO route_seo_settings (route_id, lang_code, slug_url)
       VALUES ($1, $2, $3)
       ON CONFLICT (route_id, lang_code) DO NOTHING`,
      [rutaId, lang, slug]
    );
  }
}

// ─── Esquema de base de datos ─────────────────────────────────────────────────
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      usuario VARCHAR(100) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      creado_en TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fondos_portada (
      id SERIAL PRIMARY KEY,
      nombre VARCHAR(100) NOT NULL,
      imagen BYTEA NOT NULL,
      tipo_mime VARCHAR(50) NOT NULL,
      activo BOOLEAN DEFAULT FALSE,
      creado_en TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS categorias_vehiculos (
      id SERIAL PRIMARY KEY,
      nombre VARCHAR(100) NOT NULL,
      capacidad_pasajeros INT NOT NULL DEFAULT 4,
      capacidad_maletas INT NOT NULL DEFAULT 2,
      activa BOOLEAN DEFAULT TRUE,
      orden INT DEFAULT 0,
      creado_en TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`ALTER TABLE categorias_vehiculos ALTER COLUMN capacidad_maletas DROP DEFAULT;`);
  await pool.query(`ALTER TABLE categorias_vehiculos ALTER COLUMN capacidad_maletas TYPE TEXT USING capacidad_maletas::TEXT;`);
  await pool.query(`ALTER TABLE categorias_vehiculos ALTER COLUMN capacidad_maletas SET DEFAULT '2';`);
  await pool.query(`ALTER TABLE categorias_vehiculos ADD COLUMN IF NOT EXISTS descripcion TEXT;`);
  await pool.query(`ALTER TABLE categorias_vehiculos ADD COLUMN IF NOT EXISTS limite_sillas INT DEFAULT 0;`);
  await pool.query(`ALTER TABLE categorias_vehiculos ADD COLUMN IF NOT EXISTS disponible BOOLEAN DEFAULT TRUE;`);
  await pool.query(`ALTER TABLE categorias_vehiculos ADD COLUMN IF NOT EXISTS bajada_diurna NUMERIC(10,2) DEFAULT 0;`);
  await pool.query(`ALTER TABLE categorias_vehiculos ADD COLUMN IF NOT EXISTS bajada_nocturna NUMERIC(10,2) DEFAULT 0;`);
  await pool.query(`ALTER TABLE categorias_vehiculos ADD COLUMN IF NOT EXISTS foto TEXT;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rutas (
      id SERIAL PRIMARY KEY,
      origen VARCHAR(150) NOT NULL,
      destino VARCHAR(150) NOT NULL,
      activa BOOLEAN DEFAULT TRUE,
      creado_en TIMESTAMP DEFAULT NOW()
    );
  `);

  // Prioridad/frecuencia para el sitemap, e imagen propia para vistas previas
  // de WhatsApp/redes — ambas son características del destino, no del idioma,
  // así que viven en la tabla de rutas y valen para sus 9 versiones de idioma.
  await pool.query(`ALTER TABLE rutas ADD COLUMN IF NOT EXISTS sitemap_prioridad NUMERIC(2,1) DEFAULT 0.8;`);
  await pool.query(`ALTER TABLE rutas ADD COLUMN IF NOT EXISTS sitemap_frecuencia VARCHAR(20) DEFAULT 'monthly';`);
  await pool.query(`ALTER TABLE rutas ADD COLUMN IF NOT EXISTS imagen_og TEXT;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rutas_precios (
      id SERIAL PRIMARY KEY,
      ruta_id INT NOT NULL REFERENCES rutas(id) ON DELETE CASCADE,
      categoria_id INT NOT NULL REFERENCES categorias_vehiculos(id) ON DELETE CASCADE,
      precio NUMERIC(10,2) NOT NULL,
      UNIQUE(ruta_id, categoria_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS marcas_vehiculos (
      id SERIAL PRIMARY KEY,
      nombre TEXT UNIQUE NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS modelos_vehiculos (
      id SERIAL PRIMARY KEY,
      marca_id INT REFERENCES marcas_vehiculos(id),
      nombre TEXT NOT NULL,
      UNIQUE (marca_id, nombre)
    );
  `);
  const marcasSemilla = {
    'Toyota': ['Prius', 'Corolla', 'Camry', 'RAV4'],
    'Skoda': ['Octavia', 'Superb'],
    'Mercedes-Benz': ['Clase C', 'Clase E', 'Vito'],
    'Volkswagen': ['Passat', 'Touran', 'Caddy'],
    'Seat': ['León', 'Alhambra', 'Ateca'],
    'Ford': ['Mondeo', 'Galaxy', 'Tourneo'],
    'Peugeot': ['508', '5008', 'Rifter'],
    'Citroën': ['C5 X', 'Berlingo'],
    'Hyundai': ['Ioniq', 'Tucson'],
    'Kia': ['Niro', 'Ceed'],
    'Renault': ['Talisman', 'Espace'],
    'Dacia': ['Lodgy', 'Jogger'],
    'Tesla': ['Model 3', 'Model Y']
  };
  for (const [marca, modelos] of Object.entries(marcasSemilla)) {
    const m = await pool.query(
      `INSERT INTO marcas_vehiculos (nombre) VALUES ($1) ON CONFLICT (nombre) DO UPDATE SET nombre = $1 RETURNING id`,
      [marca]
    );
    for (const modelo of modelos) {
      await pool.query(
        `INSERT INTO modelos_vehiculos (marca_id, nombre) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [m.rows[0].id, modelo]
      );
    }
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS conductores (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      telefono TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      documento TEXT,
      direccion TEXT,
      cp TEXT,
      municipio TEXT,
      municipio_licencia TEXT,
      numero_licencia TEXT,
      central_flota TEXT,
      categoria_id INT REFERENCES categorias_vehiculos(id),
      vehiculo_marca TEXT,
      vehiculo_modelo TEXT,
      matricula TEXT,
      numero_taxi TEXT,
      plazas INT DEFAULT 4,
      isla TEXT DEFAULT 'Gran Canaria',
      tipo TEXT DEFAULT 'externo',
      estado TEXT DEFAULT 'pendiente',
      foto TEXT,
      foto_estado TEXT DEFAULT 'sin_foto',
      foto_motivo TEXT,
      permite_contacto BOOLEAN DEFAULT TRUE,
      creado_en TIMESTAMP DEFAULT NOW()
    );
  `);

  // Columna activo en route_seo_settings: controla si la página
  // de esa ruta en ese idioma está visible en internet o no.
  await pool.query(`
    ALTER TABLE route_seo_settings ADD COLUMN IF NOT EXISTS activo BOOLEAN DEFAULT FALSE;
  `);

  // Permite que sitemap.xml y robots.txt tengan una versión editada a mano
  // que sustituya a la generada automáticamente, cuando se active.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_archivos_manual (
      nombre TEXT PRIMARY KEY,
      contenido TEXT,
      activo BOOLEAN DEFAULT FALSE,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Redirecciones 301 — para cuando una URL antigua deja de existir
  // (por ejemplo, al cambiar un slug) y hay que enviar a Google y a los
  // visitantes a la dirección nueva, sin perder lo que ya estaba posicionado.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS redirecciones_301 (
      id SERIAL PRIMARY KEY,
      ruta_antigua TEXT UNIQUE NOT NULL,
      ruta_nueva TEXT NOT NULL,
      creado_en TIMESTAMP DEFAULT NOW()
    );
  `);

  // Ajustes globales de SEO: nombre de marca, imagen de respaldo cuando una
  // ruta no tiene la suya propia, y si las etiquetas de Twitter/X están
  // activas. Una única fila (id = 1) que se edita desde el admin.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ajustes_seo_globales (
      id INT PRIMARY KEY DEFAULT 1,
      nombre_marca TEXT DEFAULT 'Traslados · GC',
      imagen_og_defecto TEXT,
      twitter_activo BOOLEAN DEFAULT FALSE,
      updated_at TIMESTAMP DEFAULT NOW(),
      CONSTRAINT solo_una_fila CHECK (id = 1)
    );
  `);
  await pool.query(`
    INSERT INTO ajustes_seo_globales (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  `);

  // ─── Sistema de traducción de la interfaz de la web ──────────────────────
  // Distinto del SEO: esto traduce los textos fijos de la propia página
  // (botones, títulos, etiquetas), no los datos de cada ruta.
  // El texto en español es la fuente de verdad y se gestiona desde el código;
  // las traducciones a los demás idiomas se gestionan desde el admin.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS textos_interfaz (
      id SERIAL PRIMARY KEY,
      clave TEXT UNIQUE NOT NULL,
      modulo TEXT NOT NULL,
      contexto TEXT,
      texto_es TEXT NOT NULL,
      creado_en TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS textos_interfaz_traducciones (
      id SERIAL PRIMARY KEY,
      texto_id INT NOT NULL REFERENCES textos_interfaz(id) ON DELETE CASCADE,
      lang_code VARCHAR(2) NOT NULL,
      texto TEXT,
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(texto_id, lang_code)
    );
  `);

  // Los 21 textos fijos de la página de ruta (traslado.ejs), con su contexto
  // para que cualquier traductor sepa exactamente dónde aparece cada uno.
  // El español se mantiene siempre sincronizado con el código en cada deploy.
  const TEXTOS_INTERFAZ_SEMILLA = [
    { clave: 'nav_volver_rutas', modulo: 'Página de ruta', contexto: 'Enlace arriba a la derecha de la cabecera, vuelve a la página principal', es: '← Todas las rutas', en: '← All routes' },
    { clave: 'etiqueta_categoria_ruta', modulo: 'Página de ruta', contexto: 'Etiqueta pequeña en mayúsculas, encima del título de la ruta', es: 'Traslado intermunicipal · Gran Canaria', en: 'Intermunicipal transfer · Gran Canaria' },
    { clave: 'subtitulo_hero', modulo: 'Página de ruta', contexto: 'Frase debajo del título de la ruta, resume la propuesta de valor', es: 'Precio fijo, chofer confirmado antes de salir. Sin sorpresas en la factura.', en: 'Fixed price, confirmed driver before you leave. No surprises on the bill.' },
    { clave: 'boton_solicitar_traslado', modulo: 'Página de ruta', contexto: 'Texto del botón principal de reserva (aparece dos veces en la página)', es: 'Solicitar este traslado', en: 'Request this transfer' },
    { clave: 'titulo_tarifas', modulo: 'Página de ruta', contexto: 'Título de la sección con la tabla de precios', es: 'Tarifas disponibles', en: 'Available rates' },
    { clave: 'tabla_columna_categoria', modulo: 'Página de ruta', contexto: 'Cabecera de columna en la tabla de tarifas', es: 'Categoría', en: 'Category' },
    { clave: 'tabla_columna_pasajeros', modulo: 'Página de ruta', contexto: 'Cabecera de columna en la tabla de tarifas', es: 'Pasajeros', en: 'Passengers' },
    { clave: 'tabla_columna_equipaje', modulo: 'Página de ruta', contexto: 'Cabecera de columna en la tabla de tarifas', es: 'Equipaje', en: 'Luggage' },
    { clave: 'tabla_columna_precio', modulo: 'Página de ruta', contexto: 'Cabecera de columna en la tabla de tarifas', es: 'Precio', en: 'Price' },
    { clave: 'sufijo_pax', modulo: 'Página de ruta', contexto: 'Abreviatura que sigue al número de plazas en la tabla, ej: "4 pax"', es: 'pax', en: 'pax' },
    { clave: 'badge_precio_fijo', modulo: 'Página de ruta', contexto: 'Etiqueta pequeña junto al precio cuando es fijo', es: 'precio fijo', en: 'fixed price' },
    { clave: 'texto_a_consultar', modulo: 'Página de ruta', contexto: 'Texto que sustituye al precio cuando esa categoría aún no tiene precio cargado', es: 'A consultar', en: 'On request' },
    { clave: 'texto_consulta_disponibilidad', modulo: 'Página de ruta', contexto: 'Párrafo que se muestra si la ruta todavía no tiene ningún precio cargado', es: 'Consulta disponibilidad y precio para este traslado.', en: 'Check availability and price for this transfer.' },
    { clave: 'titulo_como_funciona', modulo: 'Página de ruta', contexto: 'Título de la sección de 3 pasos que explica el proceso de reserva', es: 'Cómo funciona', en: 'How it works' },
    { clave: 'paso1_titulo', modulo: 'Página de ruta', contexto: 'Título del paso 1 en la sección "Cómo funciona"', es: '1. Reserva', en: '1. Booking' },
    { clave: 'paso1_texto', modulo: 'Página de ruta', contexto: 'Descripción del paso 1 en la sección "Cómo funciona"', es: 'Solicitas el traslado con tu ruta y categoría de vehículo. Ves el precio fijo antes de confirmar.', en: 'Request your transfer with your route and vehicle category. See the fixed price before confirming.' },
    { clave: 'paso2_titulo', modulo: 'Página de ruta', contexto: 'Título del paso 2 en la sección "Cómo funciona"', es: '2. Confirmación', en: '2. Confirmation' },
    { clave: 'paso2_texto', modulo: 'Página de ruta', contexto: 'Descripción del paso 2 en la sección "Cómo funciona"', es: 'Un chofer acepta tu viaje y te lo confirmamos antes de que salgas de casa.', en: 'A driver accepts your trip and we confirm it before you leave home.' },
    { clave: 'paso3_titulo', modulo: 'Página de ruta', contexto: 'Título del paso 3 en la sección "Cómo funciona"', es: '3. Viaje', en: '3. Trip' },
    { clave: 'paso3_texto', modulo: 'Página de ruta', contexto: 'Descripción del paso 3 en la sección "Cómo funciona"', es: 'Coordinamos los detalles por WhatsApp. Tu chofer ya sabe dónde y cuándo recogerte.', en: 'We coordinate the details by WhatsApp. Your driver already knows where and when to pick you up.' },
    { clave: 'titulo_rutas_relacionadas', modulo: 'Página de ruta', contexto: 'Encabezado de la sección final con enlaces a otras rutas; va seguido del nombre del origen, ej: "Otros traslados desde Las Palmas"', es: 'Otros traslados desde', en: 'Other transfers from' }
  ];

  for (const t of TEXTOS_INTERFAZ_SEMILLA) {
    const fila = await pool.query(
      `INSERT INTO textos_interfaz (clave, modulo, contexto, texto_es)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (clave) DO UPDATE SET modulo = $2, contexto = $3, texto_es = $4
       RETURNING id`,
      [t.clave, t.modulo, t.contexto, t.es]
    );
    const textoId = fila.rows[0].id;
    if (t.en) {
      await pool.query(
        `INSERT INTO textos_interfaz_traducciones (texto_id, lang_code, texto)
         VALUES ($1, 'en', $2)
         ON CONFLICT (texto_id, lang_code) DO NOTHING`,
        [textoId, t.en]
      );
    }
  }

  await cargarTextosCache();

  // ─── Tarifario de precios ─────────────────────────────────────────────────
  // Todos los valores del tarifario son editables desde el admin — si el
  // Cabildo cambia las tarifas, German solo tiene que actualizar estos campos.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tarifario (
      id INT PRIMARY KEY DEFAULT 1,
      bajada_bandera NUMERIC(6,2) DEFAULT 3.00,
      precio_km_diurno NUMERIC(6,2) DEFAULT 1.35,
      suplemento_aeropuerto NUMERIC(6,2) DEFAULT 2.10,
      CONSTRAINT solo_una_fila CHECK (id = 1)
    );
  `);
  await pool.query(`INSERT INTO tarifario (id) VALUES (1) ON CONFLICT (id) DO NOTHING;`);

  // ─── Configuración de idiomas de la web ──────────────────────────────────
  // Antes vivía escrita a mano en el código (IDIOMAS_PERMITIDOS y
  // SECCIONES_TRASLADO); ahora vive aquí, para poder añadir un idioma nuevo
  // desde el admin sin tocar código ni redesplegar.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS idiomas_web (
      codigo VARCHAR(2) PRIMARY KEY,
      nombre TEXT NOT NULL,
      palabra_traslado TEXT NOT NULL,
      es_base BOOLEAN DEFAULT FALSE,
      activo BOOLEAN DEFAULT TRUE,
      orden INT DEFAULT 0,
      creado_en TIMESTAMP DEFAULT NOW()
    );
  `);

  const IDIOMAS_WEB_SEMILLA = [
    { codigo: 'es', nombre: 'Español', palabra: 'traslado', base: true, orden: 1 },
    { codigo: 'en', nombre: 'Inglés', palabra: 'transfer', base: false, orden: 2 },
    { codigo: 'de', nombre: 'Alemán', palabra: 'transfer', base: false, orden: 3 },
    { codigo: 'sv', nombre: 'Sueco', palabra: 'transfer', base: false, orden: 4 },
    { codigo: 'no', nombre: 'Noruego', palabra: 'transfer', base: false, orden: 5 },
    { codigo: 'nl', nombre: 'Holandés', palabra: 'transfer', base: false, orden: 6 },
    { codigo: 'it', nombre: 'Italiano', palabra: 'trasferimento', base: false, orden: 7 },
    { codigo: 'fr', nombre: 'Francés', palabra: 'transfert', base: false, orden: 8 },
    { codigo: 'fi', nombre: 'Finés', palabra: 'siirto', base: false, orden: 9 }
  ];
  for (const idioma of IDIOMAS_WEB_SEMILLA) {
    await pool.query(
      `INSERT INTO idiomas_web (codigo, nombre, palabra_traslado, es_base, orden)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (codigo) DO NOTHING`,
      [idioma.codigo, idioma.nombre, idioma.palabra, idioma.base, idioma.orden]
    );
  }

  await cargarIdiomasCache();

  // ─── Cotizaciones ────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cotizaciones (
      id SERIAL PRIMARY KEY,
      origen TEXT NOT NULL,
      destino TEXT NOT NULL,
      fecha_aproximada DATE,
      num_pasajeros INT,
      email_cliente TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'pendiente',
      respuesta_enviada BOOLEAN DEFAULT FALSE,
      creado_en TIMESTAMP DEFAULT NOW()
    );
  `);

  // ─── Cotizaciones × Precios propuestos ────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cotizaciones_precios (
      id SERIAL PRIMARY KEY,
      cotizacion_id INT NOT NULL REFERENCES cotizaciones(id) ON DELETE CASCADE,
      categoria_id INT NOT NULL REFERENCES categorias_vehiculos(id) ON DELETE CASCADE,
      precio NUMERIC(10,2) NOT NULL,
      UNIQUE(cotizacion_id, categoria_id)
    );
  `);

  // ─── Destinos ─────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS destinos (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      activo BOOLEAN DEFAULT TRUE,
      creado_en TIMESTAMP DEFAULT NOW()
    );
  `);

  // Destinos iniciales (solo se insertan si la tabla está vacía)
  await pool.query(`
    INSERT INTO destinos (nombre)
    SELECT * FROM (VALUES
      ('Aeropuerto de Gran Canaria'),
      ('Las Palmas de Gran Canaria'),
      ('Maspalomas'),
      ('Playa del Inglés'),
      ('Puerto de Mogán'),
      ('Puerto Rico'),
      ('Arguineguín'),
      ('San Bartolomé de Tirajana'),
      ('Santa Lucía de Tirajana'),
      ('Telde'),
      ('Ingenio'),
      ('Agüimes'),
      ('Vecindario'),
      ('Mogán (municipio)'),
      ('Santa Brígida'),
      ('Teror'),
      ('Arucas'),
      ('Gáldar'),
      ('Puerto de Las Palmas (La Luz)'),
      ('Puerto Deportivo de Mogán')
    ) AS v(nombre)
    WHERE NOT EXISTS (SELECT 1 FROM destinos LIMIT 1);
  `);

  // ─── Destinos: traducciones ───────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS destinos_traducciones (
      id SERIAL PRIMARY KEY,
      destino_id INT NOT NULL REFERENCES destinos(id) ON DELETE CASCADE,
      lang_code VARCHAR(5) NOT NULL,
      nombre TEXT,
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(destino_id, lang_code)
    );
  `);

    // ─── Extras ───────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS extras (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      precio NUMERIC(10,2) NOT NULL DEFAULT 0,
      activo BOOLEAN DEFAULT TRUE,
      creado_en TIMESTAMP DEFAULT NOW()
    );
  `);

  // Dos extras de ejemplo (solo se insertan si la tabla está vacía)
  await pool.query(`
    INSERT INTO extras (nombre, precio)
    SELECT * FROM (VALUES
      ('Silla de seguridad para niños', 5.00),
      ('Transporte de bicicleta', 10.00)
    ) AS v(nombre, precio)
    WHERE NOT EXISTS (SELECT 1 FROM extras LIMIT 1);
  `);

  // ─── Reservas ─────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reservas (
      id SERIAL PRIMARY KEY,
      numero_reserva TEXT UNIQUE,
      ruta_id INT REFERENCES rutas(id) ON DELETE SET NULL,
      categoria_id INT REFERENCES categorias_vehiculos(id) ON DELETE SET NULL,
      fecha DATE NOT NULL,
      hora TIME NOT NULL,
      nombre_cliente TEXT NOT NULL,
      telefono_cliente TEXT NOT NULL,
      email_cliente TEXT NOT NULL,
      numero_vuelo TEXT,
      hora_llegada TIME,
      precio_estimado NUMERIC(10,2),
      notas TEXT,
      estado TEXT NOT NULL DEFAULT 'pendiente',
      stripe_payment_intent_id TEXT,
      creado_en TIMESTAMP DEFAULT NOW()
    );
  `);

  // Añadir numero_reserva si no existe (para BD ya creadas)
  await pool.query(`
    ALTER TABLE reservas ADD COLUMN IF NOT EXISTS numero_reserva TEXT UNIQUE;
  `);

  // Columnas nuevas para reservas (se añaden si no existen en BD ya creadas)
  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS conductor_id INT REFERENCES conductores(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS archivada BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS origen TEXT`);
  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS destino TEXT`);
  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS tipo_llegada TEXT`);
  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS numero_vuelo TEXT`);
  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS hora_llegada_vuelo TIME`);
  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS nombre_barco TEXT`);
  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS hora_atraque TIME`);
  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS num_pasajeros INT`);
  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS direccion_recogida TEXT`);
  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS direccion_destino TEXT`);
  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS notas_cliente TEXT`);
  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS pasaporte_dni TEXT`);

  // ─── Reservas × Extras ────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reservas_extras (
      id SERIAL PRIMARY KEY,
      reserva_id INT NOT NULL REFERENCES reservas(id) ON DELETE CASCADE,
      extra_id INT NOT NULL REFERENCES extras(id) ON DELETE RESTRICT,
      precio_en_reserva NUMERIC(10,2) NOT NULL
    );
  `);

  if (process.env.ADMIN_USUARIO && process.env.ADMIN_PASSWORD) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
    await pool.query(
      `INSERT INTO admins (usuario, password_hash) VALUES ($1, $2)
       ON CONFLICT (usuario) DO UPDATE SET password_hash = $2`,
      [process.env.ADMIN_USUARIO, hash]
    );
    console.log('Admin sincronizado: ' + process.env.ADMIN_USUARIO);
  }
}

// Resuelve la marca y el modelo de un conductor: por id si ya existen en el
// catálogo, o creándolos a partir de un nombre nuevo (el catálogo crece solo).
async function resolverVehiculo(marca_id, marca_nueva, modelo_id, modelo_nuevo) {
  let marcaId = parseInt(marca_id, 10) || null;
  let marcaNombre = null;

  if (!marcaId && marca_nueva && marca_nueva.trim()) {
    const nombre = marca_nueva.trim();
    const existente = await pool.query(
      'SELECT id, nombre FROM marcas_vehiculos WHERE LOWER(nombre) = LOWER($1)', [nombre]
    );
    if (existente.rows.length) {
      marcaId = existente.rows[0].id; marcaNombre = existente.rows[0].nombre;
    } else {
      const insertada = await pool.query(
        'INSERT INTO marcas_vehiculos (nombre) VALUES ($1) RETURNING id, nombre', [nombre]
      );
      marcaId = insertada.rows[0].id; marcaNombre = insertada.rows[0].nombre;
    }
  } else if (marcaId) {
    const fila = await pool.query('SELECT nombre FROM marcas_vehiculos WHERE id = $1', [marcaId]);
    marcaNombre = fila.rows.length ? fila.rows[0].nombre : null;
  }
  if (!marcaId || !marcaNombre) return null;

  let modeloNombre = null;
  const modeloId = parseInt(modelo_id, 10) || null;
  if (modeloId) {
    const fila = await pool.query(
      'SELECT nombre FROM modelos_vehiculos WHERE id = $1 AND marca_id = $2', [modeloId, marcaId]
    );
    modeloNombre = fila.rows.length ? fila.rows[0].nombre : null;
  } else if (modelo_nuevo && modelo_nuevo.trim()) {
    const nombre = modelo_nuevo.trim();
    const existente = await pool.query(
      'SELECT nombre FROM modelos_vehiculos WHERE marca_id = $1 AND LOWER(nombre) = LOWER($2)',
      [marcaId, nombre]
    );
    if (existente.rows.length) modeloNombre = existente.rows[0].nombre;
    else {
      await pool.query('INSERT INTO modelos_vehiculos (marca_id, nombre) VALUES ($1, $2)', [marcaId, nombre]);
      modeloNombre = nombre;
    }
  }
  if (!modeloNombre) return null;
  return { marcaNombre, modeloNombre };
}

// ─── Rutas de autenticación ───────────────────────────────────────────────────
app.post('/admin/login', asyncHandler(async (req, res) => {
  const { usuario, password } = req.body;
  if (!usuario || !password) {
    return res.status(400).json({ error: 'Faltan datos' });
  }
  const result = await pool.query('SELECT * FROM admins WHERE usuario = $1', [usuario]);
  if (result.rows.length === 0) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }
  const admin = result.rows[0];
  const ok = await bcrypt.compare(password, admin.password_hash);
  if (!ok) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }
  req.session.adminId = admin.id;
  res.json({ ok: true });
}));

app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get('/admin/sesion', (req, res) => {
  res.json({ autenticado: !!(req.session && req.session.adminId) });
});

// ─── API pública ──────────────────────────────────────────────────────────────
app.get('/api/categorias', asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT id, nombre, capacidad_pasajeros, capacidad_maletas, descripcion, limite_sillas, foto FROM categorias_vehiculos WHERE disponible = TRUE ORDER BY orden, nombre'
  );
  res.json(result.rows);
}));

app.get('/api/rutas', asyncHandler(async (req, res) => {
  // Solo rutas activas que tienen al menos un precio cargado
  const result = await pool.query(`
    SELECT r.id, r.origen, r.destino,
           array_agg(rp.categoria_id) AS categorias_con_precio
    FROM rutas r
    JOIN rutas_precios rp ON rp.ruta_id = r.id
    WHERE r.activa = TRUE
    GROUP BY r.id, r.origen, r.destino
    ORDER BY r.origen, r.destino
  `);
  res.json(result.rows);
}));

app.get('/api/precio', asyncHandler(async (req, res) => {
  const { ruta_id, categoria_id } = req.query;
  if (!ruta_id || !categoria_id) {
    return res.status(400).json({ error: 'Faltan parametros' });
  }
  const result = await pool.query(
    'SELECT precio FROM rutas_precios WHERE ruta_id = $1 AND categoria_id = $2',
    [ruta_id, categoria_id]
  );
  if (result.rows.length === 0) {
    return res.json({ a_consultar: true });
  }
  res.json({ precio: Number(result.rows[0].precio), a_consultar: false });
}));

app.get('/api/extras-publicos', asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT id, nombre, precio FROM extras WHERE activo = TRUE ORDER BY id'
  );
  res.json(result.rows);
}));

app.post('/api/reservas', asyncHandler(async (req, res) => {
  const {
    numero_reserva_cliente,
    origen, destino, categoria_id, precio_estimado,
    fecha, hora, tipo_llegada, numero_vuelo, hora_llegada_vuelo,
    nombre_barco, hora_atraque,
    num_pasajeros, notas,
    nombre_cliente, telefono_cliente, email_cliente,
    extras
  } = req.body;

  if (!origen || !destino || !categoria_id || !fecha || !nombre_cliente || !telefono_cliente || !email_cliente) {
    return res.status(400).json({ error: 'Faltan datos obligatorios.' });
  }

  // Generar número de reserva tipo PNR: TGC-XXX999
  function generarPNR() {
    const letras = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const nums = '0123456789';
    const l = () => letras[Math.floor(Math.random() * letras.length)];
    const n = () => nums[Math.floor(Math.random() * nums.length)];
    return l() + l() + l() + n() + n() + n();
  }

  // Usar PNR del cliente si viene, si no generar uno nuevo
  let numeroReserva = null;
  if (numero_reserva_cliente && /^[A-Z]{3}[0-9]{3}$/.test(numero_reserva_cliente)) {
    const existe = await pool.query('SELECT 1 FROM reservas WHERE numero_reserva = $1', [numero_reserva_cliente]);
    if (existe.rows.length === 0) {
      numeroReserva = numero_reserva_cliente;
    }
  }
  if (!numeroReserva) {
    let intentos = 0;
    do {
      numeroReserva = generarPNR();
      const existe = await pool.query('SELECT 1 FROM reservas WHERE numero_reserva = $1', [numeroReserva]);
      if (existe.rows.length === 0) break;
      intentos++;
    } while (intentos < 10);
  }

  const horaGuardar = hora || '00:00';

  // Mantener notas completas como respaldo legible
  const notasCompletas = [
    'Origen: ' + origen + ' → Destino: ' + destino,
    tipo_llegada === 'aeropuerto' && numero_vuelo ? 'Vuelo: ' + numero_vuelo : null,
    tipo_llegada === 'aeropuerto' && hora_llegada_vuelo ? 'Hora llegada vuelo: ' + hora_llegada_vuelo : null,
    tipo_llegada === 'puerto' && nombre_barco ? 'Barco: ' + nombre_barco : null,
    tipo_llegada === 'puerto' && hora_atraque ? 'Hora atraque: ' + hora_atraque : null,
    num_pasajeros ? 'Pasajeros: ' + num_pasajeros : null,
    notas || null
  ].filter(Boolean).join(' | ');

  const reserva = await pool.query(
    `INSERT INTO reservas (
      numero_reserva, ruta_id, categoria_id, fecha, hora,
      nombre_cliente, telefono_cliente, email_cliente,
      precio_estimado, notas, estado,
      origen, destino, tipo_llegada,
      numero_vuelo, hora_llegada_vuelo,
      nombre_barco, hora_atraque,
      num_pasajeros, notas_cliente
    )
     VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, 'pendiente',
             $10, $11, $12, $13, $14, $15, $16, $17, $18)
     RETURNING id`,
    [
      numeroReserva, categoria_id, fecha, horaGuardar,
      nombre_cliente.trim(), telefono_cliente.trim(), email_cliente.trim(),
      precio_estimado || null, notasCompletas || null,
      origen || null, destino || null, tipo_llegada || null,
      numero_vuelo || null, hora_llegada_vuelo || null,
      nombre_barco || null, hora_atraque || null,
      num_pasajeros || null, notas || null
    ]
  );

  const reservaId = reserva.rows[0].id;

  // Guardar extras seleccionados
  if (Array.isArray(extras) && extras.length > 0) {
    for (const extra of extras) {
      await pool.query(
        'INSERT INTO reservas_extras (reserva_id, extra_id, precio_en_reserva) VALUES ($1, $2, $3)',
        [reservaId, extra.id, extra.precio]
      );
    }
  }

  res.json({ ok: true, reserva_id: reservaId, numero_reserva: numeroReserva });
}));

app.get('/reserva', (req, res) => {
  res.sendFile('reserva.html', { root: path.join(__dirname, 'public') });
});

app.get('/fondo-activo', asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT imagen, tipo_mime FROM fondos_portada WHERE activo = TRUE LIMIT 1'
  );
  if (result.rows.length === 0) {
    return res.status(404).end();
  }
  res.set('Content-Type', result.rows[0].tipo_mime);
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(result.rows[0].imagen);
}));

// ─── Admin: fondos de portada ─────────────────────────────────────────────────
app.get('/admin/fondos', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT id, nombre, tipo_mime, activo FROM fondos_portada ORDER BY id'
  );
  res.json(result.rows);
}));

app.get('/admin/fondos/:id/imagen', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT imagen, tipo_mime FROM fondos_portada WHERE id = $1',
    [req.params.id]
  );
  if (result.rows.length === 0) {
    return res.status(404).end();
  }
  res.set('Content-Type', result.rows[0].tipo_mime);
  res.send(result.rows[0].imagen);
}));

app.post('/admin/fondos', requireAdmin, upload.single('imagen'), asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Falta la imagen' });
  }
  const tiposPermitidos = ['image/jpeg', 'image/jpg', 'image/webp', 'image/png'];
  if (!tiposPermitidos.includes(req.file.mimetype)) {
    return res.status(400).json({ error: 'Formato no permitido. Usa jpg, png o webp' });
  }
  const totalFondos = await pool.query('SELECT COUNT(*)::int AS total FROM fondos_portada');
  if (totalFondos.rows[0].total >= 5) {
    return res.status(400).json({ error: 'Ya hay 5 fondos guardados. Elimina uno antes de subir otro' });
  }
  const nombre = req.body.nombre || 'Fondo sin nombre';
  const result = await pool.query(
    'INSERT INTO fondos_portada (nombre, imagen, tipo_mime) VALUES ($1, $2, $3) RETURNING id',
    [nombre, req.file.buffer, req.file.mimetype]
  );
  res.json({ ok: true, id: result.rows[0].id });
}));

app.post('/admin/fondos/:id/activar', requireAdmin, asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE fondos_portada SET activo = FALSE');
    await client.query('UPDATE fondos_portada SET activo = TRUE WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('No se pudo activar el fondo:', err.message);
    res.status(500).json({ error: 'No se pudo activar el fondo' });
  } finally {
    client.release();
  }
}));

app.delete('/admin/fondos/:id', requireAdmin, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM fondos_portada WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ─── Admin: categorías de vehículo ───────────────────────────────────────────
app.get('/admin/categorias', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT id, nombre, capacidad_pasajeros, capacidad_maletas, limite_sillas, descripcion,
            activa, disponible, bajada_diurna, bajada_nocturna, orden,
            (foto IS NOT NULL) AS tiene_foto
     FROM categorias_vehiculos ORDER BY orden, nombre`
  );
  res.json(result.rows);
}));

app.post('/admin/categorias', requireAdmin, asyncHandler(async (req, res) => {
  const d = req.body;
  const nombre = (d.nombre || '').trim();
  if (!nombre) {
    return res.status(400).json({ error: 'La categoría necesita un nombre.' });
  }
  try {
    await pool.query(
      `INSERT INTO categorias_vehiculos
         (nombre, capacidad_pasajeros, capacidad_maletas, limite_sillas, descripcion,
          bajada_diurna, bajada_nocturna, activa, disponible)
       VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, FALSE)`,
      [nombre, parseInt(d.capacidad_pasajeros, 10) || 4, (d.capacidad_maletas || '').trim() || '—',
       parseInt(d.limite_sillas, 10) || 0, (d.descripcion || '').trim(),
       parseFloat(d.bajada_diurna) || 0, parseFloat(d.bajada_nocturna) || 0]
    );
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Ya existe una categoría con ese nombre.' });
    throw err;
  }
}));

app.post('/admin/categorias/:id/editar', requireAdmin, asyncHandler(async (req, res) => {
  const d = req.body;
  const nombre = (d.nombre || '').trim();
  if (!nombre) {
    return res.status(400).json({ error: 'La categoría necesita un nombre.' });
  }
  try {
    await pool.query(
      `UPDATE categorias_vehiculos
       SET nombre = $1, capacidad_pasajeros = $2, capacidad_maletas = $3, limite_sillas = $4, descripcion = $5,
           bajada_diurna = $6, bajada_nocturna = $7
       WHERE id = $8`,
      [nombre, parseInt(d.capacidad_pasajeros, 10) || 4, (d.capacidad_maletas || '').trim() || '—',
       parseInt(d.limite_sillas, 10) || 0, (d.descripcion || '').trim(),
       parseFloat(d.bajada_diurna) || 0, parseFloat(d.bajada_nocturna) || 0, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Ya existe una categoría con ese nombre.' });
    throw err;
  }
}));

app.post('/admin/categorias/:id/eliminar', requireAdmin, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM categorias_vehiculos WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

app.post('/admin/categorias/:id/foto', requireAdmin, asyncHandler(async (req, res) => {
  const { foto } = req.body;
  if (!foto || !foto.startsWith('data:image/') || foto.length > 700000) {
    return res.status(400).json({ error: 'La imagen no es válida o pesa demasiado.' });
  }
  await pool.query('UPDATE categorias_vehiculos SET foto = $1 WHERE id = $2', [foto, req.params.id]);
  res.json({ ok: true });
}));

app.post('/admin/categorias/:id/activa', requireAdmin, asyncHandler(async (req, res) => {
  await pool.query('UPDATE categorias_vehiculos SET activa = $1 WHERE id = $2', [!!req.body.activa, req.params.id]);
  res.json({ ok: true });
}));

app.post('/admin/categorias/:id/disponible', requireAdmin, asyncHandler(async (req, res) => {
  await pool.query('UPDATE categorias_vehiculos SET disponible = $1 WHERE id = $2', [!!req.body.disponible, req.params.id]);
  res.json({ ok: true });
}));

app.get('/admin/catalogo-vehiculos', requireAdmin, asyncHandler(async (req, res) => {
  const categorias = await pool.query(
    `SELECT id, nombre FROM categorias_vehiculos WHERE activa = TRUE ORDER BY orden, nombre`
  );
  const marcas = await pool.query(`SELECT id, nombre FROM marcas_vehiculos ORDER BY nombre`);
  const modelos = await pool.query(`SELECT id, marca_id, nombre FROM modelos_vehiculos ORDER BY nombre`);
  res.json({
    categorias: categorias.rows,
    marcas: marcas.rows.map(function (m) {
      return { id: m.id, nombre: m.nombre, modelos: modelos.rows.filter(function (mo) { return mo.marca_id === m.id; }) };
    })
  });
}));

// ─── Admin: conductores ───────────────────────────────────────────────────────
app.get('/admin/conductores', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT c.id, c.nombre, c.email, c.telefono, c.vehiculo_marca, c.vehiculo_modelo, c.matricula,
            c.numero_taxi, c.plazas, c.isla, c.tipo, c.estado, c.foto_estado, c.permite_contacto, c.creado_en,
            cat.nombre AS categoria
     FROM conductores c
     LEFT JOIN categorias_vehiculos cat ON cat.id = c.categoria_id
     ORDER BY c.creado_en DESC`
  );
  res.json(result.rows);
}));

app.post('/admin/conductores', requireAdmin, asyncHandler(async (req, res) => {
  const d = req.body;
  if (!d.nombre || !d.email || !d.telefono || !d.password || d.password.length < 6) {
    return res.status(400).json({ error: 'Nombre, email, teléfono y contraseña (mínimo 6 caracteres) son obligatorios.' });
  }
  if (!d.documento || !d.direccion || !d.cp || !d.municipio) {
    return res.status(400).json({ error: 'Faltan datos personales: documento, dirección, CP y municipio.' });
  }
  if (!d.municipio_licencia || !d.numero_licencia) {
    return res.status(400).json({ error: 'Faltan los datos de la licencia.' });
  }
  const categoriaId = parseInt(d.categoria_id, 10);
  const categoria = await pool.query('SELECT id FROM categorias_vehiculos WHERE id = $1 AND activa = TRUE', [categoriaId]);
  if (categoria.rows.length === 0) {
    return res.status(400).json({ error: 'Elige una categoría de vehículo válida.' });
  }
  const vehiculo = await resolverVehiculo(d.marca_id, d.marca_nueva, d.modelo_id, d.modelo_nuevo);
  if (!vehiculo) {
    return res.status(400).json({ error: 'Indica la marca y el modelo del vehículo.' });
  }
  if (!d.matricula) {
    return res.status(400).json({ error: 'Falta la matrícula.' });
  }
  const hash = await bcrypt.hash(d.password, 10);
  const foto = d.foto || null;
  const fotoEstado = foto ? 'aprobada' : 'sin_foto';
  try {
    const result = await pool.query(
      `INSERT INTO conductores
        (nombre, email, telefono, password_hash, documento, direccion, cp, municipio,
         municipio_licencia, numero_licencia, central_flota,
         categoria_id, vehiculo_marca, vehiculo_modelo, matricula, numero_taxi, plazas, isla,
         foto, foto_estado, estado)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'aprobado')
       RETURNING id`,
      [
        d.nombre.trim(), d.email.toLowerCase().trim(), d.telefono.trim(), hash,
        d.documento.trim().toUpperCase(), d.direccion.trim(), d.cp.trim(), d.municipio.trim(),
        d.municipio_licencia.trim(), d.numero_licencia.trim(), (d.central_flota || '').trim(),
        categoriaId, vehiculo.marcaNombre, vehiculo.modeloNombre,
        d.matricula.trim().toUpperCase(), (d.numero_taxi || '').trim(), parseInt(d.plazas, 10) || 4,
        d.isla || 'Gran Canaria', foto, fotoEstado
      ]
    );
    res.json({ ok: true, id: result.rows[0].id });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Ese email ya está registrado.' });
    throw err;
  }
}));

app.post('/admin/conductores/:id/estado', requireAdmin, asyncHandler(async (req, res) => {
  const estado = req.body.estado;
  if (!['pendiente', 'aprobado', 'suspendido'].includes(estado)) {
    return res.status(400).json({ error: 'Estado no válido.' });
  }
  await pool.query('UPDATE conductores SET estado = $1 WHERE id = $2', [estado, req.params.id]);
  res.json({ ok: true });
}));

app.post('/admin/conductores/:id/tipo', requireAdmin, asyncHandler(async (req, res) => {
  const tipo = req.body.tipo;
  if (!['flota', 'externo'].includes(tipo)) {
    return res.status(400).json({ error: 'Tipo no válido.' });
  }
  await pool.query('UPDATE conductores SET tipo = $1 WHERE id = $2', [tipo, req.params.id]);
  res.json({ ok: true });
}));

app.post('/admin/conductores/:id/eliminar', requireAdmin, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM conductores WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

app.get('/admin/conductores/:id/ficha', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT c.id, c.nombre, c.email, c.telefono, c.documento, c.direccion, c.cp, c.municipio,
            c.municipio_licencia, c.numero_licencia, c.central_flota,
            c.vehiculo_marca, c.vehiculo_modelo, c.matricula, c.numero_taxi, c.plazas, c.isla,
            c.tipo, c.estado, c.foto, c.foto_estado, c.foto_motivo, c.creado_en,
            cat.nombre AS categoria
     FROM conductores c
     LEFT JOIN categorias_vehiculos cat ON cat.id = c.categoria_id
     WHERE c.id = $1`,
    [req.params.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Conductor no encontrado.' });
  res.json(result.rows[0]);
}));

app.post('/admin/conductores/:id/editar', requireAdmin, asyncHandler(async (req, res) => {
  const camposPermitidos = ['nombre', 'telefono', 'email', 'documento', 'direccion', 'cp', 'municipio',
    'municipio_licencia', 'numero_licencia', 'central_flota',
    'vehiculo_marca', 'vehiculo_modelo', 'matricula', 'numero_taxi', 'plazas', 'isla'];
  const cambios = [];
  const valores = [];
  for (const campo of camposPermitidos) {
    if (req.body[campo] !== undefined) {
      let valor = String(req.body[campo]).trim();
      if (campo === 'email') valor = valor.toLowerCase();
      if (campo === 'matricula' || campo === 'documento') valor = valor.toUpperCase();
      if (campo === 'plazas') valor = parseInt(valor, 10) || 4;
      if ((campo === 'nombre' || campo === 'email') && !valor) {
        return res.status(400).json({ error: 'El nombre y el email no pueden quedar vacíos.' });
      }
      valores.push(valor);
      cambios.push(`${campo} = $${valores.length}`);
    }
  }
  if (!cambios.length) return res.status(400).json({ error: 'No hay cambios que guardar.' });
  valores.push(req.params.id);
  try {
    await pool.query(`UPDATE conductores SET ${cambios.join(', ')} WHERE id = $${valores.length}`, valores);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Ese email ya lo usa otro conductor.' });
    throw err;
  }
}));

app.post('/admin/conductores/:id/foto', requireAdmin, asyncHandler(async (req, res) => {
  const { accion, motivo } = req.body;
  if (accion === 'aprobar') {
    await pool.query(`UPDATE conductores SET foto_estado = 'aprobada', foto_motivo = NULL WHERE id = $1`, [req.params.id]);
  } else if (accion === 'rechazar') {
    await pool.query(
      `UPDATE conductores SET foto_estado = 'rechazada', foto_motivo = $1 WHERE id = $2`,
      [(motivo || 'La foto no cumple los requisitos.').slice(0, 200), req.params.id]
    );
  } else {
    return res.status(400).json({ error: 'Acción no válida.' });
  }
  res.json({ ok: true });
}));

app.post('/admin/conductores/:id/nombre', requireAdmin, asyncHandler(async (req, res) => {
  const nombre = (req.body.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'El nombre no puede quedar vacío.' });
  await pool.query('UPDATE conductores SET nombre = $1 WHERE id = $2', [nombre, req.params.id]);
  res.json({ ok: true });
}));

app.post('/admin/conductores/:id/contacto', requireAdmin, asyncHandler(async (req, res) => {
  await pool.query('UPDATE conductores SET permite_contacto = $1 WHERE id = $2', [!!req.body.permite, req.params.id]);
  res.json({ ok: true });
}));

app.post('/admin/conductores-contacto-global', requireAdmin, asyncHandler(async (req, res) => {
  await pool.query('UPDATE conductores SET permite_contacto = $1', [!!req.body.permite]);
  res.json({ ok: true });
}));

// ─── Admin: rutas y precios ───────────────────────────────────────────────────
app.get('/admin/rutas', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT id, origen, destino, activa FROM rutas ORDER BY origen, destino');
  res.json(result.rows);
}));

// Al crear una ruta, se generan automáticamente las 8 fichas SEO (una por idioma)
app.post('/admin/rutas', requireAdmin, asyncHandler(async (req, res) => {
  const { origen, destino } = req.body;
  if (!origen || !destino) {
    return res.status(400).json({ error: 'Falta origen o destino' });
  }
  const result = await pool.query(
    'INSERT INTO rutas (origen, destino) VALUES ($1, $2) RETURNING id',
    [origen, destino]
  );
  const rutaId = result.rows[0].id;
  await crearFichasSEOSiFaltan(rutaId, origen, destino);
  res.json({ ok: true, id: rutaId });
}));

// Desactiva una ruta y todas sus fichas SEO de golpe
app.post('/admin/rutas/:id/desactivar', requireAdmin, asyncHandler(async (req, res) => {
  const id = req.params.id;
  await pool.query('UPDATE rutas SET activa = FALSE WHERE id = $1', [id]);
  await pool.query('UPDATE route_seo_settings SET activo = FALSE WHERE route_id = $1', [id]);
  res.json({ ok: true });
}));

// Reactiva una ruta (las fichas SEO quedan desactivadas; el admin las activa manualmente desde SEO)
app.post('/admin/rutas/:id/activar', requireAdmin, asyncHandler(async (req, res) => {
  await pool.query('UPDATE rutas SET activa = TRUE WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// Elimina una ruta, sus precios, sus fichas SEO,
// y registra una redirección 301 automática por cada slug que tenía
app.post('/admin/rutas/:id/eliminar', requireAdmin, asyncHandler(async (req, res) => {
  const id = req.params.id;

  // Recuperar todos los slugs activos antes de borrar nada
  const fichas = await pool.query(
    'SELECT lang_code, slug_url FROM route_seo_settings WHERE route_id = $1',
    [id]
  );

  // Crear redirecciones 301 por cada slug → home
  for (const ficha of fichas.rows) {
    if (!ficha.slug_url) continue;
    const seccion = SECCIONES_TRASLADO[ficha.lang_code];
    if (!seccion) continue;
    const rutaAntigua = '/' + ficha.lang_code + '/' + seccion + '/' + ficha.slug_url;
    await pool.query(
      `INSERT INTO redirecciones_301 (ruta_antigua, ruta_nueva)
       VALUES ($1, '/')
       ON CONFLICT (ruta_antigua) DO UPDATE SET ruta_nueva = '/'`,
      [rutaAntigua]
    );
  }

  // Borrar fichas SEO, precios y la ruta
  await pool.query('DELETE FROM route_seo_settings WHERE route_id = $1', [id]);
  await pool.query('DELETE FROM rutas_precios WHERE ruta_id = $1', [id]);
  await pool.query('DELETE FROM rutas WHERE id = $1', [id]);

  res.json({ ok: true });
}));

app.get('/admin/precios-grid', requireAdmin, asyncHandler(async (req, res) => {
  const rutas = await pool.query('SELECT id, origen, destino FROM rutas WHERE activa = TRUE ORDER BY origen, destino');
  const categorias = await pool.query('SELECT id, nombre FROM categorias_vehiculos WHERE activa = TRUE ORDER BY orden, nombre');
  const precios = await pool.query('SELECT ruta_id, categoria_id, precio FROM rutas_precios');
  res.json({
    rutas: rutas.rows,
    categorias: categorias.rows,
    precios: precios.rows.map(function (p) {
      return { ruta_id: p.ruta_id, categoria_id: p.categoria_id, precio: Number(p.precio) };
    })
  });
}));

app.post('/admin/precios-grid', requireAdmin, asyncHandler(async (req, res) => {
  const cambios = req.body.cambios;
  if (!Array.isArray(cambios)) {
    return res.status(400).json({ error: 'Formato incorrecto' });
  }
  for (const c of cambios) {
    await pool.query(
      `INSERT INTO rutas_precios (ruta_id, categoria_id, precio)
       VALUES ($1, $2, $3)
       ON CONFLICT (ruta_id, categoria_id) DO UPDATE SET precio = $3`,
      [c.ruta_id, c.categoria_id, c.precio]
    );
  }
  res.json({ ok: true });
}));

// ─── Admin: SEO ───────────────────────────────────────────────────────────────

// Lista todas las rutas con el estado SEO de cada idioma.
// Si alguna ruta todavía no tiene fichas SEO, las crea automáticamente.
app.get('/admin/seo/rutas', requireAdmin, asyncHandler(async (req, res) => {
  const rutas = await pool.query('SELECT id, origen, destino FROM rutas ORDER BY origen, destino');

  for (const ruta of rutas.rows) {
    await crearFichasSEOSiFaltan(ruta.id, ruta.origen, ruta.destino);
  }

  const seoData = await pool.query(
    `SELECT route_id, lang_code, slug_url, meta_title, activo
     FROM route_seo_settings ORDER BY route_id, lang_code`
  );

  const seoMap = {};
  for (const row of seoData.rows) {
    if (!seoMap[row.route_id]) seoMap[row.route_id] = {};
    seoMap[row.route_id][row.lang_code] = {
      slug: row.slug_url,
      titulo: row.meta_title,
      activo: row.activo
    };
  }

  res.json({ rutas: rutas.rows, seo: seoMap, idiomas: IDIOMAS_PERMITIDOS });
}));

// Devuelve los datos SEO completos de una ruta en un idioma concreto
app.get('/admin/seo/rutas/:id/idioma/:lang', requireAdmin, asyncHandler(async (req, res) => {
  if (!IDIOMAS_PERMITIDOS.includes(req.params.lang)) {
    return res.status(400).json({ error: 'Idioma no válido' });
  }
  const result = await pool.query(
    `SELECT * FROM route_seo_settings WHERE route_id = $1 AND lang_code = $2`,
    [req.params.id, req.params.lang]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'No encontrado' });
  res.json(result.rows[0]);
}));

// Devuelve los 9 idiomas de una ruta de golpe, cada uno con su medición de
// píxeles ya calculada — así el admin puede pintar en rojo las pestañas de
// los idiomas pasados de límite sin tener que entrar uno a uno.
app.get('/admin/seo/rutas/:id/completo', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM route_seo_settings WHERE route_id = $1`,
    [req.params.id]
  );
  const porIdioma = {};
  for (const fila of result.rows) {
    const pxTitulo = medirPxTitulo(fila.meta_title);
    const pxDesc = medirPxDescripcion(fila.meta_description);
    porIdioma[fila.lang_code] = {
      ...fila,
      px_titulo: pxTitulo,
      px_descripcion: pxDesc,
      excede: pxTitulo > 600 || pxDesc > 960
    };
  }

  const ruta = await pool.query(
    'SELECT sitemap_prioridad, sitemap_frecuencia, (imagen_og IS NOT NULL) AS tiene_imagen FROM rutas WHERE id = $1',
    [req.params.id]
  );

  res.json({
    idiomas: porIdioma,
    ruta: ruta.rows[0] || { sitemap_prioridad: 0.8, sitemap_frecuencia: 'monthly', tiene_imagen: false }
  });
}));

// Guarda la imagen propia de una ruta (vale para sus 9 idiomas) — se usa
// como og:image al compartir el link por WhatsApp/redes en vez de la genérica
app.post('/admin/rutas/:id/imagen-og', requireAdmin, asyncHandler(async (req, res) => {
  const { imagen } = req.body;
  if (!imagen || !imagen.startsWith('data:image/') || imagen.length > 900000) {
    return res.status(400).json({ error: 'La imagen no es válida o pesa demasiado (máx. ~650KB).' });
  }
  await pool.query('UPDATE rutas SET imagen_og = $1 WHERE id = $2', [imagen, req.params.id]);
  res.json({ ok: true });
}));

app.post('/admin/rutas/:id/imagen-og/eliminar', requireAdmin, asyncHandler(async (req, res) => {
  await pool.query('UPDATE rutas SET imagen_og = NULL WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// Sirve la imagen de una ruta públicamente (la necesitan los crawlers de
// WhatsApp/Facebook al generar la vista previa del enlace compartido)
app.get('/ruta-imagen/:id', asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT imagen_og FROM rutas WHERE id = $1', [req.params.id]);
  if (!result.rows.length || !result.rows[0].imagen_og) {
    return res.status(404).end();
  }
  const dataUrl = result.rows[0].imagen_og;
  const match = dataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!match) return res.status(404).end();
  res.set('Content-Type', match[1]);
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(Buffer.from(match[2], 'base64'));
}));

// Guarda la prioridad/frecuencia de sitemap de una ruta (vale para sus 9 idiomas)
app.post('/admin/rutas/:id/sitemap-config', requireAdmin, asyncHandler(async (req, res) => {
  const prioridad = parseFloat(req.body.prioridad);
  const frecuencia = req.body.frecuencia;
  const frecuenciasValidas = ['daily', 'weekly', 'monthly', 'yearly'];
  if (![1.0, 0.8, 0.5].includes(prioridad) || !frecuenciasValidas.includes(frecuencia)) {
    return res.status(400).json({ error: 'Valores no válidos.' });
  }
  await pool.query(
    'UPDATE rutas SET sitemap_prioridad = $1, sitemap_frecuencia = $2 WHERE id = $3',
    [prioridad, frecuencia, req.params.id]
  );
  res.json({ ok: true });
}));

// Guarda los datos SEO de una ruta en un idioma concreto
app.post('/admin/seo/rutas/:id/idioma/:lang', requireAdmin, asyncHandler(async (req, res) => {
  if (!IDIOMAS_PERMITIDOS.includes(req.params.lang)) {
    return res.status(400).json({ error: 'Idioma no válido' });
  }
  const { slug_url, meta_title, meta_description, og_title, og_description, robots_status } = req.body;
  const slugLimpio = slug_url ? slugify(slug_url) : null;
  const canonical = BASE_URL + '/' + req.params.lang + '/' + SECCIONES_TRASLADO[req.params.lang] + '/' + (slugLimpio || '');
  await pool.query(
    `UPDATE route_seo_settings
     SET slug_url = $1, meta_title = $2, meta_description = $3,
         og_title = $4, og_description = $5, robots_status = $6,
         canonical_url = $7, updated_at = NOW()
     WHERE route_id = $8 AND lang_code = $9`,
    [
      slugLimpio || null,
      meta_title || null,
      meta_description || null,
      og_title || meta_title || null,
      og_description || meta_description || null,
      robots_status || 'index,follow',
      canonical,
      req.params.id,
      req.params.lang
    ]
  );
  res.json({ ok: true });
}));

// Activa o desactiva la página pública de una ruta en un idioma concreto
app.post('/admin/seo/rutas/:id/idioma/:lang/activar', requireAdmin, asyncHandler(async (req, res) => {
  if (!IDIOMAS_PERMITIDOS.includes(req.params.lang)) {
    return res.status(400).json({ error: 'Idioma no válido' });
  }
  await pool.query(
    `UPDATE route_seo_settings SET activo = $1 WHERE route_id = $2 AND lang_code = $3`,
    [!!req.body.activo, req.params.id, req.params.lang]
  );
  res.json({ ok: true });
}));

// Activa o desactiva TODAS las páginas de un idioma de golpe — para cuando
// terminas de traducir un idioma entero y quieres publicarlo todo de una vez,
// en vez de ir ruta por ruta. Solo afecta a ese idioma, no a los demás.
app.post('/admin/seo/idioma/:lang/activar-todas', requireAdmin, asyncHandler(async (req, res) => {
  if (!IDIOMAS_PERMITIDOS.includes(req.params.lang)) {
    return res.status(400).json({ error: 'Idioma no válido' });
  }
  const result = await pool.query(
    `UPDATE route_seo_settings SET activo = $1 WHERE lang_code = $2`,
    [!!req.body.activo, req.params.lang]
  );
  res.json({ ok: true, afectadas: result.rowCount });
}));

// Traduce con IA (Claude) el título y la descripción que falten en las 21
// rutas para un idioma — no guarda nada todavía, devuelve propuestas para revisar
app.post('/admin/seo/traducir-ia/:lang', requireAdmin, asyncHandler(async (req, res) => {
  const lang = req.params.lang;
  if (!IDIOMAS_TRADUCIBLES.includes(lang)) {
    return res.status(400).json({ error: 'Idioma no válido' });
  }

  const result = await pool.query(
    `SELECT rss.route_id, rss.meta_title, rss.meta_description, r.origen, r.destino
     FROM route_seo_settings rss
     JOIN rutas r ON r.id = rss.route_id
     WHERE rss.lang_code = $1
     ORDER BY rss.route_id`,
    [lang]
  );

  const pendientes = result.rows.filter(function (r) { return !r.meta_title || !r.meta_description; });
  if (pendientes.length === 0) {
    return res.json({ ok: true, propuestas: [] });
  }

  // Necesitamos el texto en español de cada ruta como referencia para traducir
  const esResult = await pool.query(
    `SELECT route_id, meta_title, meta_description FROM route_seo_settings WHERE lang_code = $1`,
    [IDIOMA_BASE]
  );
  const esPorRuta = {};
  for (const fila of esResult.rows) esPorRuta[fila.route_id] = fila;

  const items = pendientes
    .map(function (r) {
      const base = esPorRuta[r.route_id] || {};
      return {
        route_id: r.route_id, origen: r.origen, destino: r.destino,
        titulo_es: base.meta_title || '', descripcion_es: base.meta_description || ''
      };
    })
    .filter(function (i) { return i.titulo_es && i.descripcion_es; }); // sin base en español no hay nada que traducir

  if (items.length === 0) {
    return res.json({ ok: true, propuestas: [] });
  }

  let traduccionesIA;
  try {
    traduccionesIA = await traducirSEOConClaudeIA(items, NOMBRE_IDIOMA_ES[lang] || lang);
  } catch (err) {
    console.error('Error traduciendo SEO con IA:', err.message);
    return res.status(500).json({ error: err.message });
  }

  const propuestas = items.map(function (i) {
    const t = traduccionesIA[i.route_id] || traduccionesIA[String(i.route_id)] || {};
    return {
      route_id: i.route_id, origen: i.origen, destino: i.destino,
      titulo_es: i.titulo_es, descripcion_es: i.descripcion_es,
      titulo_sugerido: t.meta_title || '', descripcion_sugerida: t.meta_description || ''
    };
  });

  res.json({ ok: true, propuestas });
}));

// Guarda en bloque las propuestas de título/descripción revisadas
app.post('/admin/seo/guardar-lote', requireAdmin, asyncHandler(async (req, res) => {
  const { lang, propuestas } = req.body;
  if (!IDIOMAS_TRADUCIBLES.includes(lang) || !Array.isArray(propuestas)) {
    return res.status(400).json({ error: 'Datos no válidos' });
  }
  let guardadas = 0;
  for (const p of propuestas) {
    if (!p.route_id) continue;
    await pool.query(
      `UPDATE route_seo_settings
       SET meta_title = $1, meta_description = $2, og_title = $1, og_description = $2, updated_at = NOW()
       WHERE route_id = $3 AND lang_code = $4`,
      [p.meta_title || '', p.meta_description || '', p.route_id, lang]
    );
    guardadas++;
  }
  res.json({ ok: true, guardadas });
}));

// Exporta todas las fichas SEO a un Excel listo para enviar a traductores
app.get('/admin/seo/exportar', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT r.id AS ruta_id, r.origen, r.destino,
            rss.lang_code, rss.slug_url, rss.meta_title, rss.meta_description,
            rss.og_title, rss.og_description, rss.robots_status, rss.activo
     FROM route_seo_settings rss
     JOIN rutas r ON r.id = rss.route_id
     ORDER BY r.origen, r.destino, rss.lang_code`
  );

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Traslados GC Admin';
  const sheet = workbook.addWorksheet('SEO Traducciones');

  sheet.columns = [
    { header: 'ruta_id',          key: 'ruta_id',          width: 8  },
    { header: 'origen',           key: 'origen',           width: 30 },
    { header: 'destino',          key: 'destino',          width: 30 },
    { header: 'lang_code',        key: 'lang_code',        width: 10 },
    { header: 'slug_url',         key: 'slug_url',         width: 45 },
    { header: 'meta_title',       key: 'meta_title',       width: 55 },
    { header: 'meta_description', key: 'meta_description', width: 90 },
    { header: 'og_title',         key: 'og_title',         width: 55 },
    { header: 'og_description',   key: 'og_description',   width: 90 },
    { header: 'robots_status',    key: 'robots_status',    width: 15 },
    { header: 'activo',           key: 'activo',           width: 8  }
  ];

  // Cabecera con estilo
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FF1C1815' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8D5B0' } };

  for (const row of result.rows) {
    const filaInsertada = sheet.addRow(row);

    const pxTitulo = medirPxTitulo(row.meta_title);
    const pxDesc = medirPxDescripcion(row.meta_description);

    if (pxTitulo > 600) {
      filaInsertada.getCell('meta_title').font = { bold: true, color: { argb: 'FFD32F2F' } };
    }
    if (pxDesc > 960) {
      filaInsertada.getCell('meta_description').font = { bold: true, color: { argb: 'FFD32F2F' } };
    }
  }

  // Congelar la fila de cabecera para facilitar el desplazamiento
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="seo-traslados-gc.xlsx"');
  await workbook.xlsx.write(res);
  res.end();
}));

// Importa un Excel traducido y actualiza la base de datos
app.post('/admin/seo/importar', requireAdmin, upload.single('archivo'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Falta el archivo Excel' });

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(req.file.buffer);
  const sheet = workbook.worksheets[0];

  const filas = [];
  sheet.eachRow(function (row, rowNumber) {
    if (rowNumber === 1) return; // cabecera
    filas.push({
      rutaId:          row.getCell(1).value,
      langCode:        String(row.getCell(4).value  || '').trim(),
      slugUrl:         String(row.getCell(5).value  || '').trim(),
      metaTitle:       String(row.getCell(6).value  || '').trim(),
      metaDescription: String(row.getCell(7).value  || '').trim(),
      ogTitle:         String(row.getCell(8).value  || '').trim(),
      ogDescription:   String(row.getCell(9).value  || '').trim(),
      robotsStatus:    String(row.getCell(10).value || 'index,follow').trim()
    });
  });

  let actualizadas = 0;
  const errores = [];
  const avisosPixeles = [];

  // Mapa de rutas para que los avisos sean legibles (origen → destino)
  const rutasInfo = await pool.query('SELECT id, origen, destino FROM rutas');
  const nombreRuta = {};
  for (const r of rutasInfo.rows) {
    nombreRuta[r.id] = r.origen + ' → ' + r.destino;
  }

  for (const f of filas) {
    if (!f.rutaId || !IDIOMAS_PERMITIDOS.includes(f.langCode)) continue;
    try {
      const slugLimpio = slugify(f.slugUrl);
      const canonical = BASE_URL + '/' + f.langCode + '/' + SECCIONES_TRASLADO[f.langCode] + '/' + slugLimpio;
      await pool.query(
        `UPDATE route_seo_settings
         SET slug_url = $1, meta_title = $2, meta_description = $3,
             og_title = $4, og_description = $5, robots_status = $6,
             canonical_url = $7, updated_at = NOW()
         WHERE route_id = $8 AND lang_code = $9`,
        [
          slugLimpio || null, f.metaTitle || null, f.metaDescription || null,
          f.ogTitle || f.metaTitle || null, f.ogDescription || f.metaDescription || null,
          f.robotsStatus, canonical, f.rutaId, f.langCode
        ]
      );
      actualizadas++;

      // Comprobación de píxeles: el editor manual avisa en rojo si se pasa,
      // pero la importación por Excel no pasa por esa pantalla — así que
      // replicamos aquí la misma comprobación para no dejar huecos.
      const pxTitulo = medirPxTitulo(f.metaTitle);
      const pxDesc = medirPxDescripcion(f.metaDescription);
      const problemas = [];
      if (pxTitulo > 600) problemas.push('título ' + pxTitulo + 'px (límite 600px)');
      if (pxDesc > 960) problemas.push('descripción ' + pxDesc + 'px (límite 960px)');
      if (problemas.length) {
        avisosPixeles.push({
          ruta: nombreRuta[f.rutaId] || ('Ruta ' + f.rutaId),
          idioma: f.langCode,
          problemas: problemas.join(' y ')
        });
      }
    } catch (err) {
      errores.push('Ruta ' + f.rutaId + '/' + f.langCode + ': ' + err.message);
    }
  }

  res.json({ ok: true, actualizadas, errores, avisosPixeles });
}));

// ─── robots.txt y sitemap.xml ────────────────────────────────────────────────
// Por defecto se generan en el momento, a partir de lo que esté realmente
// activo en la base de datos. Desde el admin, German o su SEO pueden guardar
// una versión manual que sustituye a la automática mientras esté activada.

function generarRobotsAuto() {
  return [
    'User-agent: *',
    'Disallow: /admin.html',
    'Disallow: /admin/',
    '',
    'Sitemap: ' + BASE_URL + '/sitemap.xml'
  ].join('\n');
}

// Construye los dos bloques de datos estructurados (Schema.org) para una
// ruta concreta. Se usa tanto al renderizar la página pública como desde el
// admin, para que German pueda ver exactamente lo mismo que ve Google.
function construirSchemaRuta(seo, preciosRows, nombreMarca, globales, BASE_URL, urlActual) {
  let imagenSchema = null;
  if (seo.tiene_imagen) {
    imagenSchema = BASE_URL + '/ruta-imagen/' + seo.ruta_id;
  } else if (globales.imagen_og_defecto) {
    imagenSchema = BASE_URL + '/imagen-og-defecto';
  }

  const schemaTaxiService = {
    '@context': 'https://schema.org',
    '@type': 'TaxiService',
    name: seo.meta_title || (seo.origen + ' → ' + seo.destino),
    description: seo.meta_description || undefined,
    url: seo.canonical_url || undefined,
    image: imagenSchema || undefined,
    provider: { '@type': 'Organization', name: nombreMarca, url: BASE_URL },
    areaServed: { '@type': 'Place', name: 'Gran Canaria' }
  };
  if (preciosRows.length > 0) {
    schemaTaxiService.offers = preciosRows.map(function (p) {
      return {
        '@type': 'Offer',
        name: p.nombre,
        priceCurrency: 'EUR',
        price: Number(p.precio).toFixed(2),
        availability: 'https://schema.org/InStock'
      };
    });
  }

  const schemaBreadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Inicio', item: BASE_URL + '/' },
      { '@type': 'ListItem', position: 2, name: seo.origen + ' → ' + seo.destino, item: seo.canonical_url || urlActual }
    ]
  };

  return { schemaTaxiService, schemaBreadcrumb };
}

async function generarSitemapAuto() {
  const result = await pool.query(
    `SELECT rss.route_id, rss.lang_code, rss.slug_url, rss.updated_at,
            r.sitemap_prioridad, r.sitemap_frecuencia
     FROM route_seo_settings rss
     JOIN rutas r ON r.id = rss.route_id
     WHERE rss.activo = TRUE AND r.activa = TRUE
     ORDER BY rss.route_id, rss.lang_code`
  );

  const porRuta = {};
  for (const fila of result.rows) {
    if (!porRuta[fila.route_id]) porRuta[fila.route_id] = [];
    porRuta[fila.route_id].push(fila);
  }

  function escapeXml(s) {
    return String(s).replace(/[<>&'"]/g, function (c) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c];
    });
  }

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" ';
  xml += 'xmlns:xhtml="http://www.w3.org/1999/xhtml">\n';
  xml += '  <url>\n    <loc>' + escapeXml(BASE_URL) + '/</loc>\n';
  xml += '    <changefreq>weekly</changefreq>\n    <priority>1.0</priority>\n  </url>\n';

  for (const rutaId of Object.keys(porRuta)) {
    const versiones = porRuta[rutaId];
    const prioridad = versiones[0].sitemap_prioridad != null ? versiones[0].sitemap_prioridad : 0.8;
    const frecuencia = versiones[0].sitemap_frecuencia || 'monthly';
    for (const v of versiones) {
      const loc = BASE_URL + '/' + v.lang_code + '/' + SECCIONES_TRASLADO[v.lang_code] + '/' + v.slug_url;
      xml += '  <url>\n';
      xml += '    <loc>' + escapeXml(loc) + '</loc>\n';
      if (v.updated_at) {
        xml += '    <lastmod>' + new Date(v.updated_at).toISOString().slice(0, 10) + '</lastmod>\n';
      }
      xml += '    <changefreq>' + escapeXml(frecuencia) + '</changefreq>\n    <priority>' + prioridad + '</priority>\n';
      for (const hermana of versiones) {
        const locHermana = BASE_URL + '/' + hermana.lang_code + '/' + SECCIONES_TRASLADO[hermana.lang_code] + '/' + hermana.slug_url;
        xml += '    <xhtml:link rel="alternate" hreflang="' + hermana.lang_code + '" href="' + escapeXml(locHermana) + '" />\n';
      }
      xml += '  </url>\n';
    }
  }
  xml += '</urlset>';
  return xml;
}

app.get('/robots.txt', asyncHandler(async (req, res) => {
  const manual = await pool.query(
    `SELECT contenido FROM site_archivos_manual WHERE nombre = 'robots.txt' AND activo = TRUE`
  );
  res.set('Content-Type', 'text/plain');
  res.send(manual.rows.length ? manual.rows[0].contenido : generarRobotsAuto());
}));

app.get('/sitemap.xml', asyncHandler(async (req, res) => {
  const manual = await pool.query(
    `SELECT contenido FROM site_archivos_manual WHERE nombre = 'sitemap.xml' AND activo = TRUE`
  );
  if (manual.rows.length) {
    res.set('Content-Type', 'application/xml');
    return res.send(manual.rows[0].contenido);
  }
  res.set('Content-Type', 'application/xml');
  res.send(await generarSitemapAuto());
}));

// Admin: ver el estado de ambos archivos (si hay versión manual activa, y el
// contenido automático actual para poder partir de ahí al editar)
app.get('/admin/site-archivos', requireAdmin, asyncHandler(async (req, res) => {
  const manual = await pool.query(`SELECT nombre, contenido, activo FROM site_archivos_manual`);
  const manualMap = {};
  for (const fila of manual.rows) manualMap[fila.nombre] = fila;

  res.json({
    'robots.txt': {
      activo: !!(manualMap['robots.txt'] && manualMap['robots.txt'].activo),
      contenido_manual: manualMap['robots.txt'] ? manualMap['robots.txt'].contenido : '',
      contenido_automatico: generarRobotsAuto()
    },
    'sitemap.xml': {
      activo: !!(manualMap['sitemap.xml'] && manualMap['sitemap.xml'].activo),
      contenido_manual: manualMap['sitemap.xml'] ? manualMap['sitemap.xml'].contenido : '',
      contenido_automatico: await generarSitemapAuto()
    }
  });
}));

// Admin: guardar y activar una versión manual de uno de los dos archivos
app.post('/admin/site-archivos/:nombre/guardar', requireAdmin, asyncHandler(async (req, res) => {
  const nombre = req.params.nombre;
  if (nombre !== 'robots.txt' && nombre !== 'sitemap.xml') {
    return res.status(400).json({ error: 'Archivo no válido' });
  }
  await pool.query(
    `INSERT INTO site_archivos_manual (nombre, contenido, activo, updated_at)
     VALUES ($1, $2, TRUE, NOW())
     ON CONFLICT (nombre) DO UPDATE SET contenido = $2, activo = TRUE, updated_at = NOW()`,
    [nombre, req.body.contenido || '']
  );
  res.json({ ok: true });
}));

// Admin: volver al modo automático (desactiva la versión manual, no la borra)
app.post('/admin/site-archivos/:nombre/restablecer', requireAdmin, asyncHandler(async (req, res) => {
  const nombre = req.params.nombre;
  if (nombre !== 'robots.txt' && nombre !== 'sitemap.xml') {
    return res.status(400).json({ error: 'Archivo no válido' });
  }
  await pool.query(`UPDATE site_archivos_manual SET activo = FALSE WHERE nombre = $1`, [nombre]);
  res.json({ ok: true });
}));

// ─── Sistema de traducción de la interfaz de la web ──────────────────────────
const IDIOMAS_TRADUCIBLES_INICIAL = []; // se rellena de verdad en cargarIdiomasCache()
let IDIOMAS_TRADUCIBLES = IDIOMAS_TRADUCIBLES_INICIAL;

const NOMBRE_IDIOMA_ES = {
  en: 'inglés', de: 'alemán', sv: 'sueco', no: 'noruego',
  nl: 'holandés', it: 'italiano', fr: 'francés', fi: 'finés'
};

// Llama a la API de Claude (Anthropic) para traducir un lote de textos de
// golpe, usando el contexto de cada uno para que la traducción encaje con
// dónde aparece en la web. Devuelve un objeto { clave: traducción }.
async function traducirConClaudeIA(items, nombreIdioma) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('Falta configurar ANTHROPIC_API_KEY en las variables de entorno de Render.');
  }

  const prompt = 'Traduce los siguientes textos de una web de traslados privados en Gran Canaria, ' +
    'del español al ' + nombreIdioma + '. Cada texto incluye una clave única y un contexto que explica ' +
    'dónde aparece en la web — úsalo para elegir la traducción más natural (por ejemplo, un botón necesita ' +
    'un tono distinto a un párrafo explicativo). Mantén un tono profesional pero cercano, igual que el original.\n\n' +
    'Textos a traducir (JSON):\n' + JSON.stringify(items, null, 2) + '\n\n' +
    'Responde EXCLUSIVAMENTE con un objeto JSON válido, sin texto adicional antes ni después, ' +
    'sin bloques de markdown ni comillas triples, con esta forma exacta: ' +
    '{"clave1": "traducción1", "clave2": "traducción2"}';

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) {
    const cuerpoError = await response.text();
    throw new Error('Error de la API de Claude (' + response.status + '): ' + cuerpoError.slice(0, 200));
  }

  const data = await response.json();
  const textoRespuesta = data.content.map(function (b) { return b.text || ''; }).join('');
  const limpio = textoRespuesta.replace(/```json|```/g, '').trim();
  return JSON.parse(limpio);
}

// Igual que traducirConClaudeIA, pero pensada para título + descripción SEO
// de rutas (no para los textos fijos de interfaz). El slug nunca se toca
// aquí — eso lo decide German a propósito, no la IA.
async function traducirSEOConClaudeIA(items, nombreIdioma) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('Falta configurar ANTHROPIC_API_KEY en las variables de entorno de Render.');
  }

  const prompt = 'Traduce los siguientes títulos y descripciones SEO de una web de traslados privados en Gran Canaria, ' +
    'del español al ' + nombreIdioma + '. Cada uno incluye el origen y destino de la ruta y el texto actual en español.\n\n' +
    'Reglas importantes:\n' +
    '- El título debe ser conciso, pensado para un resultado de búsqueda de Google (no te pases de unos 55-60 caracteres).\n' +
    '- La descripción debe rondar 140-160 caracteres, persuasiva pero realista, sin inventar datos que no estén en el original.\n' +
    '- Tono profesional pero cercano, igual que el original en español.\n' +
    '- Para los nombres de lugares: usa la forma más natural y reconocible en ' + nombreIdioma + '. ' +
    'Por ejemplo "Aeropuerto de Gran Canaria" puede traducirse como "Gran Canaria Airport" en inglés. ' +
    'Si el nombre no tiene una forma establecida en ese idioma, consérvalo en español.\n' +
    '- Los slugs de URL nunca se traducen, solo los textos visibles.\n\n' +
    'Textos a traducir (JSON):\n' + JSON.stringify(items, null, 2) + '\n\n' +
    'Responde EXCLUSIVAMENTE con un objeto JSON válido, sin texto adicional antes ni después, sin bloques de markdown, ' +
    'usando el route_id de cada ruta como clave, con esta forma exacta: ' +
    '{\"3\": {\"meta_title\": \"...\", \"meta_description\": \"...\"}, \"18\": {\"meta_title\": \"...\", \"meta_description\": \"...\"}}';

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) {
    const cuerpoError = await response.text();
    throw new Error('Error de la API de Claude (' + response.status + '): ' + cuerpoError.slice(0, 200));
  }

  const data2 = await response.json();
  const textoRespuesta2 = data2.content.map(function (b) { return b.text || ''; }).join('');
  const limpio2 = textoRespuesta2.replace(/```json|```/g, '').trim();
  return JSON.parse(limpio2);
}

// Lista todos los textos con su estado de traducción por idioma (para las
// insignias de colores: verde traducido, rojo falta)
// ─── Gestión de idiomas de la web ────────────────────────────────────────────
app.get('/admin/idiomas', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT * FROM idiomas_web ORDER BY orden, codigo');
  res.json(result.rows);
}));

// Añade un idioma nuevo: lo registra, y crea automáticamente la ficha SEO
// vacía de ese idioma en todas las rutas existentes, lista para traducir.
app.post('/admin/idiomas', requireAdmin, asyncHandler(async (req, res) => {
  let { codigo, nombre, palabra_traslado } = req.body;
  codigo = String(codigo || '').trim().toLowerCase();
  nombre = String(nombre || '').trim();
  palabra_traslado = String(palabra_traslado || '').trim().toLowerCase().replace(/[^a-z]/g, '');

  if (!/^[a-z]{2}$/.test(codigo)) {
    return res.status(400).json({ error: 'El código debe ser exactamente 2 letras minúsculas (ej: ru, zh, pt).' });
  }
  if (!nombre) {
    return res.status(400).json({ error: 'Falta el nombre del idioma.' });
  }
  if (!palabra_traslado || palabra_traslado.length < 3) {
    return res.status(400).json({ error: 'La palabra para la URL no es válida (solo letras, mínimo 3 — ej: "transfer").' });
  }

  const existe = await pool.query('SELECT codigo FROM idiomas_web WHERE codigo = $1', [codigo]);
  if (existe.rows.length) {
    return res.status(400).json({ error: 'Ese código de idioma ya existe.' });
  }

  const maxOrden = await pool.query('SELECT COALESCE(MAX(orden), 0) AS m FROM idiomas_web');
  const nuevoOrden = maxOrden.rows[0].m + 1;

  await pool.query(
    `INSERT INTO idiomas_web (codigo, nombre, palabra_traslado, es_base, activo, orden)
     VALUES ($1, $2, $3, FALSE, TRUE, $4)`,
    [codigo, nombre, palabra_traslado, nuevoOrden]
  );

  await cargarIdiomasCache();

  // Crear la ficha SEO vacía de este idioma nuevo en todas las rutas existentes
  const rutas = await pool.query('SELECT id, origen, destino FROM rutas');
  for (const ruta of rutas.rows) {
    await crearFichasSEOSiFaltan(ruta.id, ruta.origen, ruta.destino);
  }

  res.json({ ok: true, codigo, rutasPreparadas: rutas.rows.length });
}));

// Activa/desactiva un idioma sin borrarlo (el idioma base no se puede desactivar)
app.post('/admin/idiomas/:codigo/activo', requireAdmin, asyncHandler(async (req, res) => {
  const codigo = req.params.codigo;
  if (codigo === IDIOMA_BASE) {
    return res.status(400).json({ error: 'No se puede desactivar el idioma base (español).' });
  }
  await pool.query('UPDATE idiomas_web SET activo = $1 WHERE codigo = $2', [!!req.body.activo, codigo]);
  await cargarIdiomasCache();
  res.json({ ok: true });
}));

app.get('/admin/textos', requireAdmin, asyncHandler(async (req, res) => {
  const textos = await pool.query(
    `SELECT id, clave, modulo, contexto, texto_es FROM textos_interfaz ORDER BY modulo, id`
  );
  const traducciones = await pool.query(
    `SELECT texto_id, lang_code, texto FROM textos_interfaz_traducciones`
  );

  const traduccionesPorTexto = {};
  for (const fila of traducciones.rows) {
    if (!traduccionesPorTexto[fila.texto_id]) traduccionesPorTexto[fila.texto_id] = {};
    traduccionesPorTexto[fila.texto_id][fila.lang_code] = fila.texto;
  }

  const lista = textos.rows.map(function (t) {
    const estado = {};
    for (const lang of IDIOMAS_TRADUCIBLES) {
      const valor = traduccionesPorTexto[t.id] && traduccionesPorTexto[t.id][lang];
      estado[lang] = !!(valor && valor.trim());
    }
    return { ...t, estado };
  });

  res.json({ textos: lista, idiomas: IDIOMAS_TRADUCIBLES });
}));

// Guarda (o actualiza) la traducción de un texto en un idioma concreto
// Devuelve la traducción actual (o vacío) de un texto en un idioma concreto
app.get('/admin/textos/:id/idioma/:lang', requireAdmin, asyncHandler(async (req, res) => {
  if (!IDIOMAS_TRADUCIBLES.includes(req.params.lang)) {
    return res.status(400).json({ error: 'Idioma no válido' });
  }
  const result = await pool.query(
    'SELECT texto FROM textos_interfaz_traducciones WHERE texto_id = $1 AND lang_code = $2',
    [req.params.id, req.params.lang]
  );
  res.json({ texto: result.rows.length ? result.rows[0].texto : '' });
}));

app.post('/admin/textos/:id/idioma/:lang', requireAdmin, asyncHandler(async (req, res) => {
  if (!IDIOMAS_TRADUCIBLES.includes(req.params.lang)) {
    return res.status(400).json({ error: 'Idioma no válido' });
  }
  await pool.query(
    `INSERT INTO textos_interfaz_traducciones (texto_id, lang_code, texto)
     VALUES ($1, $2, $3)
     ON CONFLICT (texto_id, lang_code) DO UPDATE SET texto = $3, updated_at = NOW()`,
    [req.params.id, req.params.lang, req.body.texto || '']
  );
  await cargarTextosCache();
  res.json({ ok: true });
}));

// Exporta todos los textos a un Excel listo para traductores —
// mismo patrón que el Excel de SEO, una fila por texto y por idioma
app.get('/admin/textos/exportar', requireAdmin, asyncHandler(async (req, res) => {
  const textos = await pool.query(`SELECT id, clave, modulo, contexto, texto_es FROM textos_interfaz ORDER BY modulo, id`);
  const traducciones = await pool.query(`SELECT texto_id, lang_code, texto FROM textos_interfaz_traducciones`);

  const traduccionesPorTexto = {};
  for (const fila of traducciones.rows) {
    if (!traduccionesPorTexto[fila.texto_id]) traduccionesPorTexto[fila.texto_id] = {};
    traduccionesPorTexto[fila.texto_id][fila.lang_code] = fila.texto;
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Traslados GC Admin';
  const sheet = workbook.addWorksheet('Textos interfaz');

  sheet.columns = [
    { header: 'texto_id', key: 'texto_id', width: 8 },
    { header: 'clave', key: 'clave', width: 32 },
    { header: 'modulo', key: 'modulo', width: 20 },
    { header: 'contexto', key: 'contexto', width: 55 },
    { header: 'texto_es', key: 'texto_es', width: 55 },
    { header: 'lang_code', key: 'lang_code', width: 10 },
    { header: 'traduccion', key: 'traduccion', width: 55 }
  ];

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FF1C1815' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8D5B0' } };

  for (const t of textos.rows) {
    for (const lang of IDIOMAS_TRADUCIBLES) {
      sheet.addRow({
        texto_id: t.id, clave: t.clave, modulo: t.modulo, contexto: t.contexto,
        texto_es: t.texto_es, lang_code: lang,
        traduccion: (traduccionesPorTexto[t.id] && traduccionesPorTexto[t.id][lang]) || ''
      });
    }
  }

  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="textos-interfaz-traslados-gc.xlsx"');
  await workbook.xlsx.write(res);
  res.end();
}));

// Importa el Excel traducido y actualiza las traducciones
app.post('/admin/textos/importar', requireAdmin, upload.single('archivo'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Falta el archivo Excel' });

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(req.file.buffer);
  const sheet = workbook.worksheets[0];

  let actualizadas = 0;
  const errores = [];

  const filas = [];
  sheet.eachRow(function (row, rowNumber) {
    if (rowNumber === 1) return;
    filas.push({
      textoId: row.getCell(1).value,
      langCode: String(row.getCell(6).value || '').trim(),
      traduccion: String(row.getCell(7).value || '').trim()
    });
  });

  for (const f of filas) {
    if (!f.textoId || !IDIOMAS_TRADUCIBLES.includes(f.langCode)) continue;
    try {
      await pool.query(
        `INSERT INTO textos_interfaz_traducciones (texto_id, lang_code, texto)
         VALUES ($1, $2, $3)
         ON CONFLICT (texto_id, lang_code) DO UPDATE SET texto = $3, updated_at = NOW()`,
        [f.textoId, f.langCode, f.traduccion]
      );
      actualizadas++;
    } catch (err) {
      errores.push('Texto ' + f.textoId + '/' + f.langCode + ': ' + err.message);
    }
  }

  await cargarTextosCache();
  res.json({ ok: true, actualizadas, errores });
}));

// Traduce con IA (Claude) todos los textos que falten en un idioma — no
// guarda nada todavía, solo devuelve propuestas para revisar antes de guardar
app.post('/admin/textos/traducir-ia/:lang', requireAdmin, asyncHandler(async (req, res) => {
  const lang = req.params.lang;
  if (!IDIOMAS_TRADUCIBLES.includes(lang)) {
    return res.status(400).json({ error: 'Idioma no válido' });
  }

  const textos = await pool.query('SELECT id, clave, contexto, texto_es FROM textos_interfaz ORDER BY id');
  const traducciones = await pool.query(
    'SELECT texto_id, texto FROM textos_interfaz_traducciones WHERE lang_code = $1',
    [lang]
  );
  const yaTraducidos = {};
  for (const fila of traducciones.rows) yaTraducidos[fila.texto_id] = fila.texto;

  const pendientes = textos.rows.filter(function (t) {
    return !(yaTraducidos[t.id] && yaTraducidos[t.id].trim());
  });

  if (pendientes.length === 0) {
    return res.json({ ok: true, propuestas: [] });
  }

  const items = pendientes.map(function (t) {
    return { clave: t.clave, contexto: t.contexto || '', texto_es: t.texto_es };
  });

  let traduccionesIA;
  try {
    traduccionesIA = await traducirConClaudeIA(items, NOMBRE_IDIOMA_ES[lang] || lang);
  } catch (err) {
    console.error('Error traduciendo con IA:', err.message);
    return res.status(500).json({ error: err.message });
  }

  const propuestas = pendientes.map(function (t) {
    return {
      texto_id: t.id,
      clave: t.clave,
      contexto: t.contexto,
      texto_es: t.texto_es,
      sugerencia: traduccionesIA[t.clave] || ''
    };
  });

  res.json({ ok: true, propuestas });
}));

// Guarda en bloque las traducciones revisadas (a mano o tras la propuesta de IA)
app.post('/admin/textos/guardar-lote', requireAdmin, asyncHandler(async (req, res) => {
  const { lang, traducciones } = req.body;
  if (!IDIOMAS_TRADUCIBLES.includes(lang) || !Array.isArray(traducciones)) {
    return res.status(400).json({ error: 'Datos no válidos' });
  }
  let guardadas = 0;
  for (const item of traducciones) {
    if (!item.texto_id) continue;
    await pool.query(
      `INSERT INTO textos_interfaz_traducciones (texto_id, lang_code, texto)
       VALUES ($1, $2, $3)
       ON CONFLICT (texto_id, lang_code) DO UPDATE SET texto = $3, updated_at = NOW()`,
      [item.texto_id, lang, item.texto || '']
    );
    guardadas++;
  }
  await cargarTextosCache();
  res.json({ ok: true, guardadas });
}));

// ─── Calculador de tarifas ────────────────────────────────────────────────────
// Herramienta interna del admin para calcular el precio aproximado de una
// ruta según el tarifario oficial, sin nocturnos ni festivos (solo diurno base).

app.get('/admin/tarifario', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT * FROM tarifario WHERE id = 1');
  res.json(result.rows[0]);
}));

app.post('/admin/tarifario', requireAdmin, asyncHandler(async (req, res) => {
  const { bajada_bandera, precio_km_diurno, suplemento_aeropuerto } = req.body;
  await pool.query(
    `UPDATE tarifario SET bajada_bandera = $1, precio_km_diurno = $2,
     suplemento_aeropuerto = $3 WHERE id = 1`,
    [
      parseFloat(bajada_bandera) || 3.00,
      parseFloat(precio_km_diurno) || 1.35,
      parseFloat(suplemento_aeropuerto) || 2.10
    ]
  );
  res.json({ ok: true });
}));

// Calcula el precio estimado dado unos km y si incluye aeropuerto/puerto
app.post('/admin/tarifario/calcular', requireAdmin, asyncHandler(async (req, res) => {
  const { km, con_suplemento } = req.body;
  const tarifa = await pool.query('SELECT * FROM tarifario WHERE id = 1');
  const t = tarifa.rows[0];

  const distancia = parseFloat(km) || 0;
  const precio = parseFloat(t.bajada_bandera) +
    ((distancia - 1) * parseFloat(t.precio_km_diurno)) +
    (con_suplemento ? parseFloat(t.suplemento_aeropuerto) : 0);

  res.json({ precio: Math.max(precio, parseFloat(t.bajada_bandera)).toFixed(2) });
}));

// ─── Admin: destinos ──────────────────────────────────────────────────────────
app.get('/admin/destinos', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT id, nombre, activo FROM destinos ORDER BY nombre'
  );
  res.json({ destinos: result.rows });
}));

app.post('/admin/destinos', requireAdmin, asyncHandler(async (req, res) => {
  const { nombre } = req.body;
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'El nombre es obligatorio.' });
  const existe = await pool.query(
    'SELECT 1 FROM destinos WHERE LOWER(nombre) = LOWER($1) LIMIT 1',
    [nombre.trim()]
  );
  if (existe.rows.length) return res.status(400).json({ error: 'Ya existe un destino con ese nombre.' });
  await pool.query('INSERT INTO destinos (nombre) VALUES ($1)', [nombre.trim()]);
  res.json({ ok: true });
}));

app.post('/admin/destinos/:id/editar', requireAdmin, asyncHandler(async (req, res) => {
  const { nombre } = req.body;
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'El nombre es obligatorio.' });
  const existe = await pool.query(
    'SELECT 1 FROM destinos WHERE LOWER(nombre) = LOWER($1) AND id <> $2 LIMIT 1',
    [nombre.trim(), req.params.id]
  );
  if (existe.rows.length) return res.status(400).json({ error: 'Ya existe un destino con ese nombre.' });
  await pool.query('UPDATE destinos SET nombre = $1 WHERE id = $2', [nombre.trim(), req.params.id]);
  res.json({ ok: true });
}));

app.post('/admin/destinos/:id/activo', requireAdmin, asyncHandler(async (req, res) => {
  await pool.query('UPDATE destinos SET activo = $1 WHERE id = $2', [!!req.body.activo, req.params.id]);
  res.json({ ok: true });
}));

app.post('/admin/destinos/:id/eliminar', requireAdmin, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM destinos WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ─── API pública: cotizaciones ───────────────────────────────────────────────

app.post('/api/cotizaciones', asyncHandler(async (req, res) => {
  const { origen, destino, fecha_aproximada, num_pasajeros, email_cliente } = req.body;
  if (!origen || !destino || !email_cliente) {
    return res.status(400).json({ error: 'Faltan datos obligatorios.' });
  }
  const result = await pool.query(
    `INSERT INTO cotizaciones (origen, destino, fecha_aproximada, num_pasajeros, email_cliente)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [origen.trim(), destino.trim(), fecha_aproximada || null, num_pasajeros || null, email_cliente.trim().toLowerCase()]
  );
  res.json({ ok: true, id: result.rows[0].id });
}));

// ─── Admin: cotizaciones ──────────────────────────────────────────────────────

app.get('/admin/cotizaciones', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT c.*, 
            array_agg(json_build_object('categoria_id', cp.categoria_id, 'nombre', cv.nombre, 'precio', cp.precio) ORDER BY cv.orden, cv.nombre) 
              FILTER (WHERE cp.id IS NOT NULL) AS precios
     FROM cotizaciones c
     LEFT JOIN cotizaciones_precios cp ON cp.cotizacion_id = c.id
     LEFT JOIN categorias_vehiculos cv ON cv.id = cp.categoria_id
     GROUP BY c.id
     ORDER BY c.creado_en DESC`
  );
  res.json({ cotizaciones: result.rows });
}));

app.get('/admin/cotizaciones/pendientes-count', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query(
    "SELECT COUNT(*) AS total FROM cotizaciones WHERE estado = 'pendiente'"
  );
  res.json({ total: parseInt(result.rows[0].total) });
}));

app.post('/admin/cotizaciones/:id/precios', requireAdmin, asyncHandler(async (req, res) => {
  const { precios } = req.body; // [{categoria_id, precio}]
  if (!Array.isArray(precios)) return res.status(400).json({ error: 'Formato incorrecto' });
  for (const p of precios) {
    if (!p.precio || isNaN(p.precio)) continue;
    await pool.query(
      `INSERT INTO cotizaciones_precios (cotizacion_id, categoria_id, precio)
       VALUES ($1, $2, $3)
       ON CONFLICT (cotizacion_id, categoria_id) DO UPDATE SET precio = $3`,
      [req.params.id, p.categoria_id, p.precio]
    );
  }
  res.json({ ok: true });
}));

app.post('/admin/cotizaciones/:id/enviar', requireAdmin, asyncHandler(async (req, res) => {
  const cotiz = await pool.query(
    `SELECT c.*, 
            array_agg(json_build_object('nombre', cv.nombre, 'precio', cp.precio, 'pax', cv.capacidad_pasajeros) ORDER BY cv.orden, cv.nombre)
              FILTER (WHERE cp.id IS NOT NULL) AS precios
     FROM cotizaciones c
     LEFT JOIN cotizaciones_precios cp ON cp.cotizacion_id = c.id
     LEFT JOIN categorias_vehiculos cv ON cv.id = cp.categoria_id
     WHERE c.id = $1
     GROUP BY c.id`,
    [req.params.id]
  );

  if (!cotiz.rows.length) return res.status(404).json({ error: 'Cotización no encontrada' });
  const c = cotiz.rows[0];

  if (!c.precios || !c.precios.length) {
    return res.status(400).json({ error: 'Añade al menos un precio antes de enviar.' });
  }

  const fechaViaje = c.fecha_aproximada
    ? new Date(c.fecha_aproximada).toLocaleDateString('es-ES')
    : 'A confirmar';

  const filasPrecios = c.precios.map(function(p) {
    return `<tr>
      <td style="padding:8px 16px;border-bottom:1px solid #eee;">${p.nombre}</td>
      <td style="padding:8px 16px;border-bottom:1px solid #eee;">${p.pax} pax</td>
      <td style="padding:8px 16px;border-bottom:1px solid #eee;font-weight:600;">${parseFloat(p.precio).toFixed(2)} €</td>
    </tr>`;
  }).join('');

  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      body { margin:0; padding:0; background:#f5f5f5; }
      .wrapper { max-width:600px; margin:0 auto; background:#fff; }
      .header { background:#2c2c2c; padding:24px; text-align:center; }
      .body { padding:24px; }
      .tabla-datos { width:100%; border-collapse:collapse; margin:16px 0; }
      .tabla-datos td { padding:8px 12px; font-size:14px; }
      .tabla-precios { width:100%; border-collapse:collapse; }
      .tabla-precios th { background:#2c2c2c; color:#fff; padding:8px 12px; text-align:left; font-size:13px; }
      .tabla-precios td { padding:8px 12px; border-bottom:1px solid #eee; font-size:14px; }
      .boton-cta { display:block; background:#d4956a; color:#fff; padding:14px 28px; border-radius:6px; text-decoration:none; font-weight:600; text-align:center; margin:24px auto; max-width:280px; }
      .footer { background:#f5f0ea; padding:16px; text-align:center; font-size:12px; color:#888; }
      .nota { font-size:12px; color:#999; margin-top:16px; line-height:1.6; }
      @media (max-width:480px) {
        .body { padding:16px; }
        .tabla-datos td, .tabla-precios th, .tabla-precios td { padding:6px 8px; font-size:13px; }
        .boton-cta { padding:12px 16px; font-size:14px; }
      }
    </style>
  </head>
  <body>
  <div class="wrapper">
    <div class="header">
      <h1 style="color:#d4956a;margin:0;font-size:22px;">Traslados GC</h1>
      <p style="color:#aaa;margin:4px 0 0 0;font-size:13px;">Gran Canaria</p>
    </div>
    <div class="body">
      <p style="margin:0 0 8px 0;">Hola,</p>
      <p style="margin:0 0 16px 0;">Gracias por contactarnos. Aquí tienes los precios disponibles para tu traslado:</p>
      <table class="tabla-datos">
        <tr style="background:#f5f0ea;">
          <td style="font-weight:600;width:40%;">Origen</td>
          <td>${c.origen}</td>
        </tr>
        <tr>
          <td style="font-weight:600;">Destino</td>
          <td>${c.destino}</td>
        </tr>
        <tr style="background:#f5f0ea;">
          <td style="font-weight:600;">Fecha aproximada</td>
          <td>${fechaViaje}</td>
        </tr>
        ${c.num_pasajeros ? `<tr><td style="font-weight:600;">Pasajeros</td><td>${c.num_pasajeros}</td></tr>` : ''}
      </table>
      <h3 style="color:#2c2c2c;margin:20px 0 8px 0;font-size:15px;">Opciones disponibles</h3>
      <table class="tabla-precios">
        <tr>
          <th>Categoría</th>
          <th>Capacidad</th>
          <th>Precio estimado</th>
        </tr>
        ${filasPrecios}
      </table>
      <p class="nota">El precio es una estimación basada en los km de distancia. El precio final es lo que marca el taxímetro del conductor. El cobro lo realiza el conductor directamente.</p>
      <a href="https://traslados-gc.onrender.com" class="boton-cta">Ver todas las rutas disponibles</a>
    </div>
    <div class="footer">Traslados GC · Gran Canaria</div>
  </div>
  </body>
  </html>`;

  try {
    await enviarEmail({
      to: c.email_cliente,
      subject: 'Precio de traslado: ' + c.origen + ' → ' + c.destino,
      html
    });
    await pool.query(
      "UPDATE cotizaciones SET estado = 'respondida', respuesta_enviada = TRUE WHERE id = $1",
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Error enviando email cotización:', err.message);
    res.status(500).json({ error: 'Error enviando email: ' + err.message });
  }
}));

app.delete('/admin/cotizaciones/:id', requireAdmin, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM cotizaciones WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ─── Admin: destinos — traducciones ──────────────────────────────────────────

// Devuelve todas las traducciones de todos los destinos para un idioma
app.get('/admin/destinos/traducciones/:lang', requireAdmin, asyncHandler(async (req, res) => {
  const { lang } = req.params;
  const destinos = await pool.query('SELECT id, nombre FROM destinos ORDER BY nombre');
  const traducciones = await pool.query(
    'SELECT destino_id, nombre FROM destinos_traducciones WHERE lang_code = $1',
    [lang]
  );
  const mapaTrads = {};
  for (const t of traducciones.rows) mapaTrads[t.destino_id] = t.nombre;
  const resultado = destinos.rows.map(function (d) {
    return { id: d.id, nombre_es: d.nombre, nombre_traducido: mapaTrads[d.id] || '' };
  });
  res.json({ destinos: resultado });
}));

// Guarda una traducción individual
app.post('/admin/destinos/:id/traduccion/:lang', requireAdmin, asyncHandler(async (req, res) => {
  const { id, lang } = req.params;
  const { nombre } = req.body;
  await pool.query(
    `INSERT INTO destinos_traducciones (destino_id, lang_code, nombre)
     VALUES ($1, $2, $3)
     ON CONFLICT (destino_id, lang_code) DO UPDATE SET nombre = $3, updated_at = NOW()`,
    [id, lang, nombre || '']
  );
  res.json({ ok: true });
}));

// Traduce con IA todos los destinos vacíos para un idioma
app.post('/admin/destinos/traducir-ia/:lang', requireAdmin, asyncHandler(async (req, res) => {
  const { lang } = req.params;
  if (!IDIOMAS_TRADUCIBLES.includes(lang)) {
    return res.status(400).json({ error: 'Idioma no válido' });
  }

  const destinos = await pool.query('SELECT id, nombre FROM destinos WHERE activo = TRUE ORDER BY nombre');
  const traducciones = await pool.query(
    'SELECT destino_id, nombre FROM destinos_traducciones WHERE lang_code = $1',
    [lang]
  );
  const yaTraducidos = {};
  for (const t of traducciones.rows) yaTraducidos[t.destino_id] = t.nombre;

  // Solo los que no tienen traducción todavía
  const pendientes = destinos.rows.filter(function (d) { return !yaTraducidos[d.id]; });
  if (pendientes.length === 0) return res.json({ ok: true, propuestas: [] });

  const nombreIdioma = NOMBRE_IDIOMA_ES[lang] || lang;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Falta ANTHROPIC_API_KEY en Render.' });

  const prompt = 'Traduce los siguientes nombres de lugares turísticos de Gran Canaria del español al ' + nombreIdioma + '.\n' +
    'Usa la forma más natural y reconocida en ese idioma (ej: "Aeropuerto de Gran Canaria" → "Gran Canaria Airport" en inglés).\n' +
    'Si el nombre no tiene traducción establecida, devuélvelo igual en español.\n\n' +
    'Lugares a traducir (JSON con id y nombre en español):\n' + JSON.stringify(pendientes) + '\n\n' +
    'Responde EXCLUSIVAMENTE con un JSON válido, sin texto adicional, sin markdown, con esta forma exacta:\n' +
    '[{"id": 1, "nombre": "..."}, {"id": 2, "nombre": "..."}]';

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] })
  });

  if (!response.ok) {
    const err = await response.text();
    return res.status(500).json({ error: 'Error API Claude: ' + err.slice(0, 200) });
  }

  const data = await response.json();
  const texto = data.content.map(function (b) { return b.text || ''; }).join('');
  const limpio = texto.replace(/```json|```/g, '').trim();
  const propuestas = JSON.parse(limpio);

  res.json({ ok: true, propuestas });
}));

// Guarda en bloque las propuestas de traducciones de destinos revisadas
app.post('/admin/destinos/traducciones/guardar-lote', requireAdmin, asyncHandler(async (req, res) => {
  const { lang, propuestas } = req.body;
  if (!lang || !Array.isArray(propuestas)) return res.status(400).json({ error: 'Datos no válidos' });
  for (const p of propuestas) {
    if (!p.id || !p.nombre) continue;
    await pool.query(
      `INSERT INTO destinos_traducciones (destino_id, lang_code, nombre)
       VALUES ($1, $2, $3)
       ON CONFLICT (destino_id, lang_code) DO UPDATE SET nombre = $3, updated_at = NOW()`,
      [p.id, lang, p.nombre]
    );
  }
  res.json({ ok: true });
}));

// ─── Admin: reservas ─────────────────────────────────────────────────────────

app.get('/admin/reservas', requireAdmin, asyncHandler(async (req, res) => {
  const { estado, periodo, orden, col, archivo } = req.query;
  const params = [];
  const condiciones = [];

  // Archivadas o activas
  if (archivo === 'si') {
    condiciones.push('r.archivada = TRUE');
  } else {
    condiciones.push('r.archivada = FALSE');
  }

  // Filtro por estado
  if (estado && estado !== 'todas') {
    params.push(estado);
    condiciones.push('r.estado = $' + params.length);
  }

  // Filtro por periodo
  if (periodo === 'hoy') {
    condiciones.push('r.fecha = CURRENT_DATE');
  } else if (periodo === 'semana') {
    condiciones.push("r.fecha >= date_trunc('week', CURRENT_DATE) AND r.fecha < date_trunc('week', CURRENT_DATE) + INTERVAL '7 days'");
  } else if (periodo === 'mes') {
    condiciones.push("r.fecha >= date_trunc('month', CURRENT_DATE) AND r.fecha < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'");
  }

  const where = condiciones.length ? 'WHERE ' + condiciones.join(' AND ') : '';
  // Columnas permitidas para ordenar (evitar SQL injection)
  const colsPermitidas = {
    fecha: 'r.fecha', creado_en: 'r.creado_en', nombre_cliente: 'r.nombre_cliente',
    categoria_nombre: 'cv.nombre', conductor_nombre: 'c.nombre', estado: 'r.estado'
  };
  const colSQL = colsPermitidas[col] || 'r.fecha';
  const dirSQL = orden === 'asc' ? 'ASC' : 'DESC';
  const ordenSQL = colSQL + ' ' + dirSQL + ', r.hora ' + dirSQL;

  const result = await pool.query(
    `SELECT r.id, r.numero_reserva, r.fecha, r.hora, r.nombre_cliente,
            r.telefono_cliente, r.email_cliente, r.precio_estimado,
            r.notas, r.estado, r.creado_en, r.archivada,
            r.conductor_id,
            cv.nombre AS categoria_nombre,
            c.nombre AS conductor_nombre,
            COALESCE((
              SELECT SUM(re.precio_en_reserva)
              FROM reservas_extras re WHERE re.reserva_id = r.id
            ), 0) AS total_extras
     FROM reservas r
     LEFT JOIN categorias_vehiculos cv ON cv.id = r.categoria_id
     LEFT JOIN conductores c ON c.id = r.conductor_id
     ${where}
     ORDER BY ${ordenSQL}`,
    params
  );

  // Calcular total por reserva
  const reservas = result.rows.map(function(r) {
    const extras = parseFloat(r.total_extras) || 0;
    const viaje = parseFloat(r.precio_estimado) || 0;
    return Object.assign({}, r, { total_estimado: viaje + extras });
  });

  res.json({ reservas });
}));

app.get('/admin/reservas/excel', requireAdmin, asyncHandler(async (req, res) => {
  const { estado, periodo, archivo } = req.query;
  const params = [];
  const condiciones = [];

  if (archivo === 'si') {
    condiciones.push('r.archivada = TRUE');
  } else {
    condiciones.push('r.archivada = FALSE');
  }
  if (estado && estado !== 'todas') {
    params.push(estado);
    condiciones.push('r.estado = $' + params.length);
  }
  if (periodo === 'hoy') {
    condiciones.push('r.fecha = CURRENT_DATE');
  } else if (periodo === 'semana') {
    condiciones.push("r.fecha >= date_trunc('week', CURRENT_DATE) AND r.fecha < date_trunc('week', CURRENT_DATE) + INTERVAL '7 days'");
  } else if (periodo === 'mes') {
    condiciones.push("r.fecha >= date_trunc('month', CURRENT_DATE) AND r.fecha < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'");
  }
  const where = condiciones.length ? 'WHERE ' + condiciones.join(' AND ') : '';

  const result = await pool.query(
    `SELECT r.numero_reserva, r.fecha, r.hora, r.nombre_cliente,
            r.telefono_cliente, r.email_cliente,
            r.notas, r.estado, r.creado_en,
            cv.nombre AS categoria_nombre,
            c.nombre AS conductor_nombre,
            r.precio_estimado,
            COALESCE((SELECT SUM(re.precio_en_reserva) FROM reservas_extras re WHERE re.reserva_id = r.id), 0) AS total_extras
     FROM reservas r
     LEFT JOIN categorias_vehiculos cv ON cv.id = r.categoria_id
     LEFT JOIN conductores c ON c.id = r.conductor_id
     ${where}
     ORDER BY r.fecha DESC, r.hora DESC`,
    params
  );

  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Reservas');

  ws.columns = [
    { header: 'PNR',          key: 'pnr',        width: 12 },
    { header: 'Fecha viaje',  key: 'fecha',       width: 14 },
    { header: 'Hora',         key: 'hora',        width: 8  },
    { header: 'Cliente',      key: 'cliente',     width: 25 },
    { header: 'Teléfono',     key: 'telefono',    width: 18 },
    { header: 'Email',        key: 'email',       width: 28 },
    { header: 'Categoría',    key: 'categoria',   width: 18 },
    { header: 'Chofer',       key: 'chofer',      width: 20 },
    { header: 'Precio viaje', key: 'precio',      width: 14 },
    { header: 'Extras',       key: 'extras',      width: 10 },
    { header: 'Total est.',   key: 'total',       width: 12 },
    { header: 'Estado',       key: 'estado',      width: 14 },
    { header: 'Detalles',     key: 'notas',       width: 50 },
    { header: 'Recibida',     key: 'recibida',    width: 16 },
  ];

  // Cabecera en negrita
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9C4A0' } };

  for (const r of result.rows) {
    const viaje = parseFloat(r.precio_estimado) || 0;
    const extras = parseFloat(r.total_extras) || 0;
    ws.addRow({
      pnr:       r.numero_reserva || '',
      fecha:     r.fecha ? new Date(r.fecha).toLocaleDateString('es-ES') : '',
      hora:      r.hora ? r.hora.slice(0,5) : '',
      cliente:   r.nombre_cliente,
      telefono:  r.telefono_cliente,
      email:     r.email_cliente,
      categoria: r.categoria_nombre || '',
      chofer:    r.conductor_nombre || '',
      precio:    viaje,
      extras:    extras,
      total:     viaje + extras,
      estado:    r.estado,
      notas:     r.notas || '',
      recibida:  r.creado_en ? new Date(r.creado_en).toLocaleDateString('es-ES') : '',
    });
  }

  // Formato número para columnas de precio
  ['precio', 'extras', 'total'].forEach(function(key) {
    const col = ws.getColumn(key);
    col.numFmt = '#,##0.00 "€"';
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="reservas.xlsx"');
  await wb.xlsx.write(res);
  res.end();
}));

app.get('/admin/reservas/:id', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT r.*, cv.nombre AS categoria_nombre, c.nombre AS conductor_nombre
     FROM reservas r
     LEFT JOIN categorias_vehiculos cv ON cv.id = r.categoria_id
     LEFT JOIN conductores c ON c.id = r.conductor_id
     WHERE r.id = $1`,
    [req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Reserva no encontrada' });
  const reserva = result.rows[0];
  const extras = await pool.query(
    `SELECT e.nombre, re.precio_en_reserva
     FROM reservas_extras re
     JOIN extras e ON e.id = re.extra_id
     WHERE re.reserva_id = $1`,
    [req.params.id]
  );
  reserva.extras = extras.rows;
  const totalExtras = extras.rows.reduce(function(s, e) { return s + parseFloat(e.precio_en_reserva); }, 0);
  reserva.total_estimado = (parseFloat(reserva.precio_estimado) || 0) + totalExtras;
  res.json({ reserva });
}));

app.post('/admin/reservas/:id/estado', requireAdmin, asyncHandler(async (req, res) => {
  const { estado } = req.body;
  const estadosValidos = ['pendiente', 'confirmada', 'completada', 'cancelada'];
  if (!estadosValidos.includes(estado)) return res.status(400).json({ error: 'Estado no válido' });
  await pool.query('UPDATE reservas SET estado = $1 WHERE id = $2', [estado, req.params.id]);
  res.json({ ok: true });
}));

app.post('/admin/reservas/:id/archivar', requireAdmin, asyncHandler(async (req, res) => {
  const { archivar } = req.body;
  await pool.query('UPDATE reservas SET archivada = $1 WHERE id = $2', [!!archivar, req.params.id]);
  res.json({ ok: true });
}));

app.post('/admin/reservas/archivar-lote', requireAdmin, asyncHandler(async (req, res) => {
  const { ids, archivar } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Sin IDs' });
  await pool.query('UPDATE reservas SET archivada = $1 WHERE id = ANY($2)', [!!archivar, ids]);
  res.json({ ok: true });
}));

app.delete('/admin/reservas/:id', requireAdmin, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM reservas WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

app.post('/admin/reservas/borrar-lote', requireAdmin, asyncHandler(async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Sin IDs' });
  await pool.query('DELETE FROM reservas WHERE id = ANY($1)', [ids]);
  res.json({ ok: true });
}));

// Asignar chofer manualmente a una reserva
app.post('/admin/reservas/:id/chofer', requireAdmin, asyncHandler(async (req, res) => {
  const { conductor_id } = req.body;
  await pool.query(
    'UPDATE reservas SET conductor_id = $1 WHERE id = $2',
    [conductor_id || null, req.params.id]
  );
  res.json({ ok: true });
}));

// Listar conductores aprobados para el desplegable de asignación
app.get('/admin/conductores-aprobados', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT id, nombre, telefono FROM conductores WHERE estado = $1 ORDER BY nombre',
    ['aprobado']
  );
  res.json({ conductores: result.rows });
}));

// ─── Admin: extras ────────────────────────────────────────────────────────────
app.get('/admin/extras', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT id, nombre, precio, activo FROM extras ORDER BY id'
  );
  res.json({ extras: result.rows });
}));

app.post('/admin/extras', requireAdmin, asyncHandler(async (req, res) => {
  const { nombre, precio } = req.body;
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'El nombre es obligatorio.' });
  const p = parseFloat(precio);
  if (isNaN(p) || p < 0) return res.status(400).json({ error: 'El precio no es válido.' });
  await pool.query(
    'INSERT INTO extras (nombre, precio) VALUES ($1, $2)',
    [nombre.trim(), p]
  );
  res.json({ ok: true });
}));

app.post('/admin/extras/:id/editar', requireAdmin, asyncHandler(async (req, res) => {
  const { nombre, precio } = req.body;
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'El nombre es obligatorio.' });
  const p = parseFloat(precio);
  if (isNaN(p) || p < 0) return res.status(400).json({ error: 'El precio no es válido.' });
  await pool.query(
    'UPDATE extras SET nombre = $1, precio = $2 WHERE id = $3',
    [nombre.trim(), p, req.params.id]
  );
  res.json({ ok: true });
}));

app.post('/admin/extras/:id/activo', requireAdmin, asyncHandler(async (req, res) => {
  await pool.query('UPDATE extras SET activo = $1 WHERE id = $2', [!!req.body.activo, req.params.id]);
  res.json({ ok: true });
}));

app.post('/admin/extras/:id/eliminar', requireAdmin, asyncHandler(async (req, res) => {
  const enUso = await pool.query('SELECT 1 FROM reservas_extras WHERE extra_id = $1 LIMIT 1', [req.params.id]);
  if (enUso.rows.length) {
    return res.status(400).json({ error: 'Este extra está asociado a una o más reservas y no se puede eliminar.' });
  }
  await pool.query('DELETE FROM extras WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ─── Ajustes globales de SEO ──────────────────────────────────────────────────
app.get('/admin/seo/ajustes-globales', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT * FROM ajustes_seo_globales WHERE id = 1');
  res.json(result.rows[0]);
}));

app.post('/admin/seo/ajustes-globales', requireAdmin, asyncHandler(async (req, res) => {
  const { nombre_marca, twitter_activo } = req.body;
  await pool.query(
    `UPDATE ajustes_seo_globales
     SET nombre_marca = $1, twitter_activo = $2, updated_at = NOW()
     WHERE id = 1`,
    [(nombre_marca || '').trim() || 'Traslados · GC', !!twitter_activo]
  );
  res.json({ ok: true });
}));

app.post('/admin/seo/ajustes-globales/imagen', requireAdmin, asyncHandler(async (req, res) => {
  const { imagen } = req.body;
  if (!imagen || !imagen.startsWith('data:image/') || imagen.length > 900000) {
    return res.status(400).json({ error: 'La imagen no es válida o pesa demasiado (máx. ~650KB).' });
  }
  await pool.query('UPDATE ajustes_seo_globales SET imagen_og_defecto = $1, updated_at = NOW() WHERE id = 1', [imagen]);
  res.json({ ok: true });
}));

app.post('/admin/seo/ajustes-globales/imagen/eliminar', requireAdmin, asyncHandler(async (req, res) => {
  await pool.query('UPDATE ajustes_seo_globales SET imagen_og_defecto = NULL WHERE id = 1');
  res.json({ ok: true });
}));

// Sirve la imagen de respaldo públicamente, igual que /ruta-imagen/:id
app.get('/imagen-og-defecto', asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT imagen_og_defecto FROM ajustes_seo_globales WHERE id = 1');
  const dataUrl = result.rows[0] && result.rows[0].imagen_og_defecto;
  if (!dataUrl) return res.status(404).end();
  const match = dataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!match) return res.status(404).end();
  res.set('Content-Type', match[1]);
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(Buffer.from(match[2], 'base64'));
}));

// ─── Redirecciones 301 ────────────────────────────────────────────────────────
app.get('/admin/redirecciones', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT * FROM redirecciones_301 ORDER BY creado_en DESC');
  res.json(result.rows);
}));

app.post('/admin/redirecciones', requireAdmin, asyncHandler(async (req, res) => {
  let { ruta_antigua, ruta_nueva } = req.body;
  if (!ruta_antigua || !ruta_nueva) {
    return res.status(400).json({ error: 'Faltan las dos rutas (antigua y nueva).' });
  }
  // Normalizar: siempre con / al principio, sin / al final, sin el dominio
  function normalizar(r) {
    r = r.trim().replace(/^https?:\/\/[^/]+/, '');
    if (!r.startsWith('/')) r = '/' + r;
    return r.replace(/\/+$/, '') || '/';
  }
  ruta_antigua = normalizar(ruta_antigua);
  ruta_nueva = normalizar(ruta_nueva);

  if (ruta_antigua === ruta_nueva) {
    return res.status(400).json({ error: 'La ruta antigua y la nueva no pueden ser iguales.' });
  }
  try {
    await pool.query(
      `INSERT INTO redirecciones_301 (ruta_antigua, ruta_nueva) VALUES ($1, $2)
       ON CONFLICT (ruta_antigua) DO UPDATE SET ruta_nueva = $2`,
      [ruta_antigua, ruta_nueva]
    );
    res.json({ ok: true });
  } catch (err) {
    throw err;
  }
}));

app.post('/admin/redirecciones/:id/eliminar', requireAdmin, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM redirecciones_301 WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ─── Panel de salud SEO ───────────────────────────────────────────────────────
// Devuelve los datos estructurados (Schema.org) que vería Google para una
// ruta en un idioma concreto — para que German pueda verlos sin salir del admin
app.get('/admin/seo/rutas/:id/idioma/:lang/schema', requireAdmin, asyncHandler(async (req, res) => {
  if (!IDIOMAS_PERMITIDOS.includes(req.params.lang)) {
    return res.status(400).json({ error: 'Idioma no válido' });
  }
  const seoResult = await pool.query(
    `SELECT rss.*, r.origen, r.destino, r.id AS ruta_id, (r.imagen_og IS NOT NULL) AS tiene_imagen
     FROM route_seo_settings rss
     JOIN rutas r ON r.id = rss.route_id
     WHERE rss.route_id = $1 AND rss.lang_code = $2`,
    [req.params.id, req.params.lang]
  );
  if (seoResult.rows.length === 0) return res.status(404).json({ error: 'No encontrado' });
  const seo = seoResult.rows[0];

  const precios = await pool.query(
    `SELECT cv.nombre, rp.precio FROM rutas_precios rp
     JOIN categorias_vehiculos cv ON cv.id = rp.categoria_id
     WHERE rp.ruta_id = $1 AND cv.disponible = TRUE`,
    [seo.ruta_id]
  );

  const ajustesGlobales = await pool.query('SELECT * FROM ajustes_seo_globales WHERE id = 1');
  const globales = ajustesGlobales.rows[0] || { nombre_marca: 'Traslados · GC', imagen_og_defecto: null };
  const nombreMarca = globales.nombre_marca || 'Traslados · GC';

  const urlActual = BASE_URL + '/' + req.params.lang + '/' + SECCIONES_TRASLADO[req.params.lang] + '/' + (seo.slug_url || '');
  const { schemaTaxiService, schemaBreadcrumb } = construirSchemaRuta(
    seo, precios.rows, nombreMarca, globales, BASE_URL, urlActual
  );

  res.json({ activo: seo.activo, url: urlActual, schemaTaxiService, schemaBreadcrumb });
}));

app.get('/admin/seo/salud', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT rss.lang_code, rss.meta_title, rss.meta_description, rss.activo,
            r.activa AS ruta_activa
     FROM route_seo_settings rss
     JOIN rutas r ON r.id = rss.route_id`
  );

  const stats = {};
  for (const lang of IDIOMAS_PERMITIDOS) {
    stats[lang] = { total: 0, activas: 0, vacios: 0, excedePx: 0, duplicados: 0 };
  }

  const titulosPorIdioma = {};
  for (const lang of IDIOMAS_PERMITIDOS) titulosPorIdioma[lang] = {};

  for (const fila of result.rows) {
    const lang = fila.lang_code;
    if (!stats[lang]) continue;
    stats[lang].total++;
    if (fila.activo && fila.ruta_activa) stats[lang].activas++;
    if (!fila.meta_title || !fila.meta_description) stats[lang].vacios++;

    const pxT = medirPxTitulo(fila.meta_title);
    const pxD = medirPxDescripcion(fila.meta_description);
    if (pxT > 600 || pxD > 960) stats[lang].excedePx++;

    if (fila.meta_title) {
      const t = fila.meta_title.trim().toLowerCase();
      titulosPorIdioma[lang][t] = (titulosPorIdioma[lang][t] || 0) + 1;
    }
  }

  for (const lang of IDIOMAS_PERMITIDOS) {
    stats[lang].duplicados = Object.values(titulosPorIdioma[lang]).filter(function (n) { return n > 1; }).length;
  }

  res.json(stats);
}));

// ─── Páginas públicas por ruta (SSR) ─────────────────────────────────────────
// URL: /:lang/traslado/:slug  (ej: /es/traslado/las-palmas-a-maspalomas)
// El patrón de la URL solo exige 2 letras minúsculas — qué idiomas son
// válidos de verdad se comprueba dentro contra la lista cargada de la base
// de datos, así un idioma nuevo añadido desde el admin funciona al instante,
// sin tener que redesplegar el servidor.
app.get('/:lang([a-z]{2})/:seccion/:slug', asyncHandler(async (req, res) => {
  const { lang, seccion, slug } = req.params;

  if (!IDIOMAS_PERMITIDOS.includes(lang)) {
    return res.status(404).send('Página no encontrada');
  }

  // Verificar que la sección del URL corresponde al idioma
  if (seccion !== SECCIONES_TRASLADO[lang]) {
    return res.status(404).send('Página no encontrada');
  }

  // Buscar la ficha SEO activa para este slug e idioma
  const seoResult = await pool.query(
    `SELECT rss.*, r.origen, r.destino, r.id AS ruta_id, (r.imagen_og IS NOT NULL) AS tiene_imagen
     FROM route_seo_settings rss
     JOIN rutas r ON r.id = rss.route_id
     WHERE rss.lang_code = $1 AND rss.slug_url = $2 AND rss.activo = TRUE AND r.activa = TRUE`,
    [lang, slug]
  );

  if (seoResult.rows.length === 0) {
    const redirect = await pool.query(
      'SELECT ruta_nueva FROM redirecciones_301 WHERE ruta_antigua = $1',
      [req.path]
    );
    if (redirect.rows.length) {
      return res.redirect(301, redirect.rows[0].ruta_nueva);
    }
    return res.status(404).send('Página no encontrada');
  }

  const seo = seoResult.rows[0];

  // Precios disponibles para esta ruta (categorías disponibles con precio cargado)
  const precios = await pool.query(
    `SELECT cv.nombre, cv.capacidad_pasajeros, cv.capacidad_maletas, rp.precio
     FROM rutas_precios rp
     JOIN categorias_vehiculos cv ON cv.id = rp.categoria_id
     WHERE rp.ruta_id = $1 AND cv.disponible = TRUE
     ORDER BY cv.orden, cv.nombre`,
    [seo.ruta_id]
  );

  // Todas las versiones de idioma activas de esta ruta (para hreflang)
  const alternates = await pool.query(
    `SELECT lang_code, slug_url FROM route_seo_settings
     WHERE route_id = $1 AND activo = TRUE`,
    [seo.ruta_id]
  );

  const ajustesGlobales = await pool.query('SELECT * FROM ajustes_seo_globales WHERE id = 1');
  const globales = ajustesGlobales.rows[0] || { nombre_marca: 'Traslados · GC', imagen_og_defecto: null, twitter_activo: false };
  const nombreMarca = globales.nombre_marca || 'Traslados · GC';

  // Otras rutas activas desde el mismo origen, en el mismo idioma — para el
  // enlazado interno al final de la página ("otros traslados desde...")
  const relacionadas = await pool.query(
    `SELECT r.destino, rss.slug_url
     FROM rutas r
     JOIN route_seo_settings rss ON rss.route_id = r.id
     WHERE r.origen = $1 AND r.id != $2 AND r.activa = TRUE
       AND rss.lang_code = $3 AND rss.activo = TRUE
     ORDER BY RANDOM()
     LIMIT 4`,
    [seo.origen, seo.ruta_id, lang]
  );

  const { schemaTaxiService, schemaBreadcrumb } = construirSchemaRuta(
    seo, precios.rows, nombreMarca, globales, BASE_URL, BASE_URL + req.path
  );

  // Función de traducción de textos fijos de la interfaz, ligada al idioma de esta página
  const t = function (clave) { return obtenerTexto(clave, lang); };

  res.render('traslado', {
    seo,
    precios: precios.rows,
    alternates: alternates.rows,
    relacionadas: relacionadas.rows,
    t,
    lang,
    BASE_URL,
    SECCIONES_TRASLADO,
    nombreMarca,
    tieneImagenDefecto: !!globales.imagen_og_defecto,
    twitterActivo: !!globales.twitter_activo,
    schemaTaxiService,
    schemaBreadcrumb
  });
}));

// ─── Arranque ─────────────────────────────────────────────────────────────────
initSchema()
  .then(function () {
    app.listen(PORT, function () {
      console.log('Traslados GC escuchando en el puerto ' + PORT);
    });
  })
  .catch(function (err) {
    console.error('Error preparando la base de datos:', err);
    process.exit(1);
  });
