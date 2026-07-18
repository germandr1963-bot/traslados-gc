const express = require('express');
const Stripe = require('stripe');
const { Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel, VerticalAlignSection } = require('docx');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const { medirPxTitulo, medirPxDescripcion } = require('./medidor-pixeles');
const fs = require('fs');
const os = require('os');
const PDFDocument = require('pdfkit');

const app = express();

// ─── Stripe ───────────────────────────────────────────────────────────────────
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

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
      from: 'Traslados GC <noreply@traslados-gc.es>',
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

async function enviarEmailConAdjunto({ to, subject, html, adjunto }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('Email no configurado — falta RESEND_API_KEY');
    return false;
  }
  const body = {
    from: 'Traslados GC <noreply@traslados-gc.es>',
    to: [to],
    subject: subject,
    html: html
  };
  if (adjunto) {
    body.attachments = [{
      filename: adjunto.filename,
      content: Buffer.isBuffer(adjunto.content)
        ? adjunto.content.toString('base64')
        : adjunto.content
    }];
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error('Resend error ' + response.status + ': ' + error);
  }
  return true;
}

// Genera un email con el mismo estilo visual que el de confirmación de
// reserva, para avisos cortos de una sola línea (sin respuesta, cancelación).
// ─── Plantilla corporativa universal para todos los emails ────────────────────
// Usar siempre esta función — nunca HTML inline con cabecera/pie propios.
// contenidoHtml: el cuerpo del email (sin cabecera ni pie).
function plantillaEmail(contenidoHtml) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <style>
    body{margin:0;padding:0;background:#f5f5f5;}
    .wrapper{max-width:600px;margin:0 auto;background:#fff;}
    .header{background:#2c2c2c;padding:24px;text-align:center;}
    .body{padding:28px 24px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:15px;color:#1C1815;line-height:1.6;}
    .footer{background:#f5f0ea;padding:16px;text-align:center;font-size:12px;color:#888;}
    .pnr{font-family:monospace;font-size:20px;font-weight:700;color:#C1502E;letter-spacing:3px;}
    .info-box{background:#f5f0ea;border-radius:8px;padding:14px 18px;font-size:14px;line-height:1.8;margin:16px 0;}
    .caja-verde{background:#d1e7dd;border-radius:6px;padding:10px 16px;margin:16px 0;color:#0f5132;font-size:13px;}
    .caja-amarilla{background:#fff3cd;border-radius:6px;padding:10px 14px;margin:14px 0;font-size:12px;color:#856404;}
    .caja-roja{background:#fdecea;border:1px solid #f5b8b8;border-radius:8px;padding:16px 20px;margin:16px 0;color:#7a1e1e;}
    .boton{display:inline-block;background:#C1502E;color:#fff;padding:13px 30px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;}
    blockquote{border-left:3px solid #C1502E;padding-left:12px;color:#333;margin:16px 0;}
    @media(max-width:480px){.body{padding:16px;}}
  </style></head><body>
  <div class="wrapper">
    <div class="header">
      <h1 style="color:#d4956a;margin:0;font-size:20px;">Traslados GC</h1>
      <p style="color:#aaa;margin:4px 0 0;font-size:12px;">Gran Canaria</p>
    </div>
    <div class="body">${contenidoHtml}</div>
    <div class="footer">Traslados GC · Gran Canaria</div>
  </div></body></html>`;
}

// Alias para compatibilidad con llamadas existentes
function plantillaEmailSimple(nombreCliente, mensaje, numeroReserva) {
  return plantillaEmail(
    `<p>Hola <strong>${nombreCliente}</strong>,</p>
     <p>${mensaje}</p>
     <p style="font-size:13px;color:#888;">Número de reserva: <span class="pnr">${numeroReserva}</span></p>`
  );
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

// El webhook de Stripe necesita el body sin parsear — va ANTES del JSON middleware
app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.set('trust proxy', 1);
app.use(session({
  store: new pgSession({ pool: pool, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'cambia-este-secreto',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8, secure: true, sameSite: 'lax' }
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

// Firma para enlaces de descarga del cartel sin necesidad de login (usada por WhatsApp)
function firmarCartel(reservaId) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET || 'cambia-este-secreto')
    .update(String(reservaId)).digest('hex').slice(0, 20);
}

function firmarVoucher(reservaId) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET || 'cambia-este-secreto')
    .update('voucher-' + String(reservaId)).digest('hex').slice(0, 20);
}

async function generarCodigoCorto(tipo, reservaId, tokenValoracion, urlDestino) {
  let codigo = crypto.randomBytes(3).toString('hex');
  try {
    await pool.query(
      'INSERT INTO url_cortas (codigo, tipo, reserva_id, token_valoracion, url_destino) VALUES ($1, $2, $3, $4, $5)',
      [codigo, tipo, reservaId || null, tokenValoracion || null, urlDestino || null]
    );
  } catch(e) {
    codigo = crypto.randomBytes(4).toString('hex');
    await pool.query(
      'INSERT INTO url_cortas (codigo, tipo, reserva_id, token_valoracion, url_destino) VALUES ($1, $2, $3, $4, $5)',
      [codigo, tipo, reservaId || null, tokenValoracion || null, urlDestino || null]
    );
  }
  return codigo;
}

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

function requireChofer(req, res, next) {
  if (req.session && req.session.choferId) {
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

  await pool.query(`
    ALTER TABLE categorias_vehiculos
      ALTER COLUMN capacidad_maletas DROP DEFAULT,
      ALTER COLUMN capacidad_maletas TYPE TEXT USING capacidad_maletas::TEXT,
      ALTER COLUMN capacidad_maletas SET DEFAULT '2',
      ADD COLUMN IF NOT EXISTS descripcion TEXT,
      ADD COLUMN IF NOT EXISTS limite_sillas INT DEFAULT 0,
      ADD COLUMN IF NOT EXISTS disponible BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS bajada_diurna NUMERIC(10,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS bajada_nocturna NUMERIC(10,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS foto TEXT
  `);

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
  await pool.query(`
    ALTER TABLE rutas
      ADD COLUMN IF NOT EXISTS sitemap_prioridad NUMERIC(2,1) DEFAULT 0.8,
      ADD COLUMN IF NOT EXISTS sitemap_frecuencia VARCHAR(20) DEFAULT 'monthly',
      ADD COLUMN IF NOT EXISTS imagen_og TEXT
  `);

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

  // Columna observaciones en conductores: campo libre para notas del registro web.
  await pool.query(`ALTER TABLE conductores ADD COLUMN IF NOT EXISTS observaciones TEXT DEFAULT ''`);

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
    { clave: 'badge_precio_fijo', modulo: 'Página de ruta', contexto: 'Etiqueta pequeña junto al precio estimado', es: 'precio aproximado', en: 'estimated price' },
    { clave: 'texto_a_consultar', modulo: 'Página de ruta', contexto: 'Texto que sustituye al precio cuando esa categoría aún no tiene precio cargado', es: 'A consultar', en: 'On request' },
    { clave: 'texto_consulta_disponibilidad', modulo: 'Página de ruta', contexto: 'Párrafo que se muestra si la ruta todavía no tiene ningún precio cargado', es: 'Consulta disponibilidad y precio para este traslado.', en: 'Check availability and price for this transfer.' },
    { clave: 'titulo_como_funciona', modulo: 'Página de ruta', contexto: 'Título de la sección de 3 pasos que explica el proceso de reserva', es: 'Cómo funciona', en: 'How it works' },
    { clave: 'paso1_titulo', modulo: 'Página de ruta', contexto: 'Título del paso 1 en la sección "Cómo funciona"', es: '1. Reserva', en: '1. Booking' },
    { clave: 'paso1_texto', modulo: 'Página de ruta', contexto: 'Descripción del paso 1 en la sección "Cómo funciona"', es: 'Solicitas el traslado con tu ruta y categoría de vehículo. Ves el precio aproximado antes de confirmar.', en: 'Request your transfer with your route and vehicle category. See the estimated price before confirming.' },
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

  // ─── Textos de email de cotización (traducibles desde Idiomas) ───────────
  const TEXTOS_EMAIL_COTIZACION = [
    { clave: 'email_cotiz_asunto_positivo',   modulo: 'Email cotización', contexto: 'Asunto del email de respuesta positiva a una cotización', es: 'Tu traslado en Gran Canaria — precios disponibles' },
    { clave: 'email_cotiz_asunto_negativo',   modulo: 'Email cotización', contexto: 'Asunto del email de respuesta negativa a una cotización', es: 'Tu solicitud de traslado' },
    { clave: 'email_cotiz_saludo',            modulo: 'Email cotización', contexto: 'Saludo inicial del email de cotización', es: 'Hola,' },
    { clave: 'email_cotiz_positivo_p1',       modulo: 'Email cotización', contexto: 'Primer párrafo del email positivo', es: 'Tenemos buenas noticias. Podemos asumir tu traslado.' },
    { clave: 'email_cotiz_positivo_p2',       modulo: 'Email cotización', contexto: 'Segundo párrafo del email positivo, antes de la tabla de precios', es: 'Aquí tienes los precios disponibles para tu ruta:' },
    { clave: 'email_cotiz_positivo_p3',       modulo: 'Email cotización', contexto: 'Párrafo antes del botón de reserva', es: 'Pulsa el botón para ver todos los detalles y hacer tu reserva.' },
    { clave: 'email_cotiz_boton_reservar',    modulo: 'Email cotización', contexto: 'Texto del botón de reserva en el email positivo', es: 'Ver ruta y reservar' },
    { clave: 'email_cotiz_nota_precio',       modulo: 'Email cotización', contexto: 'Nota final sobre el precio estimado en el email positivo', es: 'El precio es una estimación basada en los km de distancia. El precio final es lo que marca el taxímetro. El cobro lo realiza el conductor directamente.' },
    { clave: 'email_cotiz_negativo_p1',       modulo: 'Email cotización', contexto: 'Primer párrafo del email negativo', es: 'Gracias por contactar con Traslados GC.' },
    { clave: 'email_cotiz_negativo_p2',       modulo: 'Email cotización', contexto: 'Segundo párrafo del email negativo, antes de mostrar la ruta', es: 'Lamentablemente, en este momento no podemos asumir el traslado que nos solicitaste:' },
    { clave: 'email_cotiz_negativo_p3',       modulo: 'Email cotización', contexto: 'Párrafo final del email negativo', es: 'Si tienes otras necesidades de transporte en Gran Canaria, no dudes en contactarnos.' },
    { clave: 'email_cotiz_despedida',         modulo: 'Email cotización', contexto: 'Despedida final de todos los emails de cotización', es: 'Un saludo, el equipo de Traslados GC' },
    { clave: 'email_cotiz_col_categoria',     modulo: 'Email cotización', contexto: 'Cabecera de columna Categoría en la tabla de precios del email', es: 'Categoría' },
    { clave: 'email_cotiz_col_capacidad',     modulo: 'Email cotización', contexto: 'Cabecera de columna Capacidad en la tabla de precios del email', es: 'Capacidad' },
    { clave: 'email_cotiz_col_precio',        modulo: 'Email cotización', contexto: 'Cabecera de columna Precio en la tabla de precios del email', es: 'Precio est.' },
  ];

  for (const t of TEXTOS_EMAIL_COTIZACION) {
    await pool.query(
      `INSERT INTO textos_interfaz (clave, modulo, contexto, texto_es)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (clave) DO UPDATE SET modulo = $2, contexto = $3, texto_es = $4`,
      [t.clave, t.modulo, t.contexto, t.es]
    );
  }

  // Sincronizar nombres de categorías activas como textos traducibles
  const catsActivas = await pool.query('SELECT id, nombre FROM categorias_vehiculos WHERE activa = TRUE ORDER BY orden, nombre');
  for (const cat of catsActivas.rows) {
    const clave = 'categoria_nombre_' + cat.id;
    await pool.query(
      `INSERT INTO textos_interfaz (clave, modulo, contexto, texto_es)
       VALUES ($1, 'Categorías de vehículo', $2, $3)
       ON CONFLICT (clave) DO UPDATE SET texto_es = $3`,
      [clave, 'Nombre de la categoría "' + cat.nombre + '" tal como aparece en emails y páginas públicas', cat.nombre]
    );
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

  // ─── Configuración No-Show ───────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS configuracion_noshow (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL DEFAULT 'General',
      es_general BOOLEAN DEFAULT FALSE,
      fecha_inicio DATE,
      fecha_fin DATE,
      importe_deposito NUMERIC(10,2) NOT NULL DEFAULT 10.00,
      horas_cancelacion INT NOT NULL DEFAULT 12,
      activa BOOLEAN DEFAULT TRUE,
      creado_en TIMESTAMP DEFAULT NOW()
    );
  `);

  // Insertar configuración general si no existe
  await pool.query(`
    INSERT INTO configuracion_noshow (nombre, es_general, importe_deposito, horas_cancelacion)
    SELECT 'General', TRUE, 10.00, 12
    WHERE NOT EXISTS (SELECT 1 FROM configuracion_noshow WHERE es_general = TRUE)
  `);

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

  await pool.query(`ALTER TABLE cotizaciones ADD COLUMN IF NOT EXISTS lang_cliente VARCHAR(10) DEFAULT 'es'`);

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
  await pool.query(`ALTER TABLE extras ADD COLUMN IF NOT EXISTS bloque TEXT DEFAULT 'F'`);
  await pool.query(`ALTER TABLE extras ADD COLUMN IF NOT EXISTS orden INT DEFAULT 0`);
  await pool.query(`ALTER TABLE extras ADD COLUMN IF NOT EXISTS tipo_seleccion TEXT DEFAULT 'checkbox'`);
  await pool.query(`ALTER TABLE extras ADD COLUMN IF NOT EXISTS notas_chofer TEXT`);
  await pool.query(`ALTER TABLE extras ADD COLUMN IF NOT EXISTS depende_chofer BOOLEAN DEFAULT TRUE`);
  // Corrección: este extra no depende de lo que tenga el chofer, es solo un
  // aviso del cliente. Se corrige aquí por si ya se había desplegado antes.
  await pool.query(`UPDATE extras SET depende_chofer = FALSE WHERE nombre = 'Traigo mi propio asiento de seguridad'`);

  // Dos extras de ejemplo (solo se insertan si la tabla está vacía)
  await pool.query(`
    INSERT INTO extras (nombre, precio)
    SELECT * FROM (VALUES
      ('Silla de seguridad para niños', 5.00),
      ('Transporte de bicicleta', 10.00)
    ) AS v(nombre, precio)
    WHERE NOT EXISTS (SELECT 1 FROM extras LIMIT 1);
  `);

  // Catálogo de extras por bloques (A-F). Solo se insertan los que no existan
  // ya por nombre, así que es seguro volver a desplegar sin duplicar nada.
  await pool.query(`
    INSERT INTO extras (nombre, bloque, orden, tipo_seleccion, notas_chofer, precio, activo, depende_chofer)
    SELECT v.nombre, v.bloque, v.orden, v.tipo_seleccion, v.notas_chofer, 0, FALSE, v.depende_chofer
    FROM (VALUES
      ('Traigo mi propio asiento de seguridad', 'A', 1, 'contador', 'El conductor solo espera a que el cliente lo instale', FALSE),
      ('Silla bebé — hasta 13 kg (menores de 1 año)', 'A', 2, 'contador', 'Grupo 0 homologado', TRUE),
      ('Silla infantil — 9 a 18 kg (hasta 4 años)', 'A', 3, 'contador', 'Grupo 1-2 homologado', TRUE),
      ('Silla infantil — 15 a 25 kg (4 a 7 años)', 'A', 4, 'contador', 'Grupo 2-3 homologado', TRUE),
      ('Alzador/Booster — 22 a 36 kg (6 a 12 años)', 'A', 5, 'contador', 'Grupo 3 homologado', TRUE),
      ('Mascota pequeña en transportín', 'B', 1, 'checkbox', 'Gato, perro pequeño, conejo...', TRUE),
      ('Mascota grande con arnés homologado', 'B', 2, 'checkbox', 'Perro mediano o grande', TRUE),
      ('Perro guía', 'B', 3, 'checkbox', 'Puede viajar suelto/con arnés junto al pasajero', TRUE),
      ('Tabla de surf / bodyboard', 'C', 1, 'checkbox', 'Habitual en playas de Gran Canaria y Tenerife', TRUE),
      ('Tabla de windsurf / kitesurf', 'C', 2, 'checkbox', 'Medidas grandes — solo Minivan', TRUE),
      ('Bicicleta', 'C', 3, 'checkbox', 'Solo Minivan con espacio habilitado', TRUE),
      ('Patinete eléctrico plegable', 'C', 4, 'checkbox', 'Cabe en la mayoría de vehículos', TRUE),
      ('Esquís / Snowboard', 'C', 5, 'checkbox', 'Solo Confort y Minivan', TRUE),
      ('Bolsa de palos de golf', 'C', 6, 'checkbox', 'Muy frecuente en el sur de Gran Canaria', TRUE),
      ('Equipo de buceo (botellas y aletas)', 'C', 7, 'checkbox', 'Habitual en zonas costeras', TRUE),
      ('Maleta extra grande adicional', 'D', 1, 'checkbox', 'Más allá de la que corresponde por plaza', TRUE),
      ('Bulto voluminoso', 'D', 2, 'checkbox', 'Caja grande, árbol, mueble pequeño... a criterio del conductor', TRUE),
      ('Carrito de bebé plegable', 'D', 3, 'checkbox', 'Generalmente incluido sin coste', TRUE),
      ('Silla de ruedas plegable (manual)', 'D', 4, 'checkbox', 'Ver también Bloque E', TRUE),
      ('Instrumento musical grande', 'D', 5, 'checkbox', 'Guitarra, violonchelo, etc. — a criterio del conductor', TRUE),
      ('Viajo con silla de ruedas manual', 'E', 1, 'checkbox', 'El conductor ayuda a plegar y cargar', TRUE),
      ('Viajo con silla de ruedas eléctrica', 'E', 2, 'checkbox', 'Requiere furgoneta adaptada con rampa', TRUE),
      ('Necesito asistencia para subir/bajar del vehículo', 'E', 3, 'checkbox', 'Sin silla, pero con dificultad de movilidad', TRUE),
      ('Viajo con andador o muletas', 'E', 4, 'checkbox', 'Espacio adicional para el accesorio', TRUE),
      ('Agua embotellada a bordo', 'F', 1, 'checkbox', 'Muy valorado en rutas largas y aeropuerto', TRUE),
      ('Cargador de móvil disponible', 'F', 2, 'checkbox', 'USB / USB-C', TRUE),
      ('WiFi a bordo', 'F', 3, 'checkbox', 'El conductor indica si dispone de él', TRUE),
      ('Aire acondicionado garantizado', 'F', 4, 'checkbox', 'Importante en el verano canario', TRUE),
      ('Viaje en silencio (sin conversación)', 'F', 5, 'checkbox', 'Muy solicitado en traslados nocturnos', TRUE),
      ('Conductor con letrero en llegadas', 'F', 6, 'checkbox', 'Para recogidas en aeropuerto o puerto', TRUE),
      ('Seguimiento de vuelo — espero si hay retraso', 'F', 7, 'checkbox', 'Sin coste adicional por retraso', TRUE),
      ('Recogida en puerto / muelle (cruceros)', 'F', 8, 'checkbox', 'Muy relevante en Las Palmas y Arrecife', TRUE),
      ('Nevera/refrigeración a bordo', 'F', 9, 'checkbox', 'Para alimentos o medicinas que requieren frío', TRUE)
    ) AS v(nombre, bloque, orden, tipo_seleccion, notas_chofer, depende_chofer)
    WHERE NOT EXISTS (SELECT 1 FROM extras e WHERE e.nombre = v.nombre);
  `);

  // ─── Avisos de reserva (Grupo B: información pura, sin precio, el chofer ──
  // no decide nada, solo se entera). Distinto de "extras": no filtra choferes.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS avisos_reserva (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      nota_interna TEXT,
      orden INT DEFAULT 0,
      activo BOOLEAN DEFAULT TRUE,
      creado_en TIMESTAMP DEFAULT NOW()
    );
  `);

  // Avisos de ejemplo ya acordados. Solo se insertan los que no existan ya
  // por nombre, así que es seguro volver a desplegar sin duplicar nada.
  await pool.query(`
    INSERT INTO avisos_reserva (nombre, nota_interna, orden, activo)
    SELECT v.nombre, v.nota_interna, v.orden, FALSE
    FROM (VALUES
      ('Soy ciego', 'Ayuda mínima al subir/bajar del vehículo', 1),
      ('Soy mudo, pero puedo oír', '', 2),
      ('Solo puedo comunicarme por texto', '', 3)
    ) AS v(nombre, nota_interna, orden)
    WHERE NOT EXISTS (SELECT 1 FROM avisos_reserva a WHERE a.nombre = v.nombre);
  `);

  // ─── Preferencias del pasajero (Grupo G — siempre gratuitas) ───────────────
  // El cliente las marca en su perfil; el chofer las ve al aceptar el viaje.
  // No filtran choferes ni requieren equipamiento (eso sería un Extra).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS preferencias_catalogo (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      opciones TEXT NOT NULL,
      orden INT DEFAULT 0,
      activo BOOLEAN DEFAULT TRUE,
      creado_en TIMESTAMP DEFAULT NOW()
    );
  `);

  // Migración única a los textos definitivos con iconos (solo actúa si la
  // preferencia aún tiene el texto antiguo, para no pisar ediciones del admin)
  await pool.query(`UPDATE preferencias_catalogo SET opciones = '❄️ Fresco (20–21 °C · 68–70 °F) / 🍃 Normal (22–23 °C · 71–74 °F) / 🔥 Cálido (24–25 °C · 75–77 °F) / ⚙️ Otra (Especificar)' WHERE nombre = 'Temperatura en el vehículo' AND opciones = 'Fresco / Normal / Caliente'`);
  await pool.query(`UPDATE preferencias_catalogo SET nombre = 'Ambiente musical', opciones = '🔇 Viajar en silencio / 🎵 Música suave de fondo / 📻 Lo que el conductor prefiera / 🎸 Prefiero poner mi propia música' WHERE nombre = 'Música'`);
  await pool.query(`UPDATE preferencias_catalogo SET opciones = '🤫 Prefiero viajar en silencio y descansar / 💬 Abierto a conversar / 🤷‍♂️ Sin preferencia · Lo que surja' WHERE nombre = 'Conversación' AND opciones = 'Viaje en silencio / Conversación bienvenida / Sin preferencia'`);
  await pool.query(`UPDATE preferencias_catalogo SET opciones = '🐢 Conducción suave y relajada / ⚡ Eficiente y ágil (respetando las normas) / 🤷‍♂️ Sin preferencia' WHERE nombre = 'Estilo de conducción' AND opciones = 'Tranquila / Normal / Sin preferencia'`);
  await pool.query(`UPDATE preferencias_catalogo SET nombre = 'Sensibilidad al movimiento', opciones = '🤢 Me mareo con facilidad (Conducción extra suave) / 👍 No suelo marearme' WHERE nombre = 'Me mareo con facilidad'`);
  await pool.query(`UPDATE preferencias_catalogo SET opciones = '🧳 Sí, llevo equipaje y agradecería ayuda / 🎒 No es necesario, viajo ligero' WHERE nombre = 'Ayuda con el equipaje' AND opciones = 'Sí, lo agradezco / No hace falta'`);
  await pool.query(`UPDATE preferencias_catalogo SET nombre = 'Inicio del trayecto', opciones = '⏱️ Necesito un momento para acomodarme antes de arrancar / 🚗 Listo para arrancar de inmediato' WHERE nombre = 'Necesito un momento para acomodarme antes de arrancar'`);

  // Preferencias acordadas. Solo se insertan las que no existan ya
  // por nombre, así que es seguro volver a desplegar sin duplicar nada.
  await pool.query(`
    INSERT INTO preferencias_catalogo (nombre, opciones, orden, activo)
    SELECT v.nombre, v.opciones, v.orden, FALSE
    FROM (VALUES
      ('Temperatura en el vehículo', '❄️ Fresco (20–21 °C · 68–70 °F) / 🍃 Normal (22–23 °C · 71–74 °F) / 🔥 Cálido (24–25 °C · 75–77 °F) / ⚙️ Otra (Especificar)', 1),
      ('Ambiente musical', '🔇 Viajar en silencio / 🎵 Música suave de fondo / 📻 Lo que el conductor prefiera / 🎸 Prefiero poner mi propia música', 2),
      ('Conversación', '🤫 Prefiero viajar en silencio y descansar / 💬 Abierto a conversar / 🤷‍♂️ Sin preferencia · Lo que surja', 3),
      ('Estilo de conducción', '🐢 Conducción suave y relajada / ⚡ Eficiente y ágil (respetando las normas) / 🤷‍♂️ Sin preferencia', 4),
      ('Sensibilidad al movimiento', '🤢 Me mareo con facilidad (Conducción extra suave) / 👍 No suelo marearme', 5),
      ('Ayuda con el equipaje', '🧳 Sí, llevo equipaje y agradecería ayuda / 🎒 No es necesario, viajo ligero', 6),
      ('Inicio del trayecto', '⏱️ Necesito un momento para acomodarme antes de arrancar / 🚗 Listo para arrancar de inmediato', 7)
    ) AS v(nombre, opciones, orden)
    WHERE NOT EXISTS (SELECT 1 FROM preferencias_catalogo p WHERE p.nombre = v.nombre);
  `);

  // Preferencias elegidas por cada cliente (anclado a su email, que es su
  // identidad entre reservas) y sugerencias de preferencias nuevas que envía
  // el cliente para que el admin las apruebe o no.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS preferencias_cliente (
      id SERIAL PRIMARY KEY,
      email_cliente TEXT NOT NULL,
      preferencia_id INT NOT NULL REFERENCES preferencias_catalogo(id) ON DELETE CASCADE,
      opcion TEXT NOT NULL,
      detalle TEXT,
      actualizado_en TIMESTAMP DEFAULT NOW(),
      UNIQUE (email_cliente, preferencia_id)
    );
  `);
  await pool.query(`ALTER TABLE preferencias_cliente ADD COLUMN IF NOT EXISTS detalle TEXT`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS preferencias_sugerencias (
      id SERIAL PRIMARY KEY,
      email_cliente TEXT,
      texto TEXT NOT NULL,
      estado TEXT DEFAULT 'pendiente',
      creado_en TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS preferencias_visibilidad_cliente (
      email_cliente TEXT PRIMARY KEY,
      visibles BOOLEAN DEFAULT TRUE,
      actualizado_en TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS preferencias_reserva (
      id SERIAL PRIMARY KEY,
      reserva_id INT NOT NULL REFERENCES reservas(id) ON DELETE CASCADE,
      nombre TEXT NOT NULL,
      opcion TEXT NOT NULL,
      detalle TEXT
    );
  `);

  // Datos propios del cliente (editables desde "Mis datos" en su portal).
  // Tienen prioridad sobre los datos de su última reserva y alimentan el
  // autorrelleno del formulario. Las reservas ya hechas no se reescriben.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clientes_datos (
      email_cliente TEXT PRIMARY KEY,
      nombre TEXT,
      telefono TEXT,
      password_hash TEXT,
      actualizado_en TIMESTAMP DEFAULT NOW()
    );
  `);

  // ─── Decisión del chofer sobre cada extra (No lo ofrezco / Gratis / Pago) ──
  // No existe fila = el chofer aún no lo ha revisado (queda "pendiente" en su
  // portal). En cuanto guarda una decisión sobre un extra, se crea la fila.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conductor_extras (
      id SERIAL PRIMARY KEY,
      conductor_id INT NOT NULL REFERENCES conductores(id) ON DELETE CASCADE,
      extra_id INT NOT NULL REFERENCES extras(id) ON DELETE CASCADE,
      estado TEXT NOT NULL DEFAULT 'no_ofrece' CHECK (estado IN ('no_ofrece', 'gratis', 'pago')),
      actualizado_en TIMESTAMP DEFAULT NOW(),
      UNIQUE (conductor_id, extra_id)
    );
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
  await pool.query(`
    ALTER TABLE reservas
      ADD COLUMN IF NOT EXISTS conductor_id INT REFERENCES conductores(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS archivada BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS origen TEXT,
      ADD COLUMN IF NOT EXISTS destino TEXT,
      ADD COLUMN IF NOT EXISTS tipo_llegada TEXT,
      ADD COLUMN IF NOT EXISTS numero_vuelo TEXT,
      ADD COLUMN IF NOT EXISTS hora_llegada_vuelo TIME,
      ADD COLUMN IF NOT EXISTS nombre_barco TEXT,
      ADD COLUMN IF NOT EXISTS hora_atraque TIME,
      ADD COLUMN IF NOT EXISTS num_pasajeros INT,
      ADD COLUMN IF NOT EXISTS direccion_recogida TEXT,
      ADD COLUMN IF NOT EXISTS direccion_destino TEXT,
      ADD COLUMN IF NOT EXISTS notas_cliente TEXT,
      ADD COLUMN IF NOT EXISTS pasaporte_dni TEXT,
      ADD COLUMN IF NOT EXISTS es_para_otra_persona BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS nombre_pasajero_otro TEXT,
      ADD COLUMN IF NOT EXISTS telefono_pasajero_otro TEXT,
      ADD COLUMN IF NOT EXISTS email_pasajero_otro TEXT
  `);

  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS email_confirmacion_enviado BOOLEAN DEFAULT FALSE`);

  // Historial de cambios de chofer
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reservas_historial_chofer (
      id SERIAL PRIMARY KEY,
      reserva_id INT NOT NULL REFERENCES reservas(id) ON DELETE CASCADE,
      conductor_id INT REFERENCES conductores(id) ON DELETE SET NULL,
      motivo TEXT,
      creado_en TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS stripe_session_id TEXT`);
  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS deposito_pagado BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS email_voucher_enviado BOOLEAN DEFAULT FALSE`);

  // ─── Portal del cliente ───────────────────────────────────────────────────
  await pool.query(`ALTER TABLE clientes_datos ADD COLUMN IF NOT EXISTS password_hash TEXT`);
  await pool.query(`ALTER TABLE clientes_datos ADD COLUMN IF NOT EXISTS idioma VARCHAR(5) DEFAULT 'es'`);
  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS cliente_password_hash TEXT`);
  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS cliente_primer_acceso BOOLEAN DEFAULT TRUE`);
  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS deposito_liberado BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS deposito_devolucion_pendiente BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS deposito_retenido_noshow BOOLEAN DEFAULT FALSE`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_mensajes_pendientes (
      id SERIAL PRIMARY KEY,
      telefono TEXT NOT NULL,
      texto TEXT,
      url_documento TEXT,
      nombre_documento TEXT,
      enviado BOOLEAN DEFAULT FALSE,
      creado_en TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE whatsapp_mensajes_pendientes ADD COLUMN IF NOT EXISTS url_documento TEXT`);
  await pool.query(`ALTER TABLE whatsapp_mensajes_pendientes ADD COLUMN IF NOT EXISTS nombre_documento TEXT`);
  await pool.query(`ALTER TABLE whatsapp_mensajes_pendientes ALTER COLUMN texto DROP NOT NULL`);
  await pool.query(`ALTER TABLE whatsapp_mensajes_pendientes ADD COLUMN IF NOT EXISTS documento_base64 TEXT`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reservas_mensajes (
      id SERIAL PRIMARY KEY,
      reserva_id INT NOT NULL REFERENCES reservas(id) ON DELETE CASCADE,
      autor TEXT NOT NULL DEFAULT 'cliente',
      mensaje TEXT NOT NULL,
      leido BOOLEAN DEFAULT FALSE,
      creado_en TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reservas_mensajes_chofer (
      id SERIAL PRIMARY KEY,
      reserva_id INT NOT NULL REFERENCES reservas(id) ON DELETE CASCADE,
      autor TEXT NOT NULL DEFAULT 'admin',
      mensaje TEXT NOT NULL,
      leido BOOLEAN DEFAULT FALSE,
      creado_en TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE reservas_mensajes_chofer ADD COLUMN IF NOT EXISTS leido BOOLEAN DEFAULT FALSE`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS configuracion_facturacion (
      id SERIAL PRIMARY KEY,
      razon_social TEXT DEFAULT '',
      nif TEXT DEFAULT '',
      direccion TEXT DEFAULT '',
      codigo_postal TEXT DEFAULT '',
      ciudad TEXT DEFAULT '',
      email TEXT DEFAULT '',
      telefono TEXT DEFAULT '',
      contador_facturas INT DEFAULT 0,
      actualizado_en TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    INSERT INTO configuracion_facturacion (id)
    SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM configuracion_facturacion WHERE id = 1)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS facturas (
      id SERIAL PRIMARY KEY,
      reserva_id INT NOT NULL REFERENCES reservas(id) ON DELETE CASCADE,
      numero_factura TEXT NOT NULL,
      importe_total NUMERIC(10,2),
      generada_en TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS factura_conceptos_extra (
      id SERIAL PRIMARY KEY,
      factura_id INT NOT NULL REFERENCES facturas(id) ON DELETE CASCADE,
      descripcion TEXT NOT NULL,
      importe NUMERIC(10,2) NOT NULL,
      creado_en TIMESTAMP DEFAULT NOW()
    );
  `);

  // Configuración de contacto público
  await pool.query(`
    CREATE TABLE IF NOT EXISTS configuracion_contacto (
      id SERIAL PRIMARY KEY,
      telefono TEXT,
      whatsapp TEXT,
      email TEXT,
      direccion TEXT,
      horario TEXT,
      actualizado_en TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    INSERT INTO configuracion_contacto (id, telefono, whatsapp, email)
    SELECT 1, '', '', ''
    WHERE NOT EXISTS (SELECT 1 FROM configuracion_contacto WHERE id = 1)
  `);
  await pool.query(`ALTER TABLE configuracion_contacto ADD COLUMN IF NOT EXISTS emails_notificacion TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE configuracion_contacto ADD COLUMN IF NOT EXISTS wa_grupo_choferes TEXT DEFAULT ''`);

  // Enlaces de recuperación de contraseña (clientes y choferes)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tokens_recuperacion (
      id SERIAL PRIMARY KEY,
      tipo TEXT NOT NULL,
      referencia_id INT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      usado BOOLEAN DEFAULT FALSE,
      expira_en TIMESTAMP NOT NULL,
      creado_en TIMESTAMP DEFAULT NOW()
    );
  `);

  // ─── Reservas × Extras ────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reservas_extras (
      id SERIAL PRIMARY KEY,
      reserva_id INT NOT NULL REFERENCES reservas(id) ON DELETE CASCADE,
      extra_id INT NOT NULL REFERENCES extras(id) ON DELETE RESTRICT,
      precio_en_reserva NUMERIC(10,2) NOT NULL
    );
  `);

  // ─── URLs cortas para WhatsApp ────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS url_cortas (
      id SERIAL PRIMARY KEY,
      codigo TEXT NOT NULL UNIQUE,
      token_valoracion TEXT,
      tipo TEXT DEFAULT 'valoracion',
      reserva_id INTEGER,
      creado_en TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE url_cortas ADD COLUMN IF NOT EXISTS tipo TEXT DEFAULT 'valoracion'`);
  await pool.query(`ALTER TABLE url_cortas ADD COLUMN IF NOT EXISTS reserva_id INTEGER`);
  await pool.query(`ALTER TABLE url_cortas ALTER COLUMN token_valoracion DROP NOT NULL`);
  await pool.query(`ALTER TABLE url_cortas ADD COLUMN IF NOT EXISTS url_destino TEXT`);

  // ─── Imágenes de WhatsApp ──────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_imagenes (
      tipo TEXT PRIMARY KEY,
      imagen BYTEA NOT NULL,
      tipo_mime TEXT NOT NULL DEFAULT 'image/png',
      actualizado_en TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ─── Valoraciones ─────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS valoraciones (
      id SERIAL PRIMARY KEY,
      reserva_id INTEGER UNIQUE REFERENCES reservas(id) ON DELETE CASCADE,
      estrellas_conductor INTEGER CHECK (estrellas_conductor BETWEEN 1 AND 5),
      estrellas_servicio INTEGER CHECK (estrellas_servicio BETWEEN 1 AND 5),
      comentario TEXT,
      creado_en TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS token_valoracion TEXT UNIQUE`);
  await pool.query(`ALTER TABLE reservas ADD COLUMN IF NOT EXISTS completada_en TIMESTAMPTZ`);

  // \u2500\u2500\u2500 Tabla de plantillas de comunicaci\u00f3n \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  await pool.query(`
    CREATE TABLE IF NOT EXISTS plantillas_comunicacion (
      id SERIAL PRIMARY KEY,
      clave TEXT UNIQUE NOT NULL,
      nombre TEXT NOT NULL,
      categoria TEXT NOT NULL CHECK (categoria IN ('cliente','chofer','interno')),
      asunto_email TEXT,
      cuerpo_email TEXT,
      cuerpo_whatsapp TEXT,
      activa BOOLEAN DEFAULT TRUE,
      actualizado_en TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Insertar plantillas base (ON CONFLICT DO NOTHING para no sobreescribir ediciones del admin)
  const plantillasBase = [
    { clave: 'cliente_acuse_recibo', nombre: 'Solicitud recibida (acuse al cliente)', categoria: 'cliente',
      asunto_email: 'Solicitud de traslado recibida \u2014 {numero_reserva}',
      cuerpo_email: `
Hola, <strong>{nombre_cliente}</strong> 👋

📨 Hemos recibido tu solicitud de traslado. Estamos trabajando en ella y en breve recibirás confirmación.

🔖 Tu número de reserva es:
<p style="text-align:center;margin:20px 0;">
  <span class="pnr">{numero_reserva}</span>
</p>
<div class="info-box">
  <strong>Detalles de tu solicitud:</strong><br>
  📍 Origen: {origen}<br>
  🏁 Destino: {destino}<br>
  📅 Fecha: {fecha} · {hora}
</div>
<span style="font-size:13px;color:#888;">💾 Guarda este número — lo necesitarás para consultar el estado de tu reserva. Nos pondremos en contacto contigo a través del WhatsApp o email que nos has facilitado.</span>

<span style="font-size:13px;color:#888;">⏱️ El plazo máximo para confirmarte un conductor es de 15 minutos. Te avisaremos en cuanto tengamos una respuesta.</span>

Un saludo cordial, 🙏
<strong>El equipo de Traslados GC</strong>
`,
      cuerpo_whatsapp: 'Hola, *{nombre_cliente}* 👋\n\n📨 Hemos recibido tu solicitud de traslado. Estamos trabajando en ella y en breve recibirás confirmación.\n\n🔖 *Tu número de reserva es:* {numero_reserva}\n\n📍 *Origen:* {origen}\n🏁 *Destino:* {destino}\n📅 *Fecha:* {fecha} · {hora}\n\n💾 Guarda este número — lo necesitarás para consultar el estado de tu reserva. Nos pondremos en contacto contigo a través del WhatsApp o email que nos has facilitado.\n\n⏱️ El plazo máximo para confirmarte un conductor es de 15 minutos. Te avisaremos en cuanto tengamos una respuesta.\n\nUn saludo cordial, 🙏\n*El equipo de Traslados GC*' },
    { clave: 'cliente_confirmacion', nombre: 'Traslado confirmado (al cliente)', categoria: 'cliente',
      asunto_email: 'Traslado confirmado \u2014 {numero_reserva}',
      cuerpo_email: `
Hola, <strong>{nombre_cliente}</strong> 👋

✅ <strong>¡Tu traslado está confirmado!</strong> Hemos asignado un conductor para tu servicio.
<p style="text-align:center;margin:20px 0;">
  Reserva <span class="pnr">{numero_reserva}</span>
</p>
<div class="info-box">
  <strong>Detalles del traslado:</strong><br>
  📍 Origen: {origen}<br>
  🏁 Destino: {destino}<br>
  📅 Fecha: {fecha} · {hora}<br>
  🚗 Categoría: {categoria}<br>
  {conductor}
</div>
<div class="caja-verde">
  <span style="font-weight:600;">💳 Depósito de garantía — {importe_deposito} €</span><br>
  <span style="font-size:13px;">Para garantizar tu plaza, realiza el pago del depósito de <strong>{importe_deposito} €</strong>. El voucher de tu traslado te llegará automáticamente al confirmar el pago.</span><br>
  <span style="font-size:13px;"><strong>⚠️ Importante:</strong> Si no recibimos el pago {horas_cancelacion} horas antes de tu traslado, la reserva será cancelada.</span><br>
  <span style="font-size:12px;">✔️ El depósito te será devuelto íntegramente una vez completado el servicio.</span><br>
  <span style="font-size:12px;">🗓️ <strong>Cancelación gratuita hasta el {fecha_limite_cancelacion}.</strong> Después de esa fecha, el depósito de {importe_deposito} € no será reembolsable.</span>
</div>
{boton_pago}
<span style="font-size:13px;color:#888;">📲 Nos pondremos en contacto contigo por WhatsApp para coordinar todos los detalles del servicio.</span>

Un saludo cordial, 🙏
<strong>El equipo de Traslados GC</strong>
`,
      cuerpo_whatsapp: 'Hola, *{nombre_cliente}* 👋\n\n✅ *¡Tu traslado está confirmado! Hemos asignado un conductor para tu servicio.*\n\n🔖 *Reserva:* {numero_reserva}\n\n📍 *Origen:* {origen}\n🏁 *Destino:* {destino}\n📅 *Fecha:* {fecha} · {hora}\n🚗 *Categoría:* {categoria}\n\n💳 *Depósito de garantía — {importe_deposito} €*\nPara garantizar tu plaza, realiza el pago del depósito de {importe_deposito} €. El voucher de tu traslado te llegará automáticamente al confirmar el pago.\n\n⚠️ *Importante:* Si no recibimos el pago {horas_cancelacion} horas antes de tu traslado, la reserva será cancelada.\n\n✔️ El depósito te será devuelto íntegramente una vez completado el servicio.\n\n🗓️ *Cancelación gratuita hasta el {fecha_limite_cancelacion}.* Después de esa fecha, el depósito de {importe_deposito} € no será reembolsable.\n\n👉 {url_pago}\n\n📲 Nos pondremos en contacto contigo por WhatsApp para coordinar todos los detalles del servicio.\n\nUn saludo cordial, 🙏\n*El equipo de Traslados GC*' },
    { clave: 'cliente_enlace_pago', nombre: 'Enlace de pago (dep\u00f3sito)', categoria: 'cliente',
      asunto_email: 'Enlace de pago \u2014 Reserva {numero_reserva}',
      cuerpo_email: `
Hola, <strong>{nombre_cliente}</strong> 👋

💳 Te reenviamos el enlace de pago para confirmar tu reserva <strong>{numero_reserva}</strong>.
{boton_pago}
<span style="font-size:13px;color:#888;">❓ Si tienes algún problema con el pago, contacta con nosotros por WhatsApp.</span>

Un saludo cordial, 🙏
<strong>El equipo de Traslados GC</strong>
`,
      cuerpo_whatsapp: 'Hola, *{nombre_cliente}* 👋\n\n💳 Te reenviamos el enlace de pago para confirmar tu reserva *{numero_reserva}*.\n\n👉 {url_pago}\n\n❓ Si tienes algún problema con el pago, contacta con nosotros por WhatsApp.\n\nUn saludo cordial, 🙏\n*El equipo de Traslados GC*' },
    { clave: 'cliente_voucher', nombre: 'Voucher de traslado', categoria: 'cliente',
      asunto_email: '\u2714 Voucher de traslado \u2014 {numero_reserva}',
      cuerpo_email: `
Hola, <strong>{nombre_cliente}</strong> 👋

📄 Adjuntamos el voucher de tu traslado <strong>{numero_reserva}</strong>. Llévalo contigo el día del servicio.

<span style="font-size:13px;color:#888;">❓ Si tienes cualquier duda, no dudes en contactarnos por WhatsApp.</span>

Un saludo cordial, 🙏
<strong>El equipo de Traslados GC</strong>
`,
      cuerpo_whatsapp: 'Hola, *{nombre_cliente}* 👋\n\n📄 Adjuntamos el voucher de tu traslado *{numero_reserva}*. Llévalo contigo el día del servicio.\n\n❓ Si tienes cualquier duda, no dudes en contactarnos por WhatsApp.\n\nUn saludo cordial, 🙏\n*El equipo de Traslados GC*' },
    { clave: 'cliente_cancelacion', nombre: 'Cancelaci\u00f3n de reserva (al cliente)', categoria: 'cliente',
      asunto_email: 'Tu reserva {numero_reserva} ha sido cancelada',
      cuerpo_email: `
Hola, <strong>{nombre_cliente}</strong> 👋

❌ Tu reserva <strong>{numero_reserva}</strong> ha sido cancelada correctamente.
<div class="info-box">
  📍 <strong>Origen:</strong> {origen}<br>
  🏁 <strong>Destino:</strong> {destino}<br>
  📅 <strong>Fecha:</strong> {fecha}
</div>
{aviso_deposito}
❓ Si tienes alguna duda, puedes contactarnos por WhatsApp.

Un saludo cordial, 🙏
<strong>El equipo de Traslados GC</strong>
`,
      cuerpo_whatsapp: 'Hola, *{nombre_cliente}* 👋\n\n❌ Tu reserva *{numero_reserva}* ha sido cancelada correctamente.\n\n📍 *Origen:* {origen}\n🏁 *Destino:* {destino}\n\n{aviso_deposito}\n\n❓ Si tienes alguna duda, puedes contactarnos por WhatsApp.\n\nUn saludo cordial, 🙏\n*El equipo de Traslados GC*' },
    { clave: 'cliente_modificacion_aprobada', nombre: 'Modificaci\u00f3n aprobada (al cliente)', categoria: 'cliente',
      asunto_email: '\u2705 Tu modificaci\u00f3n ha sido aprobada \u2014 {numero_reserva}',
      cuerpo_email: `
Hola, <strong>{nombre_cliente}</strong> 👋

✅ Hemos revisado y aprobado los cambios en tu reserva <strong>{numero_reserva}</strong>.

🔍 Accede a tu portal para ver todos los detalles actualizados.

Un saludo cordial, 🙏
<strong>El equipo de Traslados GC</strong>
`,
      cuerpo_whatsapp: 'Hola, *{nombre_cliente}* 👋\n\n✅ Hemos revisado y aprobado los cambios en tu reserva *{numero_reserva}*.\n\n🔍 Accede a tu portal para ver todos los detalles actualizados.\n\nUn saludo cordial, 🙏\n*El equipo de Traslados GC*' },
    { clave: 'cliente_mensaje_admin', nombre: 'Mensaje del equipo al cliente', categoria: 'cliente',
      asunto_email: '\ud83d\udcac Tienes un mensaje sobre tu reserva {numero_reserva}',
      cuerpo_email: `
Hola, <strong>{nombre_cliente}</strong> 👋

💬 El equipo de Traslados GC te ha enviado un mensaje sobre tu reserva <strong>{numero_reserva}</strong>:
<blockquote>{mensaje}</blockquote>
🔍 Accede a tu portal para ver el hilo completo y responder.

Un saludo cordial, 🙏
<strong>El equipo de Traslados GC</strong>
`,
      cuerpo_whatsapp: 'Hola, *{nombre_cliente}* 👋\n\n💬 El equipo de Traslados GC te ha enviado un mensaje sobre tu reserva *{numero_reserva}*:\n\n_{mensaje}_\n\n🔍 Accede a tu portal para ver el hilo completo y responder.\n\nUn saludo cordial, 🙏\n*El equipo de Traslados GC*' },
    { clave: 'cliente_valoracion', nombre: 'Solicitud de valoraci\u00f3n (servicio terminado)', categoria: 'cliente',
      asunto_email: '\u00bfC\u00f3mo fue tu traslado {numero_reserva}?',
      cuerpo_email: `
Hola, <strong>{nombre_cliente}</strong> 👋

🏁 Tu traslado ha finalizado. Nos gustaría saber cómo fue tu experiencia.
<div class="info-box">
  🗺️ <strong>{origen} → {destino}</strong><br>
  <span style="font-size:13px;color:#888;">🔖 Reserva {numero_reserva} · 📅 {fecha}</span>
</div>
⭐ Tu opinión nos ayuda a seguir mejorando el servicio. Solo te llevará un momento.
{boton_valoracion}
<span style="color:#888;font-size:13px;"><em>Si no fuiste tú quien realizó este traslado, puedes ignorar este mensaje.</em></span>

Un saludo cordial, 🙏
<strong>El equipo de Traslados GC</strong>
`,
      cuerpo_whatsapp: 'Hola, *{nombre_cliente}* 👋\n\n🏁 Tu traslado ha finalizado. Nos gustaría saber cómo fue tu experiencia.\n\n🗺️ *{origen} → {destino}*\n🔖 Reserva {numero_reserva} · 📅 {fecha}\n\n⭐ Tu opinión nos ayuda a seguir mejorando el servicio. Solo te llevará un momento:\n👉 {url_valoracion}\n\n_Si no fuiste tú quien realizó este traslado, puedes ignorar este mensaje._\n\nUn saludo cordial, 🙏\n*El equipo de Traslados GC*' },
    { clave: 'cliente_deposito_liberado', nombre: 'Dep\u00f3sito liberado (servicio completado)', categoria: 'cliente',
      asunto_email: '\u2705 Tu dep\u00f3sito ha sido liberado \u2014 {numero_reserva}',
      cuerpo_email: `
Hola, <strong>{nombre_cliente}</strong> 👋
<div class="caja-verde">
  ✅ <strong>Servicio completado con éxito.</strong> El depósito de garantía correspondiente a tu reserva <span class="pnr">{numero_reserva}</span> ha sido liberado correctamente. El importe quedará disponible en tu tarjeta en un plazo de 5 a 10 días hábiles según tu entidad bancaria.
</div>
<div class="info-box">
  📍 <strong>Ruta:</strong> {origen} → {destino}<br>
  🔖 <strong>Reserva:</strong> <span class="pnr">{numero_reserva}</span>
</div>
🙏 Ha sido un placer acompañarte en este viaje. Si en algún momento necesitas otro traslado en Gran Canaria, estaremos encantados de ayudarte.

Un saludo cordial, 🙏
<strong>El equipo de Traslados GC</strong>
`,
      cuerpo_whatsapp: 'Hola, *{nombre_cliente}* 👋\n\n✅ *Servicio completado con éxito.* El depósito de garantía correspondiente a tu reserva *{numero_reserva}* ha sido liberado correctamente. El importe quedará disponible en tu tarjeta en un plazo de 5 a 10 días hábiles según tu entidad bancaria.\n\n📍 *Ruta:* {origen} → {destino}\n🔖 *Reserva:* {numero_reserva}\n\n🙏 Ha sido un placer acompañarte en este viaje. Si en algún momento necesitas otro traslado en Gran Canaria, estaremos encantados de ayudarte.\n\nUn saludo cordial, 🙏\n*El equipo de Traslados GC*' },
    { clave: 'cliente_deposito_noshow', nombre: 'Dep\u00f3sito retenido por no-show', categoria: 'cliente',
      asunto_email: '\ud83d\udd12 Dep\u00f3sito retenido por no-show \u2014 {numero_reserva}',
      cuerpo_email: `
Hola, <strong>{nombre_cliente}</strong> 👋
<div class="caja-roja">
  <span style="font-weight:700;font-size:15px;">🔒 Depósito retenido por no-show</span><br>
  <span style="font-size:14px;line-height:1.6;">Lamentamos informarte de que tu traslado <strong>{numero_reserva}</strong> ({origen} → {destino}) del {fecha} no pudo realizarse al no haberse presentado en el punto de recogida.<br>
  De acuerdo con nuestra política de reservas, el depósito de garantía de {importe} € ha sido retenido por no-show.</span>
</div>
<div class="info-box">
  📍 <strong>Ruta:</strong> {origen} → {destino}<br>
  📅 <strong>Fecha del servicio:</strong> {fecha}<br>
  🔖 <strong>Reserva:</strong> <span class="pnr">{numero_reserva}</span>
</div>
❓ Si crees que ha habido un error, no dudes en contactarnos.

Un saludo cordial, 🙏
<strong>El equipo de Traslados GC</strong>
`,
      cuerpo_whatsapp: 'Hola, *{nombre_cliente}* 👋\n\n🔒 *Depósito retenido por no-show*\n\nLamentamos informarte de que tu traslado *{numero_reserva}* no pudo realizarse al no haberse presentado en el punto de recogida.\n\nDe acuerdo con nuestra política de reservas, el depósito de garantía de {importe} € ha sido retenido por no-show.\n\n📍 *Ruta:* {origen} → {destino}\n📅 *Fecha del servicio:* {fecha}\n🔖 *Reserva:* {numero_reserva}\n\n❓ Si crees que ha habido un error, no dudes en contactarnos.\n\nUn saludo cordial, 🙏\n*El equipo de Traslados GC*' },
    { clave: 'cliente_en_gestion', nombre: 'Seguimos gestionando (15 min sin chofer)', categoria: 'cliente',
      asunto_email: 'Seguimos gestionando tu traslado \u2014 {numero_reserva}',
      cuerpo_email: `
Hola, <strong>{nombre_cliente}</strong> 👋

🔄 Seguimos trabajando en tu solicitud de traslado <span class="pnr">{numero_reserva}</span>. Aún no hemos podido confirmar conductor, pero continuamos buscando disponibilidad.
<div class="info-box">
  ⏱️ Te avisaremos en cuanto tengamos una respuesta. El plazo habitual de gestión es de 15 minutos.
</div>
Un saludo cordial, 🙏
<strong>El equipo de Traslados GC</strong>
`,
      cuerpo_whatsapp: 'Hola, *{nombre_cliente}* 👋\n\n🔄 Seguimos trabajando en tu solicitud de traslado *{numero_reserva}*. Aún no hemos podido confirmar conductor, pero continuamos buscando disponibilidad.\n\n⏱️ Te avisaremos en cuanto tengamos una respuesta. El plazo habitual de gestión es de 15 minutos.\n\nUn saludo cordial, 🙏\n*El equipo de Traslados GC*' },
    { clave: 'cliente_reserva_anulada', nombre: 'Reserva anulada (sin chofer disponible)', categoria: 'cliente',
      asunto_email: 'Tu reserva {numero_reserva} ha sido anulada',
      cuerpo_email: `
Hola, <strong>{nombre_cliente}</strong> 👋

😔 Lamentamos informarte que no hemos podido confirmar un conductor disponible para tu traslado en la fecha solicitada, por lo que hemos anulado la reserva <span class="pnr">{numero_reserva}</span>.
<div class="info-box">
  🔄 Puedes enviarnos una nueva solicitud más adelante; con gusto intentaremos ayudarte si tenemos disponibilidad.
</div>
Lamentamos los inconvenientes causados.

Un saludo cordial, 🙏
<strong>El equipo de Traslados GC</strong>
`,
      cuerpo_whatsapp: 'Hola, *{nombre_cliente}* 👋\n\n😔 Lamentamos informarte que no hemos podido confirmar un conductor disponible para tu traslado en la fecha solicitada, por lo que hemos anulado la reserva *{numero_reserva}*.\n\n🔄 Puedes enviarnos una nueva solicitud más adelante; con gusto intentaremos ayudarte si tenemos disponibilidad.\n\nLamentamos los inconvenientes causados.\n\nUn saludo cordial, 🙏\n*El equipo de Traslados GC*' },
    { clave: 'cliente_acceso_reserva', nombre: 'Acceso a reserva (contrase\u00f1a provisional)', categoria: 'cliente',
      asunto_email: 'Acceso a tu reserva {numero_reserva} \u2014 Traslados GC',
      cuerpo_email: `
Hola, <strong>{nombre_cliente}</strong> 👋

🔐 Aquí tienes tu contraseña provisional para acceder al seguimiento de tu reserva <span class="pnr">{numero_reserva}</span>.
<div class="info-box" style="text-align:center;">
  <div style="font-size:12px;color:#5b5347;margin-bottom:8px;text-transform:uppercase;letter-spacing:1px;">🔑 Contraseña provisional</div>
  <div style="font-family:monospace;font-size:24px;font-weight:700;color:#C1502E;letter-spacing:4px;">{password_temporal}</div>
</div>
<span style="font-size:13px;color:#5b5347;">⚠️ Al entrar por primera vez se te pedirá que la cambies por una propia.</span>

<span style="font-size:12px;color:#aaa;"><em>Si no has solicitado este acceso, ignora este mensaje.</em></span>

Un saludo cordial, 🙏
<strong>El equipo de Traslados GC</strong>
`,
      cuerpo_whatsapp: 'Hola, *{nombre_cliente}* 👋\n\n🔐 Aquí tienes tu contraseña provisional para acceder al seguimiento de tu reserva *{numero_reserva}*.\n\n🔑 *Contraseña provisional:* {password_temporal}\n\n⚠️ Al entrar por primera vez se te pedirá que la cambies por una propia.\n\n_Si no has solicitado este acceso, ignora este mensaje._\n\nUn saludo cordial, 🙏\n*El equipo de Traslados GC*' },
    { clave: 'cliente_recuperar_password', nombre: 'Recuperar contrase\u00f1a (portal cliente)', categoria: 'cliente',
      asunto_email: 'Recupera tu contrase\u00f1a \u2014 Traslados GC',
      cuerpo_email: `
Hola, <strong>{nombre_cliente}</strong> 👋

🔑 Has solicitado recuperar el acceso a tu cuenta. Pulsa el botón para elegir una contraseña nueva:
<p style="text-align:center;">
  <a href="{enlace_recuperacion}" class="boton">Crear nueva contraseña</a>
</p>
<span style="font-size:13px;color:#5b5347;">⏱️ Este enlace caduca en 1 hora y solo se puede usar una vez. Tu contraseña actual sigue funcionando hasta que la cambies desde aquí.</span>

<span style="font-size:12px;color:#aaa;"><em>Si no has solicitado esto, simplemente ignora este mensaje — no se cambiará nada.</em></span>

Un saludo cordial, 🙏
<strong>El equipo de Traslados GC</strong>
`,
      cuerpo_whatsapp: null },
    { clave: 'cliente_precio_respuesta', nombre: 'Precio \u201ca consultar\u201d \u2192 respuesta con precio', categoria: 'cliente',
      asunto_email: 'Precio de traslado: {origen} \u2192 {destino}',
      cuerpo_email: `
Hola, <strong>{nombre_cliente}</strong> 👋

✅ Ya tenemos el precio para tu traslado.
<div class="info-box">
  📍 <strong>Ruta:</strong> {origen} → {destino}<br>
  💰 <strong>Precio estimado:</strong> <span style="font-size:16px;font-weight:700;color:#C1502E;">{precio} €</span>
</div>
👉 Si deseas proceder con la reserva, visita nuestra web o respóndenos por WhatsApp y lo gestionamos enseguida.

Un saludo cordial, 🙏
<strong>El equipo de Traslados GC</strong>
`,
      cuerpo_whatsapp: 'Hola, *{nombre_cliente}* 👋\n\n✅ Ya tenemos el precio para tu traslado.\n\n📍 *Ruta:* {origen} → {destino}\n💰 *Precio estimado: {precio} €*\n\n👉 Si deseas proceder con la reserva, visita nuestra web o respóndenos por WhatsApp y lo gestionamos enseguida.\n\nUn saludo cordial, 🙏\n*El equipo de Traslados GC*' },
    { clave: 'cliente_precio_negativa', nombre: 'Precio \u201ca consultar\u201d \u2192 no disponible', categoria: 'cliente',
      asunto_email: 'Tu consulta de traslado \u2014 Traslados GC',
      cuerpo_email: `
Hola, <strong>{nombre_cliente}</strong> 👋

😔 Hemos revisado tu consulta para el traslado de <strong>{origen}</strong> a <strong>{destino}</strong> y lamentamos informarte que en este momento no podemos ofrecerte servicio para esa ruta o fecha.
<div class="info-box">
  🔄 Puedes volver a consultarnos en otra fecha. Estaremos encantados de ayudarte si tenemos disponibilidad.
</div>
Lamentamos los inconvenientes causados.

Un saludo cordial, 🙏
<strong>El equipo de Traslados GC</strong>
`,
      cuerpo_whatsapp: 'Hola, *{nombre_cliente}* 👋\n\n😔 Hemos revisado tu consulta para el traslado de *{origen}* a *{destino}* y lamentamos informarte que en este momento no podemos ofrecerte servicio para esa ruta o fecha.\n\n🔄 Puedes volver a consultarnos en otra fecha. Estaremos encantados de ayudarte si tenemos disponibilidad.\n\nLamentamos los inconvenientes causados.\n\nUn saludo cordial, 🙏\n*El equipo de Traslados GC*' },
    { clave: 'cliente_factura', nombre: 'Factura (al cliente)', categoria: 'cliente',
      asunto_email: '\ud83d\udcc4 Factura {numero_factura} \u2014 Reserva {numero_reserva}',
      cuerpo_email: `
Hola, <strong>{nombre_cliente}</strong> 👋

📄 Adjuntamos la factura <strong>{numero_factura}</strong> correspondiente a tu reserva <strong>{numero_reserva}</strong>.

🙏 Gracias por viajar con Traslados GC.

Un saludo cordial, 🙏
<strong>El equipo de Traslados GC</strong>
`,
      cuerpo_whatsapp: 'Hola, *{nombre_cliente}* 👋\n\n📄 Adjuntamos la factura *{numero_factura}* correspondiente a tu reserva *{numero_reserva}*.\n\n🙏 🙏 Gracias por viajar con Traslados GC.\n\nUn saludo cordial, 🙏\n*El equipo de Traslados GC*' },
    { clave: 'cliente_comunicacion_masiva', nombre: 'Comunicaci\u00f3n masiva (a clientes)', categoria: 'cliente',
      asunto_email: '{asunto_libre}',
      cuerpo_email: `
Hola, <strong>{nombre_cliente}</strong> 👋

{mensaje_libre}

Un saludo cordial, 🙏
<strong>El equipo de Traslados GC</strong>
`,
      cuerpo_whatsapp: 'Hola, *{nombre_cliente}* 👋\n\n{mensaje_libre}\n\nUn saludo cordial, 🙏\n*El equipo de Traslados GC*' },
    { clave: 'chofer_cartel', nombre: 'Cartel de recogida (al chofer)', categoria: 'chofer',
      asunto_email: 'Cartel de recogida \u2014 {numero_reserva}',
      cuerpo_email: `
Hola, <strong>{nombre_chofer}</strong> 👋

📋 Adjuntamos el cartel de recogida para tu próximo servicio. Imprímelo y úsalo para identificar a tu cliente.
<div class="info-box">
  🔖 <strong>Reserva:</strong> <span class="pnr">{numero_reserva}</span><br>
  📍 <strong>Origen:</strong> {origen}<br>
  🏁 <strong>Destino:</strong> {destino}<br>
  📅 <strong>Fecha:</strong> {fecha} · {hora}
</div>
Un saludo cordial, 🙏
<strong>El equipo de Traslados GC</strong>
`,
      cuerpo_whatsapp: 'Hola, *{nombre_chofer}* 👋\n\n📋 Adjuntamos el cartel de recogida para tu próximo servicio. Imprímelo y úsalo para identificar a tu cliente.\n\n🔖 *Reserva:* {numero_reserva}\n📍 *Origen:* {origen}\n🏁 *Destino:* {destino}\n📅 *Fecha:* {fecha} · {hora}\n\nUn saludo cordial, 🙏\n*El equipo de Traslados GC*' },
    { clave: 'chofer_cancelacion', nombre: 'Cancelaci\u00f3n asignada (al chofer)', categoria: 'chofer',
      asunto_email: '\u274c Cancelaci\u00f3n de reserva \u2014 {numero_reserva}',
      cuerpo_email: `
Hola, <strong>{nombre_chofer}</strong> 👋
<div class="info-box">
  ❌ <strong>Reserva cancelada:</strong> <span class="pnr">{numero_reserva}</span><br>
  📍 <strong>Ruta:</strong> {origen} → {destino}<br>
  📅 <strong>Fecha:</strong> {fecha} · {hora}
</div>
La reserva ha sido cancelada por el cliente. Queda liberada de tu agenda.

Un saludo cordial, 🙏
<strong>El equipo de Traslados GC</strong>
`,
      cuerpo_whatsapp: 'Hola, *{nombre_chofer}* 👋\n\n❌ *Reserva cancelada:* {numero_reserva}\n📍 *Ruta:* {origen} → {destino}\n📅 *Fecha:* {fecha} · {hora}\n\nLa reserva ha sido cancelada por el cliente. Queda liberada de tu agenda.\n\nUn saludo cordial, 🙏\n*El equipo de Traslados GC*' },
    { clave: 'chofer_gracias_servicio', nombre: 'Gracias por el servicio (al chofer)', categoria: 'chofer',
      asunto_email: '\ud83d\ude4f Gracias por el servicio \u2014 {numero_reserva}',
      cuerpo_email: `
Hola, <strong>{nombre_chofer}</strong> 👋
<div class="caja-verde">
  ✅ <strong>Servicio completado.</strong> Gracias por realizar el traslado con profesionalidad y puntualidad. Tu trabajo es la base de nuestro servicio.
</div>
<div class="info-box">
  🔖 <strong>Reserva:</strong> <span class="pnr" style="font-size:15px;">{numero_reserva}</span><br>
  📍 <strong>Ruta:</strong> {origen} → {destino}<br>
  📅 <strong>Fecha:</strong> {fecha}
</div>
🙏 Seguimos contando contigo para los próximos servicios. ¡Hasta pronto!

Un saludo cordial, 🙏
<strong>El equipo de Traslados GC</strong>
`,
      cuerpo_whatsapp: 'Hola, *{nombre_chofer}* 👋\n\n✅ *Servicio completado.* Gracias por realizar el traslado con profesionalidad y puntualidad. Tu trabajo es la base de nuestro servicio.\n\n🔖 *Reserva:* {numero_reserva}\n📍 *Ruta:* {origen} → {destino}\n📅 *Fecha:* {fecha}\n\n🙏 Seguimos contando contigo para los próximos servicios. ¡Hasta pronto!\n\nUn saludo cordial, 🙏\n*El equipo de Traslados GC*' },
    { clave: 'chofer_mensaje_admin', nombre: 'Mensaje del equipo al chofer', categoria: 'chofer',
      asunto_email: '\ud83d\udcac Mensaje sobre la reserva {numero_reserva}',
      cuerpo_email: `
Hola, <strong>{nombre_chofer}</strong> 👋

💬 El equipo de Traslados GC te ha enviado un mensaje sobre la reserva <strong>{nombre_reserva}</strong>:
<blockquote>{mensaje}</blockquote>
🔍 Accede a tu portal para ver los detalles.

Un saludo cordial, 🙏
<strong>El equipo de Traslados GC</strong>
`,
      cuerpo_whatsapp: 'Hola, *{nombre_chofer}* 👋\n\n💬 El equipo de Traslados GC te ha enviado un mensaje sobre la reserva *{numero_reserva}*:\n\n_{mensaje}_\n\n🔍 Accede a tu portal para ver los detalles.\n\nUn saludo cordial, 🙏\n*El equipo de Traslados GC*' },
    { clave: 'chofer_bienvenida', nombre: 'Bienvenida al chofer (cuenta aprobada)', categoria: 'chofer',
      asunto_email: '\u00a1Bienvenido a Traslados GC!',
      cuerpo_email: `
Hola, <strong>{nombre_chofer}</strong> 👋

🎉 Es un placer darte la bienvenida a nuestra flota. Tu solicitud ha sido revisada y aprobada — a partir de ahora formas parte del equipo de Traslados GC.

📱 Ya puedes acceder a tu portal de chofer, donde encontrarás tus próximas reservas asignadas y podrás gestionar tu perfil y foto.
<p style="text-align:center;margin:24px 0;">
  <a href="https://traslados-gc.onrender.com/chofer/acceso" class="boton">Acceder a mi portal</a>
</p>
<span style="font-size:13px;color:#5b5347;">❓ Si tienes cualquier duda, estamos disponibles a través de nuestro WhatsApp. ¡Bienvenido al equipo!</span>

Un saludo cordial, 🙏
<strong>El equipo de Traslados GC</strong>
`,
      cuerpo_whatsapp: 'Hola, *{nombre_chofer}* 👋\n\n🎉 Es un placer darte la bienvenida a nuestra flota. Tu solicitud ha sido revisada y aprobada — a partir de ahora formas parte del equipo de Traslados GC.\n\n📱 Ya puedes acceder a tu portal de chofer, donde encontrarás tus próximas reservas asignadas y podrás gestionar tu perfil y foto.\n\n❓ Si tienes cualquier duda, estamos disponibles a través de nuestro WhatsApp. ¡Bienvenido al equipo!\n\nUn saludo cordial, 🙏\n*El equipo de Traslados GC*' },
    { clave: 'chofer_comunicacion_masiva', nombre: 'Comunicaci\u00f3n masiva (a choferes)', categoria: 'chofer',
      asunto_email: '{asunto_libre}',
      cuerpo_email: `
Hola, <strong>{nombre_chofer}</strong> 👋

{mensaje_libre}

Un saludo cordial, 🙏
<strong>El equipo de Traslados GC</strong>
`,
      cuerpo_whatsapp: 'Hola, *{nombre_chofer}* 👋\n\n{mensaje_libre}\n\nUn saludo cordial, 🙏\n*El equipo de Traslados GC*' },
    { clave: 'interno_cliente_modifico', nombre: '[Admin] Cliente modific\u00f3 datos de reserva', categoria: 'interno',
      asunto_email: '\u270f\ufe0f Cliente modific\u00f3 datos \u2014 {numero_reserva}',
      cuerpo_email: `
✏️ El cliente de la reserva <strong>{numero_reserva}</strong> ha modificado los datos de su traslado.

🔍 Accede al panel de administración para revisar los cambios y aprobarlos si procede.
`,
      cuerpo_whatsapp: null },
    { clave: 'interno_cliente_cancelo', nombre: '[Admin] Cliente cancel\u00f3 una reserva', categoria: 'interno',
      asunto_email: '\u274c Cancelaci\u00f3n de reserva \u2014 {numero_reserva}',
      cuerpo_email: `
❌ El cliente <strong>{nombre_cliente}</strong> ha cancelado la reserva <strong>{numero_reserva}</strong>.
<div class="info-box">
  📍 <strong>Ruta:</strong> {origen} → {destino}<br>
  📅 <strong>Fecha:</strong> {fecha}
</div>
Revisa el estado del depósito desde el panel de administración.
`,
      cuerpo_whatsapp: null },
    { clave: 'interno_cliente_mensaje', nombre: '[Admin] Nuevo mensaje de cliente', categoria: 'interno',
      asunto_email: '\ud83d\udcac Nuevo mensaje de cliente \u2014 {numero_reserva}',
      cuerpo_email: `
💬 <strong>{nombre_cliente}</strong> (reserva <strong>{numero_reserva}</strong>) ha enviado un mensaje:
<blockquote>{mensaje}</blockquote>
🔍 Accede al panel de administración para responder o ver el historial completo.
`,
      cuerpo_whatsapp: null },
    { clave: 'interno_modificacion_solicitada', nombre: '[Admin] Cliente solicit\u00f3 modificaci\u00f3n', categoria: 'interno',
      asunto_email: '\u270f\ufe0f Modificaci\u00f3n solicitada \u2014 {numero_reserva}',
      cuerpo_email: `
✏️ El cliente <strong>{nombre_cliente}</strong> ha solicitado modificaciones en la reserva <strong>{numero_reserva}</strong>.

🔍 Accede al panel de administración para revisar y aprobar los cambios.
`,
      cuerpo_whatsapp: null },
    { clave: 'interno_sin_choferes', nombre: '[Admin] Sin respuesta de choferes (15 min)', categoria: 'interno',
      asunto_email: 'Reserva {numero_reserva} sin respuesta de choferes (15 min)',
      cuerpo_email: `
⏱️ <strong>Atención:</strong> La reserva <strong>{numero_reserva}</strong> lleva 15 minutos avisada a los conductores disponibles sin que nadie haya aceptado.

🔍 Accede al panel de administración para asignar conductor manualmente o tomar las medidas oportunas.
`,
      cuerpo_whatsapp: null },
    { clave: 'interno_registro_chofer', nombre: '[Admin] Nuevo chofer registrado', categoria: 'interno',
      asunto_email: 'Solicitud recibida \u2014 Traslados GC',
      cuerpo_email: `
🚗 El conductor <strong>{nombre_chofer}</strong> ha completado su solicitud para unirse a la flota.

🔍 Accede al panel de administración para revisar su perfil y aprobar o rechazar la solicitud.
`,
      cuerpo_whatsapp: null },
    { clave: 'interno_recuperar_password_admin', nombre: '[Admin] Recuperar contrase\u00f1a de administrador', categoria: 'interno',
      asunto_email: 'Recupera tu contrase\u00f1a \u2014 Traslados GC',
      cuerpo_email: `
🔑 Se ha solicitado restablecer la contraseña de la cuenta de administrador.

Pulsa el botón para crear una nueva contraseña:
<p style="text-align:center;">
  <a href="{enlace_recuperacion}" class="boton">Crear nueva contraseña</a>
</p>
<span style="font-size:13px;color:#5b5347;">⏱️ Este enlace caduca en 1 hora y solo se puede usar una vez.</span>

<span style="font-size:12px;color:#aaa;"><em>Si no has solicitado esto, ignora este mensaje — no se cambiará nada.</em></span>
`,
      cuerpo_whatsapp: null },
    { clave: 'marca_base', nombre: 'Plantilla base de marca', categoria: 'interno',
      asunto_email: 'marca_base',
      cuerpo_email: '{"nombre":"Traslados GC","subtitulo":"Gran Canaria","colorCabecera":"#2c2c2c","colorNombre":"#d4956a","pie":"Traslados GC \u00b7 Gran Canaria"}',
      cuerpo_whatsapp: null }
  ];

  for (const p of plantillasBase) {
    await pool.query(
      `INSERT INTO plantillas_comunicacion (clave, nombre, categoria, asunto_email, cuerpo_email, cuerpo_whatsapp)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (clave) DO UPDATE SET cuerpo_email = EXCLUDED.cuerpo_email, cuerpo_whatsapp = EXCLUDED.cuerpo_whatsapp`,
      // NOTA: Este DO UPDATE sobreescribe los textos en BD con los del código.
      [p.clave, p.nombre, p.categoria, p.asunto_email, p.cuerpo_email, p.cuerpo_whatsapp]
    );
  }
  console.log('Plantillas de comunicaci\u00f3n cargadas.');

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
// ─── Helper: obtener configuración No-Show para una fecha ────────────────────
async function obtenerConfigNoshow(fechaViaje) {
  const temporada = await pool.query(
    `SELECT * FROM configuracion_noshow
     WHERE es_general = FALSE AND activa = TRUE
     AND fecha_inicio <= $1 AND fecha_fin >= $1
     ORDER BY fecha_inicio DESC LIMIT 1`,
    [fechaViaje]
  );
  if (temporada.rows.length) return temporada.rows[0];
  const general = await pool.query('SELECT * FROM configuracion_noshow WHERE es_general = TRUE LIMIT 1');
  return general.rows[0] || { importe_deposito: 10.00, horas_cancelacion: 12 };
}

// ─── Helper: calcular fecha límite de cancelación gratuita ───────────────────
function calcularFechaCancelacion(fechaViaje, horaViaje, horasCancelacion) {
  const fechaHoraStr = fechaViaje.toISOString().slice(0, 10) + 'T' + (horaViaje || '00:00:00');
  const fechaHora = new Date(fechaHoraStr);
  fechaHora.setHours(fechaHora.getHours() - horasCancelacion);
  return fechaHora;
}

// ─── Helper: obtener emails de notificación del admin ────────────────────────
async function obtenerEmailsNotificacion() {
  const cfg = await pool.query('SELECT emails_notificacion FROM configuracion_contacto WHERE id = 1');
  if (!cfg.rows.length || !cfg.rows[0].emails_notificacion) return [];
  return cfg.rows[0].emails_notificacion.split(',').map(e => e.trim()).filter(Boolean);
}

// ─── Helper: generar contraseña provisional ───────────────────────────────────
function generarPasswordProvisional() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

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

app.get('/api/idiomas-activos', asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT codigo, nombre FROM idiomas_web WHERE activo = TRUE ORDER BY orden, codigo'
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

app.get('/api/categorias-publicas', asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT id, nombre, capacidad_pasajeros FROM categorias_vehiculos WHERE activa = TRUE ORDER BY id'
  );
  res.json(result.rows);
}));

app.get('/api/extras-publicos', asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT id, nombre, precio, bloque, orden, tipo_seleccion FROM extras WHERE activo = TRUE ORDER BY bloque, orden, id'
  );
  res.json(result.rows);
}));

app.get('/api/marcas-vehiculos', asyncHandler(async (req, res) => {
  const marcas = await pool.query('SELECT id, nombre FROM marcas_vehiculos ORDER BY nombre');
  const modelos = await pool.query('SELECT id, marca_id, nombre FROM modelos_vehiculos ORDER BY nombre');
  res.json(marcas.rows.map(function(m) {
    return { id: m.id, nombre: m.nombre, modelos: modelos.rows.filter(function(mo) { return mo.marca_id === m.id; }) };
  }));
}));

app.post('/api/reservas', asyncHandler(async (req, res) => {
  const {
    numero_reserva_cliente,
    origen, destino, categoria_id, precio_estimado,
    fecha, hora, tipo_llegada, numero_vuelo, hora_llegada_vuelo,
    nombre_barco, hora_atraque,
    num_pasajeros, notas,
    nombre_cliente, telefono_cliente, email_cliente,
    es_para_otra_persona, nombre_pasajero_otro, telefono_pasajero_otro,
    email_pasajero_otro,
    pasaporte_dni,
    extras
  } = req.body;

  if (!origen || !destino || !categoria_id || !fecha || !nombre_cliente || !telefono_cliente || !email_cliente) {
    return res.status(400).json({ error: 'Faltan datos obligatorios.' });
  }
  if (es_para_otra_persona && (!nombre_pasajero_otro || !nombre_pasajero_otro.trim())) {
    return res.status(400).json({ error: 'Falta el nombre de la persona que viaja.' });
  }
  if ((tipo_llegada === 'aeropuerto' || tipo_llegada === 'puerto') && (!pasaporte_dni || !pasaporte_dni.trim())) {
    return res.status(400).json({ error: 'Falta el número de pasaporte o DNI del pasajero.' });
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
    es_para_otra_persona ? 'Reserva hecha por ' + nombre_cliente.trim() + ' para otra persona: ' + nombre_pasajero_otro.trim() + ' (tel. ' + (telefono_pasajero_otro || '').trim() + (email_pasajero_otro && email_pasajero_otro.trim() ? ', email ' + email_pasajero_otro.trim() : '') + ')' : null,
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
      num_pasajeros, notas_cliente, estado_aviso_whatsapp,
      es_para_otra_persona, nombre_pasajero_otro, telefono_pasajero_otro,
      email_pasajero_otro,
      pasaporte_dni
    )
     VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, 'pendiente',
             $10, $11, $12, $13, $14, $15, $16, $17, $18, 'pendiente',
             $19, $20, $21, $22, $23)
     RETURNING id`,
    [
      numeroReserva, categoria_id, fecha, horaGuardar,
      nombre_cliente.trim(), telefono_cliente.trim(), email_cliente.trim(),
      precio_estimado || null, notasCompletas || null,
      origen || null, destino || null, tipo_llegada || null,
      numero_vuelo || null, hora_llegada_vuelo || null,
      nombre_barco || null, hora_atraque || null,
      num_pasajeros || null, notas || null,
      !!es_para_otra_persona,
      es_para_otra_persona ? nombre_pasajero_otro.trim() : null,
      (es_para_otra_persona && telefono_pasajero_otro && telefono_pasajero_otro.trim()) ? telefono_pasajero_otro.trim() : null,
      (es_para_otra_persona && email_pasajero_otro && email_pasajero_otro.trim()) ? email_pasajero_otro.trim() : null,
      pasaporte_dni ? pasaporte_dni.trim() : null
    ]
  );

  const reservaId = reserva.rows[0].id;

  // Guardar cliente en clientes_datos (sin sobrescribir datos si ya existen)
  try {
    await pool.query(
      `INSERT INTO clientes_datos (email_cliente, nombre, telefono)
       VALUES ($1, $2, $3)
       ON CONFLICT (email_cliente) DO UPDATE
         SET nombre = COALESCE(NULLIF(clientes_datos.nombre, ''), EXCLUDED.nombre),
             telefono = COALESCE(NULLIF(clientes_datos.telefono, ''), EXCLUDED.telefono),
             actualizado_en = NOW()`,
      [email_cliente.trim().toLowerCase(), nombre_cliente.trim(), telefono_cliente.trim()]
    );
  } catch (e) {
    console.error('No se pudo guardar el cliente en clientes_datos:', e);
  }

  // Copia de las preferencias del pasajero (Grupo G) en esta reserva:
  // instantánea de lo que el cliente tiene marcado en este momento.
  // Funciona tanto si la sesión es de portal (clienteEmail) como de reserva (clienteReservaId).
  try {
    const emailPref = req.session && req.session.clienteEmail
      ? req.session.clienteEmail.toLowerCase()
      : await emailClienteSesion(req);
    if (emailPref) {
      const visPref = await pool.query(
        'SELECT visibles FROM preferencias_visibilidad_cliente WHERE email_cliente = $1', [emailPref]
      );
      const prefsVisibles = visPref.rows.length ? visPref.rows[0].visibles : true;
      if (prefsVisibles) {
        await pool.query(
          `INSERT INTO preferencias_reserva (reserva_id, nombre, opcion, detalle)
           SELECT $1, c.nombre, pc.opcion, pc.detalle
           FROM preferencias_cliente pc
           JOIN preferencias_catalogo c ON c.id = pc.preferencia_id AND c.activo = TRUE
           WHERE pc.email_cliente = $2`,
          [reservaId, emailPref]
        );
      }
    }
  } catch (e) {
    console.error('No se pudieron copiar las preferencias en la reserva:', e);
  }

  // Guardar extras seleccionados
  if (Array.isArray(extras) && extras.length > 0) {
    for (const extra of extras) {
      await pool.query(
        'INSERT INTO reservas_extras (reserva_id, extra_id, precio_en_reserva) VALUES ($1, $2, $3)',
        [reservaId, extra.id, extra.precio]
      );
    }
  }

  // Email de pre-reserva al cliente
  try {
    const fechaTexto = fecha ? new Date(fecha + 'T12:00:00').toLocaleDateString('es-ES', {day:'numeric', month:'long', year:'numeric'}) : '';
    const horaTexto = hora ? hora.slice(0, 5) : '—';
    const _par = await obtenerPlantilla('cliente_acuse_recibo', {
      nombre_cliente: nombre_cliente.trim(),
      numero_reserva: numeroReserva,
      origen: origen || '—',
      destino: destino || '—',
      fecha: fechaTexto,
      hora: horaTexto
    });
    const htmlEmail = plantillaEmail(
      (_par && _par.email) ||
      `<p>Hola <strong>${nombre_cliente.trim()}</strong>,</p>
       <p>Hemos recibido tu solicitud de traslado. Estamos trabajando en ella y en breve recibirás confirmación.</p>
       <p>Tu número de reserva es:</p>
       <p style="text-align:center;margin:20px 0;"><span class="pnr">${numeroReserva}</span></p>
       <div class="info-box">
         <strong>Detalles de tu solicitud:</strong><br>
         Origen: ${origen}<br>
         Destino: ${destino}<br>
         Fecha: ${fechaTexto}<br>
         Pasajeros: ${num_pasajeros || '—'}
       </div>
       <p style="font-size:13px;color:#888;">Guarda este número — lo necesitarás para consultar el estado de tu reserva. Nos pondremos en contacto contigo a través del WhatsApp o email que nos has facilitado.</p>
       <p style="font-size:13px;color:#888;">El plazo máximo para confirmarte un chofer es de 15 minutos. Te avisaremos en cuanto tengamos una respuesta.</p>`);

    await enviarEmail({
      to: email_cliente.trim(),
      subject: (_par && _par.asunto) || ('Solicitud de traslado recibida — ' + numeroReserva),
      html: htmlEmail
    });
  } catch(emailErr) {
    console.warn('Error enviando email pre-reserva:', emailErr.message);
    // No bloqueamos la respuesta si el email falla
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
            c.cambios_pendientes, c.disponible_hoy,
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
  const fotoEstado = foto ? 'pendiente' : 'sin_foto';
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
    const nuevoId = result.rows[0].id;

    try {
      await enviarEmail({
        to: d.email.toLowerCase().trim(),
        subject: '¡Bienvenido a Traslados GC! Tus datos de acceso',
        html: plantillaEmail(
          `<p>Hola <strong>${d.nombre.trim()}</strong>,</p>
           <p>Te hemos dado de alta en nuestra flota de choferes. Ya puedes acceder a tu portal con estos datos:</p>
           <div class="info-box">
             <strong>Usuario (email):</strong> ${d.email.toLowerCase().trim()}<br>
             <strong>Contraseña provisional:</strong> ${d.password}
           </div>
           <p>En tu portal encontrarás tus próximas reservas asignadas y podrás gestionar tu perfil.</p>
           <p style="text-align:center;margin:24px 0;"><a href="https://traslados-gc.onrender.com/chofer/acceso" class="boton">Acceder a mi portal</a></p>
           <p style="font-size:13px;color:#5b5347;">Si tienes cualquier duda, estamos disponibles a través de nuestro WhatsApp. ¡Bienvenido al equipo!</p>`
        )
      });
    } catch (err) {
      console.warn('Error enviando email de bienvenida (alta manual de conductor):', err.message);
    }

    res.json({ ok: true, id: nuevoId });
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

  // Email de bienvenida al aprobar
  if (estado === 'aprobado') {
    try {
      const chofer = await pool.query('SELECT nombre, email FROM conductores WHERE id = $1', [req.params.id]);
      if (chofer.rows.length) {
        const { nombre, email } = chofer.rows[0];
        const nombreEmpresa = 'Traslados GC';
        await enviarEmail({
          to: email,
          subject: `¡Bienvenido a ${nombreEmpresa}!`,
          html: plantillaEmail(
            `<p>Hola <strong>${nombre}</strong>,</p>
             <p>Es un placer darte la bienvenida a nuestra flota. Tu solicitud ha sido revisada y aprobada — a partir de ahora formas parte del equipo de Traslados GC.</p>
             <p>Ya puedes acceder a tu portal de chofer, donde encontrarás tus próximas reservas asignadas y podrás gestionar tu perfil y foto.</p>
             <p style="text-align:center;margin:24px 0;"><a href="https://traslados-gc.onrender.com/chofer/acceso" class="boton">Acceder a mi portal</a></p>
             <p style="font-size:13px;color:#5b5347;">Si tienes cualquier duda, estamos disponibles a través de nuestro WhatsApp. ¡Bienvenido al equipo!</p>`
          )
        });
      }
    } catch(err) {
      console.warn('Error enviando email bienvenida chofer:', err.message);
    }
  }

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
            c.tipo, c.estado, c.foto, c.foto_estado, c.foto_motivo, c.creado_en, c.permitir_edicion_ficha,
            c.cambios_pendientes,
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
  if (req.body.permitir_edicion_ficha !== undefined) {
    valores.push(!!req.body.permitir_edicion_ficha);
    cambios.push(`permitir_edicion_ficha = $${valores.length}`);
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

app.post('/admin/conductores/:id/cambios/decidir', requireAdmin, asyncHandler(async (req, res) => {
  const { accion } = req.body;
  if (accion !== 'aprobar' && accion !== 'rechazar') {
    return res.status(400).json({ error: 'Acción no válida.' });
  }

  const actual = await pool.query('SELECT cambios_pendientes FROM conductores WHERE id = $1', [req.params.id]);
  if (!actual.rows.length) return res.status(404).json({ error: 'Conductor no encontrado.' });
  const propuesta = actual.rows[0].cambios_pendientes;
  if (!propuesta) return res.status(400).json({ error: 'Este conductor no tiene cambios pendientes.' });

  if (accion === 'rechazar') {
    await pool.query('UPDATE conductores SET cambios_pendientes = NULL WHERE id = $1', [req.params.id]);
    return res.json({ ok: true });
  }

  const campos = Object.keys(propuesta);
  const cambios = [];
  const valores = [];
  for (const campo of campos) {
    valores.push(propuesta[campo].nuevo);
    cambios.push(`${campo} = $${valores.length}`);
  }
  valores.push(req.params.id);
  try {
    await pool.query(
      `UPDATE conductores SET ${cambios.join(', ')}, cambios_pendientes = NULL WHERE id = $${valores.length}`,
      valores
    );
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
  if (!imagen || !imagen.startsWith('data:image/') || imagen.length > 3000000) {
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
    'un tono distinto a un párrafo explicativo). Mantén un tono profesional pero cercano.\n' +
    '- Traduce TODOS los textos sin excepción, incluidos nombres de categorías como "Business", "Económico", "Confort", "Premium" — tradúcelos a su equivalente natural en ' + nombreIdioma + '.\n\n' +
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
// Elimina todas las traducciones de un texto (solo para categorías mal traducidas)
app.delete('/admin/textos/:id/traducciones', requireAdmin, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM textos_interfaz_traducciones WHERE texto_id = $1', [req.params.id]);
  await cargarTextosCache();
  res.json({ ok: true });
}));


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

// ─── Contacto público ─────────────────────────────────────────────────────────

app.get('/contacto', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'contacto.html'));
});

app.get('/api/contacto', asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT * FROM configuracion_contacto WHERE id = 1');
  res.json(result.rows[0] || {});
}));

// ─── Registro público de choferes ─────────────────────────────────────────────

app.get('/rutas', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'rutas.html'));
});

app.get('/flota', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'flota.html'));
});

app.get('/chofer/acceso', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chofer-registro.html'));
});

app.get('/chofer/acceso/alta', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chofer-registro.html'));
});

app.post('/api/chofer/registro', asyncHandler(async (req, res) => {
  const {
    nombre, email, telefono, password,
    documento, direccion, cp, municipio,
    municipio_licencia, numero_licencia,
    central_flota, categoria_id,
    vehiculo_marca, vehiculo_modelo, matricula,
    numero_taxi, plazas, isla, observaciones, foto
  } = req.body;

  if (!nombre || !email || !telefono || !password) {
    return res.status(400).json({ error: 'Los campos nombre, email, teléfono y contraseña son obligatorios.' });
  }

  // Verificar que el email no existe ya
  const existe = await pool.query('SELECT id FROM conductores WHERE email = $1', [email.trim().toLowerCase()]);
  if (existe.rows.length) {
    return res.status(400).json({ error: 'Ya existe un chofer registrado con ese email.' });
  }

  const hash = await bcrypt.hash(password, 10);
  const catId = categoria_id ? parseInt(categoria_id) : null;

  await pool.query(
    `INSERT INTO conductores (
      nombre, email, telefono, password_hash,
      documento, direccion, cp, municipio,
      municipio_licencia, numero_licencia,
      central_flota, categoria_id,
      vehiculo_marca, vehiculo_modelo, matricula,
      numero_taxi, plazas, isla, observaciones, foto, foto_estado, estado
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'pendiente')`,
    [
      nombre.trim(), email.trim().toLowerCase(), telefono.trim(), hash,
      documento||'', direccion||'', cp||'', municipio||'',
      municipio_licencia||'', numero_licencia||'',
      central_flota||'', catId,
      vehiculo_marca||'', vehiculo_modelo||'', matricula||'',
      numero_taxi||'', plazas ? parseInt(plazas) : 4,
      isla||'Gran Canaria', observaciones||'',
      foto||null, foto ? 'pendiente' : 'sin_foto'
    ]
  );

  // Email de confirmación al chofer
  try {
    await enviarEmail({
      to: email.trim(),
      subject: 'Solicitud recibida — Traslados GC',
      html: plantillaEmail(
        `<p>Hola <strong>${nombre.trim()}</strong>,</p>
         <p>Hemos recibido tu solicitud para unirte a nuestra flota de choferes. Revisaremos tu información y te contactaremos en breve.</p>
         <p style="font-size:13px;color:#888;">Si tienes alguna pregunta, no dudes en contactarnos.</p>`
      )
    });
  } catch(err) {
    console.warn('Error enviando email confirmación registro chofer:', err.message);
  }

  res.json({ ok: true });
}));

// ─── Portal del chofer ───────────────────────────────────────────────────────

app.get('/chofer/portal', (req, res) => {
  if (!req.session || !req.session.choferId) return res.redirect('/chofer/acceso');
  res.sendFile(path.join(__dirname, 'public', 'chofer-portal.html'));
});

app.post('/chofer/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Introduce email y contraseña.' });

  const result = await pool.query(
    'SELECT * FROM conductores WHERE email = $1 AND estado = $2',
    [email.trim().toLowerCase(), 'aprobado']
  );
  if (!result.rows.length) {
    return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
  }
  const chofer = result.rows[0];
  const ok = await bcrypt.compare(password, chofer.password_hash);
  if (!ok) return res.status(401).json({ error: 'Email o contraseña incorrectos.' });

  req.session.choferId = chofer.id;
  req.session.choferNombre = chofer.nombre;
  res.json({ ok: true });
}));

// Recuperar contraseña del chofer (en cualquier momento)
app.post('/chofer/recuperar-password', asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Indica tu email.' });

  const result = await pool.query(
    'SELECT id, nombre, email FROM conductores WHERE LOWER(email) = LOWER($1)',
    [email.trim()]
  );
  // Por seguridad, respondemos ok igual exista o no la cuenta
  if (!result.rows.length) return res.json({ ok: true });
  const chofer = result.rows[0];

  const token = crypto.randomBytes(32).toString('hex');
  const expira = new Date(Date.now() + 60 * 60 * 1000); // 1 hora
  await pool.query(
    'INSERT INTO tokens_recuperacion (tipo, referencia_id, token, expira_en) VALUES ($1,$2,$3,$4)',
    ['chofer', chofer.id, token, expira]
  );

  const BASE_URL = process.env.BASE_URL || 'https://traslados-gc.onrender.com';
  const enlace = `${BASE_URL}/restablecer-password?token=${token}&tipo=chofer`;
  await enviarEmail({
    to: chofer.email,
    subject: 'Recupera tu contraseña — Traslados GC',
    html: plantillaEmail(
      `<p>Hola <strong>${chofer.nombre}</strong>,</p>
       <p>Has solicitado recuperar el acceso a tu portal de chofer. Pulsa el botón para elegir una contraseña nueva:</p>
       <p style="text-align:center;"><a href="${enlace}" class="boton">Crear nueva contraseña</a></p>
       <p style="font-size:13px;color:#5b5347;">Este enlace caduca en 1 hora y solo se puede usar una vez. Tu contraseña actual sigue funcionando hasta que la cambies desde aquí.</p>
       <p style="font-size:12px;color:#aaa;margin-top:20px;">Si no has solicitado esto, ignora este mensaje — no se cambiará nada.</p>`
    )
  });

  res.json({ ok: true });
}));

app.get('/chofer/me', requireChofer, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT c.id, c.nombre, c.email, c.telefono, c.documento, c.direccion, c.cp, c.municipio,
            c.municipio_licencia, c.numero_licencia, c.central_flota,
            c.vehiculo_marca, c.vehiculo_modelo, c.matricula, c.numero_taxi, c.plazas, c.isla,
            c.estado, c.foto, c.foto_estado, c.foto_motivo, c.permitir_edicion_ficha, c.cambios_pendientes,
            c.disponible_hoy,
            cat.nombre AS categoria
     FROM conductores c
     LEFT JOIN categorias_vehiculos cat ON cat.id = c.categoria_id
     WHERE c.id = $1`,
    [req.session.choferId]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'No encontrado.' });
  res.json({ conductor: result.rows[0] });
}));

app.post('/chofer/disponibilidad', requireChofer, asyncHandler(async (req, res) => {
  const disponible = req.body.disponible_hoy === true;
  await pool.query('UPDATE conductores SET disponible_hoy = $1 WHERE id = $2', [disponible, req.session.choferId]);
  res.json({ ok: true, disponible_hoy: disponible });
}));

// Extras: el chofer ve el catálogo publicado (Grupo A) y su decisión actual
// para cada uno. Si no hay fila en conductor_extras, ese extra cuenta como
// "pendiente por revisar" — de ahí sale el aviso en su portal.
app.get('/chofer/extras', requireChofer, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT e.id, e.nombre, e.bloque, e.orden, e.tipo_seleccion, e.precio, e.notas_chofer,
            ce.estado
     FROM extras e
     LEFT JOIN conductor_extras ce ON ce.extra_id = e.id AND ce.conductor_id = $1
     WHERE e.activo = TRUE AND e.depende_chofer = TRUE
     ORDER BY e.bloque, e.orden, e.id`,
    [req.session.choferId]
  );
  const pendientes = result.rows.filter(function (r) { return r.estado === null; }).length;
  res.json({ extras: result.rows, pendientes: pendientes });
}));

app.post('/chofer/extras/:extraId', requireChofer, asyncHandler(async (req, res) => {
  const estado = req.body.estado;
  if (['no_ofrece', 'gratis', 'pago'].indexOf(estado) === -1) {
    return res.status(400).json({ error: 'Estado no válido.' });
  }
  await pool.query(
    `INSERT INTO conductor_extras (conductor_id, extra_id, estado, actualizado_en)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (conductor_id, extra_id) DO UPDATE SET estado = $3, actualizado_en = NOW()`,
    [req.session.choferId, req.params.extraId, estado]
  );
  res.json({ ok: true });
}));

app.post('/chofer/mi-perfil', requireChofer, asyncHandler(async (req, res) => {
  const actual = await pool.query('SELECT * FROM conductores WHERE id = $1', [req.session.choferId]);
  if (!actual.rows.length) return res.status(404).json({ error: 'No encontrado.' });
  const c = actual.rows[0];

  if (!c.permitir_edicion_ficha) {
    return res.status(403).json({ error: 'No tienes permiso activo para editar tu ficha. Solicítalo a la administración.' });
  }

  const camposPermitidos = ['telefono', 'direccion', 'cp', 'municipio', 'central_flota',
    'vehiculo_marca', 'vehiculo_modelo', 'matricula', 'numero_taxi', 'plazas', 'isla', 'email'];
  const etiquetas = {
    telefono: 'Teléfono', direccion: 'Dirección', cp: 'Código postal', municipio: 'Municipio',
    central_flota: 'Central de flota', vehiculo_marca: 'Marca', vehiculo_modelo: 'Modelo',
    matricula: 'Matrícula', numero_taxi: 'Nº de taxi', plazas: 'Plazas', isla: 'Isla', email: 'Email'
  };

  const propuesta = {};
  for (const campo of camposPermitidos) {
    if (req.body[campo] === undefined) continue;
    let nuevo = String(req.body[campo]).trim();
    if (campo === 'email') nuevo = nuevo.toLowerCase();
    if (campo === 'matricula') nuevo = nuevo.toUpperCase();
    const actualValor = c[campo] == null ? '' : String(c[campo]).trim();
    if (nuevo !== actualValor) {
      propuesta[campo] = { etiqueta: etiquetas[campo], anterior: actualValor, nuevo: nuevo };
    }
  }

  if (Object.keys(propuesta).length === 0) {
    return res.status(400).json({ error: 'No hay ningún cambio que enviar.' });
  }

  await pool.query(
    'UPDATE conductores SET cambios_pendientes = $1, permitir_edicion_ficha = FALSE WHERE id = $2',
    [JSON.stringify(propuesta), req.session.choferId]
  );
  res.json({ ok: true });
}));

app.post('/chofer/cambiar-password', requireChofer, asyncHandler(async (req, res) => {
  const { password_actual, password_nueva } = req.body;
  if (!password_actual || !password_nueva) {
    return res.status(400).json({ error: 'Introduce la contraseña actual y la nueva.' });
  }
  if (password_nueva.length < 6) {
    return res.status(400).json({ error: 'La contraseña nueva debe tener al menos 6 caracteres.' });
  }

  const result = await pool.query('SELECT password_hash FROM conductores WHERE id = $1', [req.session.choferId]);
  if (!result.rows.length) return res.status(404).json({ error: 'No encontrado.' });

  const ok = await bcrypt.compare(password_actual, result.rows[0].password_hash);
  if (!ok) return res.status(401).json({ error: 'La contraseña actual no es correcta.' });

  const hash = await bcrypt.hash(password_nueva, 10);
  await pool.query('UPDATE conductores SET password_hash = $1 WHERE id = $2', [hash, req.session.choferId]);
  res.json({ ok: true });
}));

app.post('/chofer/foto', requireChofer, asyncHandler(async (req, res) => {
  const { foto } = req.body;
  if (!foto) return res.status(400).json({ error: 'No se recibió foto.' });
  await pool.query(
    `UPDATE conductores SET foto = $1, foto_estado = 'pendiente', foto_motivo = NULL WHERE id = $2`,
    [foto, req.session.choferId]
  );
  res.json({ ok: true });
}));

app.get('/chofer/sesion', (req, res) => {
  if (req.session && req.session.choferId) {
    res.json({ rol: 'conductor' });
  } else {
    res.json({ rol: null });
  }
});

app.post('/chofer/logout', (req, res) => {
  req.session.destroy(function() { res.json({ ok: true }); });
});

app.get('/chofer/mis-reservas', requireChofer, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT r.id, r.numero_reserva, r.fecha, r.hora, r.origen, r.destino,
            CASE WHEN r.es_para_otra_persona THEN r.nombre_pasajero_otro ELSE r.nombre_cliente END AS nombre_cliente,
            r.num_pasajeros, r.estado, r.deposito_pagado,
            r.numero_vuelo, r.hora_llegada_vuelo, r.nombre_barco, r.hora_atraque,
            r.direccion_recogida, r.direccion_destino, r.notas_cliente,
            cv.nombre AS categoria_nombre,
            (SELECT COUNT(*) FROM reservas_mensajes_chofer rmc
             WHERE rmc.reserva_id = r.id AND rmc.autor = 'admin' AND rmc.leido = FALSE) AS mensajes_nuevos
     FROM reservas r
     LEFT JOIN categorias_vehiculos cv ON cv.id = r.categoria_id
     WHERE r.conductor_id = $1
       AND (r.archivada = FALSE OR r.archivada IS NULL)
       AND r.estado NOT IN ('cancelada', 'completada')
     ORDER BY r.fecha ASC, r.hora ASC`,
    [req.session.choferId]
  );
  // Preferencias del pasajero de cada reserva (copia guardada al reservar)
  const ids = result.rows.map(r => r.id);
  const prefsPorReserva = {};
  const extrasPorReserva = {};
  if (ids.length) {
    const prefs = await pool.query(
      'SELECT reserva_id, nombre, opcion, detalle FROM preferencias_reserva WHERE reserva_id = ANY($1) ORDER BY id',
      [ids]
    );
    prefs.rows.forEach(p => {
      (prefsPorReserva[p.reserva_id] = prefsPorReserva[p.reserva_id] || []).push(
        { nombre: p.nombre, opcion: p.opcion, detalle: p.detalle }
      );
    });
    const extras = await pool.query(
      `SELECT re.reserva_id, e.nombre, re.precio_en_reserva
       FROM reservas_extras re
       JOIN extras e ON e.id = re.extra_id
       WHERE re.reserva_id = ANY($1)
       ORDER BY e.bloque, e.orden`,
      [ids]
    );
    extras.rows.forEach(e => {
      (extrasPorReserva[e.reserva_id] = extrasPorReserva[e.reserva_id] || []).push(
        { nombre: e.nombre, precio: e.precio_en_reserva }
      );
    });
  }
  res.json({
    nombre: req.session.choferNombre,
    reservas: result.rows.map(r => Object.assign({}, r, {
      preferencias: prefsPorReserva[r.id] || [],
      extras: extrasPorReserva[r.id] || []
    }))
  });
}));

app.get('/chofer/mensajes/:reservaId', requireChofer, asyncHandler(async (req, res) => {
  // Verificar que la reserva pertenece a este chofer
  const check = await pool.query(
    'SELECT id FROM reservas WHERE id = $1 AND conductor_id = $2',
    [req.params.reservaId, req.session.choferId]
  );
  if (!check.rows.length) return res.status(403).json({ error: 'No autorizado.' });

  const result = await pool.query(
    'SELECT id, autor, mensaje, leido, creado_en FROM reservas_mensajes_chofer WHERE reserva_id = $1 ORDER BY creado_en ASC',
    [req.params.reservaId]
  );

  // Marcar como leídos
  await pool.query(
    "UPDATE reservas_mensajes_chofer SET leido = TRUE WHERE reserva_id = $1 AND autor = 'admin'",
    [req.params.reservaId]
  );

  res.json({ mensajes: result.rows });
}));

// ─── Redirección URL corta ────────────────────────────────────────────────────
app.get('/v/:codigo', asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT token_valoracion, tipo, reserva_id, url_destino FROM url_cortas WHERE codigo = $1',
    [req.params.codigo]
  );
  if (!result.rows.length) return res.status(404).send('Enlace no válido.');
  const row = result.rows[0];
  const tipo = row.tipo || 'valoracion';
  if (tipo === 'cartel') {
    const firma = firmarCartel(row.reserva_id);
    const urlDescarga = encodeURIComponent(`${BASE_URL}/cartel-descarga/${row.reserva_id}/${firma}`);
    return res.redirect(`${BASE_URL}/ver-cartel.html?url=${urlDescarga}`);
  }
  if (tipo === 'factura') {
    const firma = firmarFactura(row.reserva_id);
    const urlDescarga = encodeURIComponent(`${BASE_URL}/factura-descarga/${row.reserva_id}/${firma}`);
    return res.redirect(`${BASE_URL}/ver-factura.html?url=${urlDescarga}`);
  }
  if (tipo === 'pago') {
    if (!row.url_destino) return res.status(404).send('Enlace de pago no disponible.');
    const ogImagen = `${BASE_URL}/og-imagen/pago`;
    const urlDestino = row.url_destino;
    return res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta property="og:type" content="website">
<meta property="og:title" content="💳 Pagar depósito — Traslados GC">
<meta property="og:description" content="Toca para completar el pago de tu reserva de forma segura.">
<meta property="og:image" content="${ogImagen}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="400">
<meta property="og:url" content="${BASE_URL}/v/${req.params.codigo}">
<meta http-equiv="refresh" content="0;url=${urlDestino}">
<title>Redirigiendo al pago...</title>
</head>
<body>
<script>window.location.replace(${JSON.stringify(urlDestino)});</script>
</body>
</html>`);
  }
  res.redirect(`${BASE_URL}/valorar?token=${row.token_valoracion}`);
}));

// ─── Chofer: marcar servicio como completado ──────────────────────────────────
app.post('/chofer/reservas/:id/completar', requireChofer, asyncHandler(async (req, res) => {
  // Verificar que la reserva pertenece a este chofer y está confirmada
  const check = await pool.query(
    `SELECT r.id, r.numero_reserva, r.nombre_cliente, r.email_cliente, r.telefono_cliente,
            r.origen, r.destino, r.fecha
     FROM reservas r
     WHERE r.id = $1 AND r.conductor_id = $2 AND r.estado = 'confirmada'`,
    [req.params.id, req.session.choferId]
  );
  if (!check.rows.length) return res.status(400).json({ error: 'No se puede completar esta reserva.' });
  const r = check.rows[0];

  // Generar token único de valoración
  const token = crypto.randomBytes(32).toString('hex');

  // Generar código corto para WhatsApp (6 caracteres hex)
  let codigo = crypto.randomBytes(3).toString('hex');
  try {
    await pool.query(
      'INSERT INTO url_cortas (codigo, token_valoracion) VALUES ($1, $2)',
      [codigo, token]
    );
  } catch(e) {
    codigo = crypto.randomBytes(4).toString('hex');
    await pool.query(
      'INSERT INTO url_cortas (codigo, token_valoracion) VALUES ($1, $2)',
      [codigo, token]
    );
  }

  // Actualizar estado y guardar token
  await pool.query(
    `UPDATE reservas SET estado = 'completada', completada_en = NOW(), token_valoracion = $1 WHERE id = $2`,
    [token, r.id]
  );

  const enlace = `${BASE_URL}/valorar?token=${token}`;
  const enlaceCorto = `${BASE_URL}/v/${codigo}`;
  const fechaTexto = r.fecha ? new Date(r.fecha).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';

  // Email al cliente
  const _pval = await obtenerPlantilla('cliente_valoracion', {
    nombre_cliente: r.nombre_cliente,
    numero_reserva: r.numero_reserva,
    origen: r.origen || '—',
    destino: r.destino || '—',
    fecha: fechaTexto,
    url_valoracion: enlaceCorto
  });
  const html = plantillaEmail(
    (_pval && _pval.email) ||
    `<p>Hola <strong>${r.nombre_cliente}</strong>,</p>
     <p>Tu traslado ha finalizado. Nos gustaría saber cómo fue tu experiencia.</p>
     <div class="info-box">
       <strong>${r.origen} → ${r.destino}</strong><br>
       <span style="font-size:13px;color:#888;">Reserva ${r.numero_reserva} · ${fechaTexto}</span>
     </div>
     <p>Tu opinión nos ayuda a seguir mejorando el servicio. Solo te llevará un momento.</p>
     <p style="text-align:center;margin:24px 0;"><a href="${enlace}" class="boton">⭐ Valorar mi traslado</a></p>
     <p style="color:#888;font-size:13px;">Si no fuiste tú quien realizó este traslado, puedes ignorar este mensaje.</p>`
  );

  try {
    await enviarEmail({
      to: r.email_cliente,
      subject: (_pval && _pval.asunto) || (`¿Cómo fue tu traslado ${r.numero_reserva}?`),
      html
    });
  } catch(e) { console.warn('Error enviando email valoración:', e.message); }

  // WhatsApp al cliente
  if (r.telefono_cliente) {
    const textoWa = (_pval && _pval.whatsapp) || `Hola, ${r.nombre_cliente} 👋\n\nTu traslado ${r.numero_reserva} (${r.origen} → ${r.destino}) ha finalizado.\n\n¿Nos cuentas cómo fue? Tu opinión nos ayuda a mejorar:\n${enlaceCorto}`;
    try {
      await pool.query(
        'INSERT INTO whatsapp_mensajes_pendientes (telefono, texto) VALUES ($1, $2)',
        [r.telefono_cliente, textoWa]
      );
    } catch(e) { console.warn('Error encolando WhatsApp valoración:', e.message); }
  }

  res.json({ ok: true });
}));

// ─── Chofer: reportar no-show ─────────────────────────────────────────────────
app.post('/chofer/reservas/:id/no-show', requireChofer, asyncHandler(async (req, res) => {
  const check = await pool.query(
    `SELECT r.id, r.numero_reserva, r.nombre_cliente, r.email_cliente, r.telefono_cliente,
            r.origen, r.destino, r.fecha, r.deposito_pagado, r.deposito_importe
     FROM reservas r
     WHERE r.id = $1 AND r.conductor_id = $2 AND r.estado = 'confirmada'`,
    [req.params.id, req.session.choferId]
  );
  if (!check.rows.length) return res.status(400).json({ error: 'No se puede reportar no-show para esta reserva.' });
  const r = check.rows[0];

  // Actualizar estado y depósito
  await pool.query(
    `UPDATE reservas SET estado = 'no_show', deposito_retenido_noshow = TRUE WHERE id = $1`,
    [r.id]
  );

  const fechaTexto = r.fecha ? new Date(r.fecha).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
  const importe = r.deposito_importe || '10';

  // Email al cliente
  try {
    const _pns1 = await obtenerPlantilla('cliente_deposito_noshow', {
      nombre_cliente: r.nombre_cliente,
      numero_reserva: r.numero_reserva,
      origen: r.origen || '—',
      destino: r.destino || '—',
      fecha: fechaTexto,
      importe: importe
    });
    await enviarEmail({
      to: r.email_cliente,
      subject: (_pns1 && _pns1.asunto) || ('🔒 Depósito retenido por no-show — ' + r.numero_reserva),
      html: plantillaEmail(
        (_pns1 && _pns1.email) ||
        `<p>Hola <strong>${r.nombre_cliente}</strong> 👋</p>
         <div class="caja-roja">
           <p style="margin:0 0 8px 0;font-weight:700;font-size:15px;">🔒 Depósito retenido por no-show</p>
           <p style="margin:0;font-size:14px;line-height:1.6;">Lamentamos informarte de que tu traslado <strong>${r.numero_reserva}</strong> (${r.origen || '—'} → ${r.destino || '—'}) del ${fechaTexto} no pudo realizarse al no haberse presentado en el punto de recogida.<br><br>De acuerdo con nuestra política de reservas, el depósito de garantía de ${importe} € ha sido retenido por no-show.</p>
         </div>
         <div class="info-box">
           <strong>Ruta:</strong> ${r.origen || '—'} → ${r.destino || '—'}<br>
           <strong>Fecha del servicio:</strong> ${fechaTexto}<br>
           <strong>Reserva:</strong> <span class="pnr">${r.numero_reserva}</span>
         </div>
         <p>Si crees que ha habido un error, no dudes en contactarnos.<br><br>Un saludo cordial,<br><strong>El equipo de Traslados GC</strong></p>`
      )
    });
  } catch(e) { console.warn('Error enviando email no-show:', e.message); }

  // WhatsApp al cliente
  if (r.telefono_cliente) {
    try {
      const _pns1wa = await obtenerPlantilla('cliente_deposito_noshow', {
        nombre_cliente: r.nombre_cliente,
        numero_reserva: r.numero_reserva,
        origen: r.origen || '—',
        destino: r.destino || '—',
        fecha: fechaTexto,
        importe: importe
      });
      const textoWa = (_pns1wa && _pns1wa.whatsapp) || `Hola, ${r.nombre_cliente} 👋\n\nTu traslado ${r.numero_reserva} (${r.origen || '—'} → ${r.destino || '—'}) no pudo realizarse al no presentarse en el punto de recogida. El depósito de garantía ha sido retenido según nuestra política de reservas.\n\nSi crees que ha habido un error, contáctanos. Un saludo 🙏`;
      await pool.query(
        'INSERT INTO whatsapp_mensajes_pendientes (telefono, texto) VALUES ($1, $2)',
        [r.telefono_cliente, textoWa]
      );
    } catch(e) { console.warn('Error encolando WhatsApp no-show:', e.message); }
  }

  res.json({ ok: true });
}));

// ─── Valoración pública (enlace único por token) ──────────────────────────────
app.get('/valorar', (req, res) => {
  res.sendFile(__dirname + '/public/valorar.html');
});

app.get('/api/valoracion/info', asyncHandler(async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Token requerido.' });
  const result = await pool.query(
    `SELECT r.id, r.numero_reserva, r.origen, r.destino, r.nombre_cliente,
            (SELECT id FROM valoraciones WHERE reserva_id = r.id) AS ya_valorada
     FROM reservas r
     WHERE r.token_valoracion = $1 AND r.estado = 'completada'`,
    [token]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Enlace no válido.' });
  res.json(result.rows[0]);
}));

app.post('/api/valoracion/enviar', asyncHandler(async (req, res) => {
  const { token, estrellas_conductor, estrellas_servicio, comentario } = req.body;
  if (!token) return res.status(400).json({ error: 'Token requerido.' });

  const result = await pool.query(
    'SELECT id FROM reservas WHERE token_valoracion = $1 AND estado = \'completada\'',
    [token]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Enlace no válido.' });
  const reservaId = result.rows[0].id;

  const ec = parseInt(estrellas_conductor, 10);
  const es = parseInt(estrellas_servicio, 10);
  if (!ec || !es || ec < 1 || ec > 5 || es < 1 || es > 5) {
    return res.status(400).json({ error: 'Las valoraciones deben ser de 1 a 5 estrellas.' });
  }

  await pool.query(
    `INSERT INTO valoraciones (reserva_id, estrellas_conductor, estrellas_servicio, comentario)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (reserva_id) DO UPDATE SET estrellas_conductor = $2, estrellas_servicio = $3, comentario = $4`,
    [reservaId, ec, es, comentario || null]
  );

  res.json({ ok: true });
}));

app.get('/chofer/cartel/:id', requireChofer, asyncHandler(async (req, res) => {
  // Verificar que la reserva está asignada a este chofer
  const check = await pool.query(
    'SELECT id FROM reservas WHERE id = $1 AND conductor_id = $2',
    [req.params.id, req.session.choferId]
  );
  if (!check.rows.length) return res.status(403).json({ error: 'No autorizado.' });

  const cartel = await generarCartelPDF(req.params.id);
  if (!cartel) return res.status(404).json({ error: 'No se pudo generar el cartel.' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="cartel-' + req.params.id + '.pdf"');
  res.send(cartel.buffer);
}));

// ─── Admin: valoraciones ─────────────────────────────────────────────────────
app.get('/admin/valoraciones', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT va.id, va.estrellas_conductor, va.estrellas_servicio, va.comentario, va.creado_en,
            r.numero_reserva, r.nombre_cliente,
            c.nombre AS nombre_chofer
     FROM valoraciones va
     JOIN reservas r ON r.id = va.reserva_id
     LEFT JOIN conductores c ON c.id = r.conductor_id
     ORDER BY va.creado_en DESC
     LIMIT 100`
  );
  res.json({ valoraciones: rows });
}));

// ─── Admin: eliminar valoraciones ────────────────────────────────────────────
app.delete('/admin/valoraciones/:id', requireAdmin, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM valoraciones WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

app.delete('/admin/valoraciones', requireAdmin, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM valoraciones');
  res.json({ ok: true });
}));

// ─── Admin: configuración no-show ────────────────────────────────────────────

// Obtener toda la configuración (general + temporadas)
app.get('/admin/noshow', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM configuracion_noshow ORDER BY es_general DESC, fecha_inicio ASC'
  );
  res.json({ configuracion: result.rows });
}));

// Guardar configuración general
app.post('/admin/noshow/general', requireAdmin, asyncHandler(async (req, res) => {
  const { importe_deposito, horas_cancelacion } = req.body;
  await pool.query(
    'UPDATE configuracion_noshow SET importe_deposito = $1, horas_cancelacion = $2 WHERE es_general = TRUE',
    [importe_deposito, horas_cancelacion]
  );
  res.json({ ok: true });
}));

// Crear temporada
app.post('/admin/noshow/temporada', requireAdmin, asyncHandler(async (req, res) => {
  const { nombre, fecha_inicio, fecha_fin, importe_deposito, horas_cancelacion } = req.body;
  if (!nombre || !fecha_inicio || !fecha_fin || !importe_deposito || !horas_cancelacion) {
    return res.status(400).json({ error: 'Todos los campos son obligatorios.' });
  }
  if (fecha_inicio >= fecha_fin) {
    return res.status(400).json({ error: 'La fecha de inicio debe ser anterior a la fecha de fin.' });
  }
  await pool.query(
    `INSERT INTO configuracion_noshow (nombre, es_general, fecha_inicio, fecha_fin, importe_deposito, horas_cancelacion)
     VALUES ($1, FALSE, $2, $3, $4, $5)`,
    [nombre, fecha_inicio, fecha_fin, importe_deposito, horas_cancelacion]
  );
  res.json({ ok: true });
}));

// Editar temporada
app.post('/admin/noshow/temporada/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { nombre, fecha_inicio, fecha_fin, importe_deposito, horas_cancelacion, activa } = req.body;
  await pool.query(
    `UPDATE configuracion_noshow SET nombre=$1, fecha_inicio=$2, fecha_fin=$3,
     importe_deposito=$4, horas_cancelacion=$5, activa=$6 WHERE id=$7 AND es_general=FALSE`,
    [nombre, fecha_inicio, fecha_fin, importe_deposito, horas_cancelacion, activa !== false, req.params.id]
  );
  res.json({ ok: true });
}));

// Eliminar temporada
app.delete('/admin/noshow/temporada/:id', requireAdmin, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM configuracion_noshow WHERE id=$1 AND es_general=FALSE', [req.params.id]);
  res.json({ ok: true });
}));

// Consultar condiciones aplicables a una fecha (usado al confirmar reserva)
app.get('/admin/noshow/para-fecha/:fecha', requireAdmin, asyncHandler(async (req, res) => {
  const { fecha } = req.params;
  // Buscar temporada activa que cubra esa fecha
  const temporada = await pool.query(
    `SELECT * FROM configuracion_noshow
     WHERE es_general = FALSE AND activa = TRUE
     AND fecha_inicio <= $1 AND fecha_fin >= $1
     ORDER BY fecha_inicio DESC LIMIT 1`,
    [fecha]
  );
  if (temporada.rows.length) {
    return res.json({ condiciones: temporada.rows[0], fuente: 'temporada' });
  }
  // Fallback a configuración general
  const general = await pool.query('SELECT * FROM configuracion_noshow WHERE es_general = TRUE LIMIT 1');
  res.json({ condiciones: general.rows[0], fuente: 'general' });
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

// Helper: obtener texto de interfaz traducido para un idioma
async function obtenerTextoTraducido(clave, lang) {
  const resultado = await pool.query(
    `SELECT COALESCE(tit.texto, ti.texto_es) AS texto
     FROM textos_interfaz ti
     LEFT JOIN textos_interfaz_traducciones tit ON tit.texto_id = ti.id AND tit.lang_code = $2
     WHERE ti.clave = $1`,
    [clave, lang]
  );
  return resultado.rows.length ? resultado.rows[0].texto : '';
}

// Helper: obtener múltiples textos de una vez
async function obtenerTextosTraducidos(claves, lang) {
  const resultado = await pool.query(
    `SELECT ti.clave, COALESCE(tit.texto, ti.texto_es) AS texto
     FROM textos_interfaz ti
     LEFT JOIN textos_interfaz_traducciones tit ON tit.texto_id = ti.id AND tit.lang_code = $2
     WHERE ti.clave = ANY($1)`,
    [claves, lang]
  );
  const mapa = {};
  resultado.rows.forEach(function(r) { mapa[r.clave] = r.texto; });
  return mapa;
}

// ─── API pública: cotizaciones ───────────────────────────────────────────────

app.post('/api/cotizaciones', asyncHandler(async (req, res) => {
  const { origen, destino, fecha_aproximada, num_pasajeros, email_cliente, lang_cliente } = req.body;
  if (!origen || !destino || !email_cliente) {
    return res.status(400).json({ error: 'Faltan datos obligatorios.' });
  }
  // Detectar idioma: del campo enviado o del header Accept-Language
  let lang = lang_cliente || 'es';
  if (!lang_cliente) {
    const acceptLang = req.headers['accept-language'] || '';
    const match = acceptLang.match(/^([a-z]{2})/i);
    if (match) lang = match[1].toLowerCase();
  }
  // Solo aceptar idiomas conocidos, fallback a 'es'
  const idiomasValidos = await pool.query('SELECT codigo FROM idiomas_web WHERE activo = TRUE');
  const codigos = idiomasValidos.rows.map(function(r) { return r.codigo; });
  if (!codigos.includes(lang)) lang = 'es';

  const result = await pool.query(
    `INSERT INTO cotizaciones (origen, destino, fecha_aproximada, num_pasajeros, email_cliente, lang_cliente)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [origen.trim(), destino.trim(), fecha_aproximada || null, num_pasajeros || null, email_cliente.trim().toLowerCase(), lang]
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

app.get('/admin/conductores/pendientes-count', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query(
    "SELECT COUNT(*) AS total FROM conductores WHERE estado = 'pendiente'"
  );
  res.json({ total: parseInt(result.rows[0].total) });
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

  const html = plantillaEmail(
    `<p>Hola <strong>${c.nombre_cliente || ''}</strong>,</p>
     <p>Gracias por contactarnos. Aquí tienes los precios disponibles para tu traslado:</p>
     <div class="info-box">
       <strong>Origen:</strong> ${c.origen}<br>
       <strong>Destino:</strong> ${c.destino}<br>
       <strong>Fecha aproximada:</strong> ${fechaViaje}
       ${c.num_pasajeros ? '<br><strong>Pasajeros:</strong> ' + c.num_pasajeros : ''}
     </div>
     <p><strong>Opciones disponibles:</strong></p>
     <table style="width:100%;border-collapse:collapse;margin:12px 0;">
       <thead><tr style="background:#2c2c2c;"><th style="color:#fff;padding:8px 12px;text-align:left;font-size:13px;">Categoría</th><th style="color:#fff;padding:8px 12px;text-align:left;font-size:13px;">Capacidad</th><th style="color:#fff;padding:8px 12px;text-align:left;font-size:13px;">Precio estimado</th></tr></thead>
       <tbody>${filasPrecios}</tbody>
     </table>
     <p style="font-size:12px;color:#999;margin-top:16px;line-height:1.6;">El precio indicado es una estimación. El cobro lo realiza el conductor directamente al finalizar el servicio.</p>
     <p style="text-align:center;margin:24px 0;"><a href="https://traslados-gc.onrender.com" class="boton">Ver todas las rutas</a></p>`
  );

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

// Listar rutas activas con sus slugs SEO por idioma (para el selector de respuesta positiva)
app.get('/admin/cotizaciones/rutas-activas', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT r.id, r.origen, r.destino,
            json_object_agg(rss.lang_code, rss.slug_url) AS slugs
     FROM rutas r
     JOIN route_seo_settings rss ON rss.route_id = r.id AND rss.activo = TRUE
     WHERE r.activa = TRUE
     GROUP BY r.id, r.origen, r.destino
     ORDER BY r.origen, r.destino`
  );
  res.json({ rutas: result.rows });
}));

// Respuesta negativa — email simple al cliente
app.post('/admin/cotizaciones/:id/respuesta-negativa', requireAdmin, asyncHandler(async (req, res) => {
  const { lang_respuesta } = req.body;
  const cotiz = await pool.query('SELECT * FROM cotizaciones WHERE id = $1', [req.params.id]);
  if (!cotiz.rows.length) return res.status(404).json({ error: 'Cotización no encontrada' });
  const c = cotiz.rows[0];

  const lang = lang_respuesta || c.lang_cliente || 'es';

  // Obtener textos traducidos desde textos_interfaz
  const t = await obtenerTextosTraducidos([
    'email_cotiz_asunto_negativo', 'email_cotiz_saludo',
    'email_cotiz_negativo_p1', 'email_cotiz_negativo_p2',
    'email_cotiz_negativo_p3', 'email_cotiz_despedida'
  ], lang);

  const textoNegativo = {
    asunto:    t['email_cotiz_asunto_negativo'] || 'Tu solicitud de traslado',
    saludo:    t['email_cotiz_saludo'] || 'Hola,',
    parrafo1:  t['email_cotiz_negativo_p1'] || 'Gracias por contactar con Traslados GC.',
    parrafo2:  t['email_cotiz_negativo_p2'] || 'Lamentablemente, no podemos asumir el traslado que nos solicitaste:',
    parrafo3:  t['email_cotiz_negativo_p3'] || 'Si tienes otras necesidades de transporte en Gran Canaria, no dudes en contactarnos.',
    despedida: t['email_cotiz_despedida'] || 'Un saludo, el equipo de Traslados GC'
  };

  const fechaViaje = c.fecha_aproximada ? new Date(c.fecha_aproximada).toLocaleDateString('es-ES') : null;

  const html = plantillaEmail(
    `<p>${textoNegativo.saludo}</p>
     <p>${textoNegativo.parrafo1}</p>
     <p>${textoNegativo.parrafo2}</p>
     <div class="info-box">
       <strong>${c.origen} → ${c.destino}</strong>
       ${fechaViaje ? '<br><span style="font-size:13px;color:#888;">' + fechaViaje + '</span>' : ''}
     </div>
     <p>${textoNegativo.parrafo3}</p>
     <p>${textoNegativo.despedida}</p>`
  );

  try {
    await enviarEmail({ to: c.email_cliente, subject: textoNegativo.asunto, html });
    await pool.query(
      "UPDATE cotizaciones SET estado = 'no_disponible', respuesta_enviada = TRUE WHERE id = $1",
      [req.params.id]
    );
    res.json({ ok: true });
  } catch(err) {
    res.status(500).json({ error: 'Error enviando email: ' + err.message });
  }
}));

// Respuesta positiva con enlace a ruta específica en el idioma del cliente
app.post('/admin/cotizaciones/:id/respuesta-positiva', requireAdmin, asyncHandler(async (req, res) => {
  const { ruta_id, lang_respuesta } = req.body;
  if (!ruta_id) return res.status(400).json({ error: 'Selecciona una ruta del sistema.' });

  const cotiz = await pool.query('SELECT * FROM cotizaciones WHERE id = $1', [req.params.id]);
  if (!cotiz.rows.length) return res.status(404).json({ error: 'Cotización no encontrada' });
  const c = cotiz.rows[0];

  const lang = lang_respuesta || c.lang_cliente || 'es';

  // Obtener la ficha SEO de la ruta en ese idioma
  const seoResult = await pool.query(
    `SELECT rss.slug_url, i.palabra_traslado, r.origen, r.destino
     FROM route_seo_settings rss
     JOIN rutas r ON r.id = rss.route_id
     JOIN idiomas_web i ON i.codigo = rss.lang_code
     WHERE rss.route_id = $1 AND rss.lang_code = $2 AND rss.activo = TRUE`,
    [ruta_id, lang]
  );

  // Fallback a español si no hay ficha en ese idioma
  let seo = seoResult.rows[0];
  if (!seo) {
    const seoEs = await pool.query(
      `SELECT rss.slug_url, i.palabra_traslado, r.origen, r.destino
       FROM route_seo_settings rss
       JOIN rutas r ON r.id = rss.route_id
       JOIN idiomas_web i ON i.codigo = rss.lang_code
       WHERE rss.route_id = $1 AND rss.lang_code = 'es' AND rss.activo = TRUE`,
      [ruta_id]
    );
    seo = seoEs.rows[0];
  }
  if (!seo) return res.status(400).json({ error: 'La ruta no tiene página activa. Actívala en SEO primero.' });

  const BASE_URL = process.env.BASE_URL || 'https://traslados-gc.onrender.com';
  const urlRuta = BASE_URL + '/' + lang + '/' + seo.palabra_traslado + '/' + seo.slug_url;

  // Obtener precios con IDs de categoría para traducción
  const preciosResult = await pool.query(
    `SELECT cv.id AS categoria_id, cv.nombre, cv.capacidad_pasajeros, cp.precio
     FROM cotizaciones_precios cp
     JOIN categorias_vehiculos cv ON cv.id = cp.categoria_id
     WHERE cp.cotizacion_id = $1
     ORDER BY cv.orden, cv.nombre`,
    [req.params.id]
  );

  // Obtener textos traducidos desde textos_interfaz
  const clavesTextos = [
    'email_cotiz_asunto_positivo', 'email_cotiz_saludo',
    'email_cotiz_positivo_p1', 'email_cotiz_positivo_p2', 'email_cotiz_positivo_p3',
    'email_cotiz_boton_reservar', 'email_cotiz_nota_precio', 'email_cotiz_despedida',
    'email_cotiz_col_categoria', 'email_cotiz_col_capacidad', 'email_cotiz_col_precio',
    'sufijo_pax'
  ];
  // Añadir claves de nombres de categorías
  preciosResult.rows.forEach(function(p) {
    clavesTextos.push('categoria_nombre_' + p.categoria_id);
  });

  const t = await obtenerTextosTraducidos(clavesTextos, lang);

  const textos = {
    asunto:       t['email_cotiz_asunto_positivo'] || 'Tu traslado en Gran Canaria — precios disponibles',
    saludo:       t['email_cotiz_saludo'] || 'Hola,',
    parrafo1:     t['email_cotiz_positivo_p1'] || 'Tenemos buenas noticias. Podemos asumir tu traslado.',
    parrafo2:     t['email_cotiz_positivo_p2'] || 'Aquí tienes los precios disponibles para tu ruta:',
    col_categoria:t['email_cotiz_col_categoria'] || 'Categoría',
    col_capacidad:t['email_cotiz_col_capacidad'] || 'Capacidad',
    col_precio:   t['email_cotiz_col_precio'] || 'Precio est.',
    parrafo3:     t['email_cotiz_positivo_p3'] || 'Pulsa el botón para ver todos los detalles y hacer tu reserva.',
    boton:        t['email_cotiz_boton_reservar'] || 'Ver ruta y reservar',
    nota:         t['email_cotiz_nota_precio'] || 'El precio es una estimación basada en los km de distancia.',
    despedida:    t['email_cotiz_despedida'] || 'Un saludo, el equipo de Traslados GC',
    pax:          t['sufijo_pax'] || 'pax'
  };

  const fechaViaje = c.fecha_aproximada ? new Date(c.fecha_aproximada).toLocaleDateString('es-ES') : null;

  const filasPrecios = preciosResult.rows.map(function(p) {
    var nombreCat = t['categoria_nombre_' + p.categoria_id] || p.nombre;
    return '<tr>' +
      '<td style="padding:8px 12px;border-bottom:1px solid #eee;">' + nombreCat + '</td>' +
      '<td style="padding:8px 12px;border-bottom:1px solid #eee;">' + p.capacidad_pasajeros + ' ' + textos.pax + '</td>' +
      '<td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600;">' + parseFloat(p.precio).toFixed(2) + ' €</td>' +
    '</tr>';
  }).join('');

  const html = plantillaEmail(
    `<p>${textos.saludo}</p>
     <p>${textos.parrafo1}</p>
     <div class="info-box">
       <strong>${seo.origen} → ${seo.destino}</strong>
       ${fechaViaje ? '<br><span style="font-size:13px;color:#888;">' + fechaViaje + '</span>' : ''}
       ${c.num_pasajeros ? '<br><span style="font-size:13px;color:#888;">' + c.num_pasajeros + ' pax</span>' : ''}
     </div>
     ${preciosResult.rows.length ? `<p>${textos.parrafo2}</p>
     <table style="width:100%;border-collapse:collapse;margin:12px 0;">
       <thead><tr style="background:#2c2c2c;"><th style="color:#fff;padding:8px 12px;text-align:left;font-size:13px;">${textos.col_categoria}</th><th style="color:#fff;padding:8px 12px;text-align:left;font-size:13px;">${textos.col_capacidad}</th><th style="color:#fff;padding:8px 12px;text-align:left;font-size:13px;">${textos.col_precio}</th></tr></thead>
       <tbody>${filasPrecios}</tbody>
     </table>` : ''}
     <p>${textos.parrafo3}</p>
     <p style="text-align:center;"><a href="${urlRuta}" class="boton">${textos.boton}</a></p>
     <p style="font-size:12px;color:#999;margin-top:16px;line-height:1.6;">${textos.nota}</p>
     <p>${textos.despedida}</p>`
  );

  try {
    await enviarEmail({ to: c.email_cliente, subject: textos.asunto, html });
    await pool.query(
      "UPDATE cotizaciones SET estado = 'respondida', respuesta_enviada = TRUE WHERE id = $1",
      [req.params.id]
    );
    res.json({ ok: true, url_ruta: urlRuta });
  } catch(err) {
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

  // Archivadas o activas (incluir NULL como no archivada)
  if (archivo === 'si') {
    condiciones.push('r.archivada = TRUE');
  } else {
    condiciones.push('(r.archivada = FALSE OR r.archivada IS NULL)');
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
            r.conductor_id, r.deposito_pagado, r.deposito_liberado, r.deposito_devolucion_pendiente, r.deposito_retenido_noshow,
            cv.nombre AS categoria_nombre,
            c.nombre AS conductor_nombre,
            COALESCE((
              SELECT SUM(re.precio_en_reserva)
              FROM reservas_extras re WHERE re.reserva_id = r.id
            ), 0) AS total_extras,
            COALESCE((
              SELECT COUNT(*) FROM reservas_mensajes rm
              WHERE rm.reserva_id = r.id AND rm.autor = 'cliente' AND rm.leido = FALSE
            ), 0) AS mensajes_sin_leer
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
    condiciones.push('(r.archivada = FALSE OR r.archivada IS NULL)');
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
    `SELECT re.extra_id, e.nombre, re.precio_en_reserva
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
  const estadosValidos = ['pendiente', 'confirmada', 'completada', 'cancelada', 'modificacion_pendiente', 'no_show'];
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

// Asigna un chofer a una reserva: la confirma, registra el motivo si lo hay,
// y manda el email de confirmación con el enlace de pago del depósito.
// La usan tanto el botón manual del admin como el puente de WhatsApp.
async function asignarChoferAReserva(reservaIdParam, conductor_id, motivo) {
  // Al asignar chofer → estado pasa a Confirmada
  await pool.query(
    'UPDATE reservas SET conductor_id = $1, estado = $2 WHERE id = $3',
    [conductor_id, 'confirmada', reservaIdParam]
  );

  // Registrar en historial de chofer
  if (motivo) {
    await pool.query(
      `INSERT INTO reservas_historial_chofer (reserva_id, conductor_id, motivo)
       VALUES ($1, $2, $3)`,
      [reservaIdParam, conductor_id, motivo]
    );
  }

  // Enviar email de confirmación automáticamente
  try {
    const reserva = await pool.query(
      `SELECT r.*, cv.nombre AS categoria_nombre, c.nombre AS conductor_nombre
       FROM reservas r
       LEFT JOIN categorias_vehiculos cv ON cv.id = r.categoria_id
       LEFT JOIN conductores c ON c.id = $1
       WHERE r.id = $2`,
      [conductor_id, reservaIdParam]
    );

    if (reserva.rows.length) {
      const r = reserva.rows[0];
      const noshow = await pool.query(
        `SELECT * FROM configuracion_noshow
         WHERE es_general = FALSE AND activa = TRUE
         AND fecha_inicio <= $1 AND fecha_fin >= $1
         ORDER BY fecha_inicio DESC LIMIT 1`,
        [r.fecha]
      );
      let condiciones = noshow.rows[0];
      if (!condiciones) {
        const general = await pool.query('SELECT * FROM configuracion_noshow WHERE es_general = TRUE LIMIT 1');
        condiciones = general.rows[0];
      }

      const importe = condiciones ? parseFloat(condiciones.importe_deposito).toFixed(2) : '10.00';
      const horas = condiciones ? condiciones.horas_cancelacion : 12;
      const fechaViaje = r.fecha ? new Date(r.fecha).toLocaleDateString('es-ES', {day:'numeric', month:'long', year:'numeric'}) : '';
      const _fechaLimiteCancelEmail = calcularFechaCancelacion(new Date(r.fecha), r.hora, horas);
      const _textoLimiteCancelEmail = _fechaLimiteCancelEmail.toLocaleDateString('es-ES', {day:'numeric', month:'long', year:'numeric'}) + ' a las ' + _fechaLimiteCancelEmail.toLocaleTimeString('es-ES', {hour:'2-digit', minute:'2-digit'});

      // Crear sesión de pago en Stripe si está configurado
      let urlPago = null;
      if (stripe) {
        try {
          const BASE_URL = process.env.BASE_URL || 'https://traslados-gc.onrender.com';
          const lang = r.lang_cliente || 'es';
          const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'payment',
            locale: lang,
            line_items: [{
              price_data: {
                currency: 'eur',
                unit_amount: Math.round(parseFloat(condiciones ? condiciones.importe_deposito : 10) * 100),
                product_data: {
                  name: 'Depósito de garantía — Traslado ' + r.numero_reserva,
                  description: (r.origen || '') + ' → ' + (r.destino || '') + (fechaViaje ? ' · ' + fechaViaje : '')
                }
              },
              quantity: 1
            }],
            customer_email: r.email_cliente,
            success_url: BASE_URL + '/pago-exitoso?reserva=' + r.numero_reserva + '&session_id={CHECKOUT_SESSION_ID}',
            cancel_url: BASE_URL + '/pago-cancelado?reserva=' + r.numero_reserva,
            metadata: { reserva_id: String(r.id), numero_reserva: r.numero_reserva }
          });
          urlPago = session.url;
          await pool.query('UPDATE reservas SET stripe_session_id = $1 WHERE id = $2', [session.id, r.id]);
        } catch(stripeErr) {
          console.warn('Error creando sesión Stripe:', stripeErr.message);
        }
      }

      const botonPago = urlPago
        ? `<div style="text-align:center;margin:24px 0;">
            <a href="${urlPago}" style="background:#C1502E;color:#fff;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">💳 Pagar depósito de ${importe} €</a>
           </div>`
        : `<p style="color:#888;font-size:13px;">Para completar la reserva, contacta con nosotros por WhatsApp para realizar el pago del depósito.</p>`;

      const _pc1 = await obtenerPlantilla('cliente_confirmacion', {
        nombre_cliente: r.nombre_cliente,
        numero_reserva: r.numero_reserva,
        origen: r.origen || '—',
        destino: r.destino || '—',
        fecha: fechaViaje,
        hora: r.hora ? r.hora.slice(0,5) : '—',
        categoria: r.categoria_nombre || '—',
        conductor: r.conductor_nombre || '',
        importe_deposito: importe,
        horas_cancelacion: horas,
        fecha_limite_cancelacion: _textoLimiteCancelEmail,
        boton_pago: botonPago
      });
      const html = plantillaEmail(
        (_pc1 && _pc1.email) ||
        `<p>Hola <strong>${r.nombre_cliente}</strong>,</p>
         <p>¡Tu traslado está confirmado! Hemos asignado un conductor para tu servicio.</p>
         <p style="text-align:center;margin:20px 0;">Reserva <span class="pnr">${r.numero_reserva}</span></p>
         <div class="info-box">
           <strong>Detalles del traslado:</strong><br>
           Origen: ${r.origen || '—'}<br>
           Destino: ${r.destino || '—'}<br>
           Fecha: ${fechaViaje}<br>
           Hora: ${r.hora ? r.hora.slice(0,5) : '—'}<br>
           Categoría: ${r.categoria_nombre || '—'}<br>
           ${r.conductor_nombre ? 'Conductor: ' + r.conductor_nombre : ''}
         </div>
         <div class="caja-verde">
           <p style="margin:0 0 8px 0;font-weight:600;">💳 Depósito de garantía — ${importe} €</p>
           <p style="margin:0 0 8px 0;font-size:13px;">Para garantizar tu plaza, realiza el pago del depósito de <strong>${importe} €</strong>. El voucher de tu traslado te llegará automáticamente al confirmar el pago.</p>
           <p style="margin:0 0 8px 0;font-size:13px;"><strong>⚠️ Importante:</strong> Si no recibimos el pago ${horas} horas antes de tu traslado, la reserva será cancelada.</p>
           <p style="margin:0 0 6px 0;font-size:12px;">El depósito te será devuelto íntegramente una vez completado el servicio.</p>
           <p style="margin:0;font-size:12px;"><strong>Cancelación gratuita hasta el ${_textoLimiteCancelEmail}.</strong> Después de esa fecha, el depósito de ${importe} € no será reembolsable.</p>
         </div>
         ${botonPago}
         <p style="font-size:13px;color:#888;">Nos pondremos en contacto contigo por WhatsApp para coordinar todos los detalles del servicio.</p>
         <p style="font-size:12px;color:#aaa;margin-top:12px;">💡 Puedes consultar el estado de tu reserva en cualquier momento desde <a href="${process.env.BASE_URL || 'https://traslados-gc.onrender.com'}/mi-reserva" style="color:#C1502E;">Mi Reserva</a>.</p>`
      );

      await enviarEmail({
        to: r.email_cliente,
        subject: (_pc1 && _pc1.asunto) || ('Traslado confirmado — ' + r.numero_reserva),
        html
      });
      await pool.query(
        'UPDATE reservas SET email_confirmacion_enviado = TRUE WHERE id = $1',
        [reservaIdParam]
      );
    }
  } catch(emailErr) {
    console.warn('Error enviando email confirmación automática:', emailErr.message);
  }

  // WhatsApp de confirmación al cliente
  try {
    if (r && r.telefono_cliente) {
      const _pc1wa = await obtenerPlantilla('cliente_confirmacion', {
        nombre_cliente: r.nombre_cliente,
        numero_reserva: r.numero_reserva,
        origen: r.origen || '—',
        destino: r.destino || '—',
        fecha: r.fecha ? new Date(r.fecha).toLocaleDateString('es-ES', {day:'numeric', month:'long', year:'numeric'}) : '—',
        hora: r.hora ? r.hora.slice(0,5) : '—',
        categoria: r.categoria_nombre || '—',
        importe_deposito: typeof importe !== 'undefined' ? importe : '',
        url_pago: typeof urlPago !== 'undefined' && urlPago ? urlPago : ''
      });
      const textoWa = (_pc1wa && _pc1wa.whatsapp) ||
        ('¡Tu traslado ' + r.numero_reserva + ' está confirmado! Hemos asignado un conductor para tu servicio. Revisa tu email para todos los detalles y el enlace de pago del depósito.');
      await pool.query(
        'INSERT INTO whatsapp_mensajes_pendientes (telefono, texto) VALUES ($1, $2)',
        [r.telefono_cliente, textoWa]
      );
    }
  } catch(waErr) {
    console.warn('Error encolando WhatsApp confirmación al cliente:', waErr.message);
  }
}

// Asignar chofer manualmente a una reserva
app.post('/admin/reservas/:id/chofer', requireAdmin, asyncHandler(async (req, res) => {
  const { conductor_id, motivo } = req.body;

  if (conductor_id) {
    await asignarChoferAReserva(req.params.id, conductor_id, motivo);
  } else {
    // Si se quita el chofer → vuelve a Pendiente
    await pool.query(
      'UPDATE reservas SET conductor_id = NULL, estado = $1 WHERE id = $2',
      ['pendiente', req.params.id]
    );
  }
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

// ─── Helper: generar HTML del voucher ────────────────────────────────────────
async function generarHtmlVoucher(reservaId) {
  const result = await pool.query(
    `SELECT r.*, cv.nombre AS categoria_nombre,
            c.nombre AS conductor_nombre, c.foto AS conductor_foto, c.foto_estado AS conductor_foto_estado
     FROM reservas r
     LEFT JOIN categorias_vehiculos cv ON cv.id = r.categoria_id
     LEFT JOIN conductores c ON c.id = r.conductor_id
     WHERE r.id = $1`,
    [reservaId]
  );
  if (!result.rows.length) return null;
  const r = result.rows[0];
  const fechaViaje = r.fecha ? new Date(r.fecha).toLocaleDateString('es-ES', {day:'numeric', month:'long', year:'numeric'}) : '';

  // Extras de la reserva
  const extrasResult = await pool.query(
    `SELECT e.nombre, re.precio_en_reserva FROM reservas_extras re
     JOIN extras e ON e.id = re.extra_id
     WHERE re.reserva_id = $1 ORDER BY e.bloque, e.orden`,
    [reservaId]
  );
  const extrasReserva = extrasResult.rows;
  const extrasIncluidos = extrasReserva.filter(e => !parseFloat(e.precio_en_reserva) || parseFloat(e.precio_en_reserva) === 0);
  const extrasACobrar = extrasReserva.filter(e => parseFloat(e.precio_en_reserva) > 0);
  const totalExtras = extrasACobrar.reduce((sum, e) => sum + parseFloat(e.precio_en_reserva), 0);

  const extrasHtml = extrasReserva.length ? `
    <br><strong>Extras:</strong>
    ${extrasIncluidos.map(e => `<br>&nbsp;&nbsp;· ${e.nombre} <span style="color:#2e7d32;font-size:12px;">(incluido)</span>`).join('')}
    ${extrasACobrar.map(e => `<br>&nbsp;&nbsp;· ${e.nombre} <span style="color:#856404;font-size:12px;">(${parseFloat(e.precio_en_reserva).toFixed(2)} € — a pagar al conductor al final del servicio)</span>`).join('')}
  ` : '';

  const totalExtrasHtml = extrasACobrar.length ? `
    <div style="background:#fff8e1;border:1px solid #D9A441;border-radius:6px;padding:10px 14px;margin-top:12px;font-size:13px;color:#1C1815;">
      <strong>💰 Total de extras a pagar al conductor: ${totalExtras.toFixed(2)} €</strong><br>
      <span style="font-size:12px;color:#555;">Este importe se abona directamente al conductor al final del servicio, aparte del precio del traslado.</span>
    </div>` : '';

  // Fecha límite de cancelación gratuita para el voucher
  const _cfgNoshowVoucher = await obtenerConfigNoshow(r.fecha);
  const _fechaLimiteVoucher = calcularFechaCancelacion(new Date(r.fecha), r.hora, _cfgNoshowVoucher.horas_cancelacion);
  const _importeVoucher = parseFloat(_cfgNoshowVoucher.importe_deposito).toFixed(2);
  const _textoLimiteVoucher = _fechaLimiteVoucher.toLocaleDateString('es-ES', {day:'numeric', month:'long', year:'numeric'}) + ' a las ' + _fechaLimiteVoucher.toLocaleTimeString('es-ES', {hour:'2-digit', minute:'2-digit'});

  // Foto del chofer solo si está aprobada
  const slugChofer = r.conductor_nombre
    ? r.conductor_nombre.trim().toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .split(/\s+/).slice(0, 2).join('-')
        .replace(/[^a-z0-9-]/g, '') + '-' + r.conductor_id
    : null;
  const fotoChoferHtml = (r.conductor_foto && r.conductor_foto_estado === 'aprobada' && slugChofer)
    ? `<div style="text-align:center;margin:16px 0;">
        <img src="${BASE_URL}/foto-chofer/${slugChofer}" alt="Foto del conductor" style="width:90px;height:90px;object-fit:cover;border-radius:50%;border:3px solid #d4956a;">
        <p style="margin:6px 0 0 0;font-size:13px;font-weight:600;color:#2c2c2c;">${r.conductor_nombre || ''}</p>
        <p style="margin:2px 0 0 0;font-size:11px;color:#888;">Tu conductor</p>
       </div>`
    : (r.conductor_nombre ? `<p style="text-align:center;font-size:13px;font-weight:600;margin:12px 0;"><strong>Conductor:</strong> ${r.conductor_nombre}</p>` : '');

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <style>
    body{margin:0;padding:0;background:#f5f5f5;}
    .wrapper{max-width:600px;margin:0 auto;background:#fff;}
    .header{background:#2c2c2c;padding:24px;text-align:center;}
    .body{padding:28px 24px;}
    .pnr{font-family:monospace;font-size:22px;font-weight:700;color:#C1502E;letter-spacing:3px;}
    .voucher-box{border:2px solid #d4956a;border-radius:10px;padding:20px;margin:20px 0;}
    .info-box{background:#f5f0ea;border-radius:8px;padding:14px 18px;font-size:14px;line-height:1.8;}
    .pagado{background:#d1e7dd;border-radius:6px;padding:10px 16px;margin:16px 0;color:#0f5132;font-size:13px;}
    .footer{background:#f5f0ea;padding:16px;text-align:center;font-size:12px;color:#888;}
    @media(max-width:480px){.body{padding:16px;}}
  </style></head><body>
  <div class="wrapper">
    <div class="header">
      <h1 style="color:#d4956a;margin:0;font-size:20px;">Traslados GC</h1>
      <p style="color:#aaa;margin:4px 0 0;font-size:12px;">Gran Canaria</p>
    </div>
    <div class="body">
      <p>Hola <strong>${r.nombre_cliente}</strong>,</p>
      <div class="pagado">✔ Depósito recibido. Tu traslado está confirmado.</div>
      <div class="voucher-box">
        <p style="text-align:center;margin:0 0 12px 0;font-size:11px;color:#888;letter-spacing:1px;text-transform:uppercase;">Voucher de Traslado</p>
        <p style="text-align:center;margin:0 0 16px 0;">Nº <span class="pnr">${r.numero_reserva}</span></p>
        ${fotoChoferHtml}
        <div class="info-box">
          <strong>Origen:</strong> ${r.origen || '—'}<br>
          <strong>Destino:</strong> ${r.destino || '—'}<br>
          <strong>Fecha:</strong> ${fechaViaje}<br>
          <strong>Hora:</strong> ${r.hora ? r.hora.slice(0,5) : '—'}<br>
          <strong>Categoría:</strong> ${r.categoria_nombre || '—'}<br>
          <strong>Pasajeros:</strong> ${r.num_pasajeros || '—'}${r.direccion_recogida ? '<br><strong>Dirección de recogida:</strong> ' + r.direccion_recogida : ''}${r.direccion_destino ? '<br><strong>Dirección de destino:</strong> ' + r.direccion_destino : ''}${r.numero_vuelo ? '<br><strong>Vuelo:</strong> ' + r.numero_vuelo + (r.hora_llegada_vuelo ? ' · Llegada ' + r.hora_llegada_vuelo.slice(0,5) : '') : ''}${r.nombre_barco ? '<br><strong>Barco:</strong> ' + r.nombre_barco + (r.hora_atraque ? ' · Atraque ' + r.hora_atraque.slice(0,5) : '') : ''}${r.notas_cliente ? '<br><strong>Notas:</strong> ' + r.notas_cliente : ''}${extrasHtml}
        </div>
        ${totalExtrasHtml}
      </div>
      <p style="font-size:13px;color:#888;">Muestra este voucher a tu conductor al inicio del servicio. El precio final será el que marque el taxímetro.</p>
      <div style="background:#fff3cd;border-radius:6px;padding:10px 14px;margin-top:14px;font-size:12px;color:#856404;">
        <strong>⚠️ Cancelación gratuita hasta el ${_textoLimiteVoucher}.</strong> Después de esa fecha, el depósito de ${_importeVoucher} € no será reembolsado.
      </div>
    </div>
    <div class="footer">Traslados GC · Gran Canaria</div>
  </div></body></html>`;
}

// ─── Helper: generar voucher PDF para el cliente ─────────────────────────────
async function generarVoucherPDF(reservaId) {
  const result = await pool.query(
    `SELECT r.*, cv.nombre AS categoria_nombre,
            c.id AS conductor_id, c.nombre AS conductor_nombre, c.foto AS conductor_foto, c.foto_estado AS conductor_foto_estado
     FROM reservas r
     LEFT JOIN categorias_vehiculos cv ON cv.id = r.categoria_id
     LEFT JOIN conductores c ON c.id = r.conductor_id
     WHERE r.id = $1`,
    [reservaId]
  );
  if (!result.rows.length) return null;
  const r = result.rows[0];

  const fechaViaje = r.fecha ? new Date(r.fecha).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }) : '\u2014';

  const extrasResult = await pool.query(
    `SELECT e.nombre, re.precio_en_reserva FROM reservas_extras re
     JOIN extras e ON e.id = re.extra_id
     WHERE re.reserva_id = $1 ORDER BY e.bloque, e.orden`,
    [reservaId]
  );
  const extrasReserva = extrasResult.rows;
  const extrasIncluidos = extrasReserva.filter(e => !parseFloat(e.precio_en_reserva) || parseFloat(e.precio_en_reserva) === 0);
  const extrasACobrar = extrasReserva.filter(e => parseFloat(e.precio_en_reserva) > 0);
  const totalExtras = extrasACobrar.reduce((sum, e) => sum + parseFloat(e.precio_en_reserva), 0);

  const _cfgNoshow = await obtenerConfigNoshow(r.fecha);
  const _fechaLimite = calcularFechaCancelacion(new Date(r.fecha), r.hora, _cfgNoshow.horas_cancelacion);
  const _importe = parseFloat(_cfgNoshow.importe_deposito).toFixed(2);
  const _textoLimite = _fechaLimite.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }) +
    ' a las ' + _fechaLimite.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

  let fotoChoferBuffer = null;
  if (r.conductor_foto && r.conductor_foto_estado === 'aprobada' && r.conductor_foto.startsWith('data:image/')) {
    try { fotoChoferBuffer = Buffer.from(r.conductor_foto.split(',')[1], 'base64'); } catch(e) { fotoChoferBuffer = null; }
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'portrait', margin: 0 });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), numero_reserva: r.numero_reserva }));
    doc.on('error', reject);

    const PW = doc.page.width;
    const PH = doc.page.height;
    const ML = 40;
    const W  = PW - ML * 2;
    let y = 0;

    // Cabecera
    doc.rect(0, 0, PW, 72).fill('#2c2c2c');
    doc.fontSize(18).font('Helvetica-Bold').fillColor('#d4956a').text('Traslados GC', ML, 18, { align: 'center', width: W });
    doc.fontSize(10).font('Helvetica').fillColor('#aaaaaa').text('Gran Canaria', ML, 42, { align: 'center', width: W });
    y = 90;

    // Saludo
    doc.fontSize(12).font('Helvetica').fillColor('#1C1815').text('Hola ', ML, y, { continued: true }).font('Helvetica-Bold').text(r.nombre_cliente + ',');
    y = doc.y + 10;

    // Caja verde dep\u00f3sito
    doc.rect(ML, y, W, 28).fill('#d1e7dd');
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#0f5132').text('Dep\u00f3sito recibido. Tu traslado est\u00e1 confirmado.', ML + 10, y + 8, { width: W - 20 });
    y += 28 + 14;

    // Voucher box
    const yInicioVoucher = y;
    const bordeVoucher = '#d4956a';

    doc.fontSize(9).font('Helvetica').fillColor('#888888').text('Voucher de Traslado', ML + 16, y + 10, { align: 'center', width: W - 32 });
    y += 26;

    doc.fontSize(20).font('Helvetica-Bold').fillColor('#C1502E').text('N\u00BA ' + r.numero_reserva, ML + 16, y, { align: 'center', width: W - 32 });
    y = doc.y + 12;

    // Foto conductor
    if (fotoChoferBuffer) {
      const fotoSize = 72;
      const fotoX = (PW - fotoSize) / 2;
      try {
        doc.save();
        doc.circle(fotoX + fotoSize / 2, y + fotoSize / 2, fotoSize / 2).clip();
        doc.image(fotoChoferBuffer, fotoX, y, { width: fotoSize, height: fotoSize });
        doc.restore();
        doc.circle(fotoX + fotoSize / 2, y + fotoSize / 2, fotoSize / 2).lineWidth(2).strokeColor(bordeVoucher).stroke();
        y += fotoSize + 6;
        doc.fontSize(11).font('Helvetica-Bold').fillColor('#2c2c2c').text(r.conductor_nombre || '', ML + 16, y, { align: 'center', width: W - 32 });
        y = doc.y + 2;
        doc.fontSize(9).font('Helvetica').fillColor('#888888').text('Tu conductor', ML + 16, y, { align: 'center', width: W - 32 });
        y = doc.y + 12;
      } catch(e) { y += 8; }
    } else if (r.conductor_nombre) {
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#1C1815').text('Conductor: ' + r.conductor_nombre, ML + 16, y, { align: 'center', width: W - 32 });
      y = doc.y + 12;
    }

    // Info box: fondo primero, texto encima
    const infoX = ML + 16;
    const infoW = W - 32;
    const lineas = [];
    lineas.push({ l: 'Origen', v: r.origen || '\u2014' });
    lineas.push({ l: 'Destino', v: r.destino || '\u2014' });
    lineas.push({ l: 'Fecha', v: fechaViaje });
    lineas.push({ l: 'Hora', v: r.hora ? r.hora.slice(0, 5) : '\u2014' });
    lineas.push({ l: 'Categor\u00eda', v: r.categoria_nombre || '\u2014' });
    lineas.push({ l: 'Pasajeros', v: String(r.num_pasajeros || '\u2014') });
    if (r.direccion_recogida) lineas.push({ l: 'Direcci\u00f3n de recogida', v: r.direccion_recogida });
    if (r.direccion_destino)  lineas.push({ l: 'Direcci\u00f3n de destino', v: r.direccion_destino });
    if (r.numero_vuelo) lineas.push({ l: 'Vuelo', v: r.numero_vuelo + (r.hora_llegada_vuelo ? ' \u00b7 Llegada ' + r.hora_llegada_vuelo.slice(0, 5) : '') });
    if (r.nombre_barco) lineas.push({ l: 'Barco', v: r.nombre_barco + (r.hora_atraque ? ' \u00b7 Atraque ' + r.hora_atraque.slice(0, 5) : '') });
    if (r.notas_cliente) lineas.push({ l: 'Notas', v: r.notas_cliente });

    const altoLinea = 18;
    const altoExtrasEst = extrasReserva.length ? (20 + extrasReserva.length * 16) : 0;
    const altoInfo = lineas.length * altoLinea + altoExtrasEst + 20;

    doc.rect(infoX, y, infoW, altoInfo).fill('#f5f0ea');

    let yInfo = y + 10;
    lineas.forEach(({ l, v }) => {
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#1C1815').text(l + ': ', infoX + 8, yInfo, { continued: true, width: infoW - 16 });
      doc.font('Helvetica').fillColor('#333333').text(v, { width: infoW - 16 });
      yInfo = doc.y + 3;
    });

    if (extrasReserva.length) {
      yInfo += 4;
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#1C1815').text('Extras:', infoX + 8, yInfo);
      yInfo = doc.y + 2;
      extrasIncluidos.forEach(e => {
        doc.fontSize(10).font('Helvetica').fillColor('#1C1815').text('  \u00b7 ' + e.nombre + ' ', infoX + 8, yInfo, { continued: true });
        doc.fillColor('#2e7d32').text('(incluido)');
        yInfo = doc.y + 2;
      });
      extrasACobrar.forEach(e => {
        doc.fontSize(10).font('Helvetica').fillColor('#1C1815').text('  \u00b7 ' + e.nombre + ' ', infoX + 8, yInfo, { continued: true });
        doc.fillColor('#856404').text('(' + parseFloat(e.precio_en_reserva).toFixed(2) + ' \u20ac \u2014 a pagar al conductor al final del servicio)');
        yInfo = doc.y + 2;
      });
    }

    y = yInfo + 12;

    // Total extras
    if (extrasACobrar.length) {
      const altoTotal = 44;
      doc.rect(ML, y, W, altoTotal).fill('#fff8e1');
      doc.rect(ML, y, W, altoTotal).lineWidth(0.5).strokeColor('#D9A441').stroke();
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#1C1815')
        .text('\u2022 Total de extras a pagar al conductor: ' + totalExtras.toFixed(2) + ' \u20ac', ML + 10, y + 8, { width: W - 20 });
      doc.fontSize(9).font('Helvetica').fillColor('#555555')
        .text('Este importe se abona directamente al conductor al final del servicio, aparte del precio del traslado.', ML + 10, y + 24, { width: W - 20 });
      y += altoTotal + 8;
    }

    // Cierre caja voucher
    const yFinVoucher = y + 8;
    doc.rect(ML, yInicioVoucher, W, yFinVoucher - yInicioVoucher).lineWidth(2).strokeColor(bordeVoucher).stroke();
    y = yFinVoucher + 14;

    // Nota pie
    doc.fontSize(10).font('Helvetica').fillColor('#888888')
      .text('Muestra este voucher a tu conductor al inicio del servicio. El precio final ser\u00e1 el que marque el tax\u00edmetro.', ML, y, { width: W });
    y = doc.y + 10;

    // Caja cancelaci\u00f3n
    const altoCancelacion = 44;
    doc.rect(ML, y, W, altoCancelacion).fill('#fff3cd');
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#856404')
      .text('\u2022 Cancelaci\u00f3n gratuita hasta el ' + _textoLimite + '.', ML + 10, y + 8, { width: W - 20 });
    doc.fontSize(10).font('Helvetica').fillColor('#856404')
      .text('Despu\u00e9s de esa fecha, el dep\u00f3sito de ' + _importe + ' \u20ac no ser\u00e1 reembolsado.', ML + 10, y + 24, { width: W - 20 });
    y += altoCancelacion + 14;

    // Footer
    doc.rect(0, PH - 36, PW, 36).fill('#f5f0ea');
    doc.fontSize(10).font('Helvetica').fillColor('#888888')
      .text('Traslados GC \u00b7 Gran Canaria', ML, PH - 22, { align: 'center', width: W });

    doc.end();
  });
}


async function generarCartelPDF(reservaId) {
  const result = await pool.query(
    `SELECT r.*, c.nombre AS conductor_nombre, c.email AS conductor_email
     FROM reservas r
     LEFT JOIN conductores c ON c.id = r.conductor_id
     WHERE r.id = $1`,
    [reservaId]
  );
  if (!result.rows.length) return null;
  const r = result.rows[0];

  const nombreParaCartel = (r.es_para_otra_persona && r.nombre_pasajero_otro)
    ? r.nombre_pasajero_otro : r.nombre_cliente;
  const partes = (nombreParaCartel || '').trim().split(/\s+/);
  const nombreCartel = (partes.length >= 2
    ? partes[0] + ' ' + partes[1] : partes[0] || '').toUpperCase();

  return new Promise((resolve, reject) => {
    // A4 horizontal: 841.89 x 595.28 pts
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 40 });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve({
      buffer: Buffer.concat(chunks),
      conductor_email: r.conductor_email,
      conductor_nombre: r.conductor_nombre,
      numero_reserva: r.numero_reserva
    }));
    doc.on('error', reject);

    const W = doc.page.width;
    const H = doc.page.height;

    // "TRASLADOS GC" pequeño centrado arriba en terracota
    doc.fontSize(14).font('Helvetica-Bold').fillColor('#C1502E')
      .text('TRASLADOS GC', 0, 40, { align: 'center', width: W });

    // Nombre del cliente muy grande centrado verticalmente
    const tamNombre = nombreCartel.length > 14 ? 90 : nombreCartel.length > 10 ? 120 : nombreCartel.length > 7 ? 150 : 180;
    const yNombre = (H / 2) - (tamNombre * 0.4);
    doc.fontSize(tamNombre).font('Helvetica-Bold').fillColor('#1C1815')
      .text(nombreCartel, 40, yNombre, { align: 'center', width: W - 80, lineBreak: false });

    doc.end();
  });
}

// ─── Stripe: pagos ────────────────────────────────────────────────────────────

// Crear sesión de pago en Stripe para el depósito de una reserva
app.post('/admin/reservas/:id/stripe-session', requireAdmin, asyncHandler(async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe no configurado. Añade STRIPE_SECRET_KEY en Render.' });

  const reserva = await pool.query('SELECT * FROM reservas WHERE id = $1', [req.params.id]);
  if (!reserva.rows.length) return res.status(404).json({ error: 'Reserva no encontrada' });
  const r = reserva.rows[0];

  // Obtener importe del depósito según fecha del viaje
  const noshow = await pool.query(
    `SELECT * FROM configuracion_noshow
     WHERE es_general = FALSE AND activa = TRUE
     AND fecha_inicio <= $1 AND fecha_fin >= $1
     ORDER BY fecha_inicio DESC LIMIT 1`,
    [r.fecha]
  );
  let condiciones = noshow.rows[0];
  if (!condiciones) {
    const general = await pool.query('SELECT * FROM configuracion_noshow WHERE es_general = TRUE LIMIT 1');
    condiciones = general.rows[0];
  }
  const importe = condiciones ? Math.round(parseFloat(condiciones.importe_deposito) * 100) : 1000; // en céntimos

  // Detectar idioma de la reserva para Stripe
  const lang = r.lang_cliente || 'es';
  const BASE_URL = process.env.BASE_URL || 'https://traslados-gc.onrender.com';

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    mode: 'payment',
    locale: lang,
    line_items: [{
      price_data: {
        currency: 'eur',
        unit_amount: importe,
        product_data: {
          name: 'Depósito de garantía — Traslado ' + r.numero_reserva,
          description: (r.origen || '') + ' → ' + (r.destino || '') +
            (r.fecha ? ' · ' + new Date(r.fecha).toLocaleDateString('es-ES') : '')
        }
      },
      quantity: 1
    }],
    customer_email: r.email_cliente,
    success_url: BASE_URL + '/pago-exitoso?reserva=' + r.numero_reserva + '&session_id={CHECKOUT_SESSION_ID}',
    cancel_url: BASE_URL + '/pago-cancelado?reserva=' + r.numero_reserva,
    metadata: { reserva_id: String(r.id), numero_reserva: r.numero_reserva }
  });

  // Guardar session_id en la reserva
  await pool.query('UPDATE reservas SET stripe_session_id = $1 WHERE id = $2', [session.id, r.id]);

  res.json({ ok: true, url: session.url });
}));

// Webhook de Stripe — recibe confirmaciones de pago
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), asyncHandler(async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    if (webhookSecret) {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(400).send('Webhook error: ' + err.message);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const reservaId = session.metadata && session.metadata.reserva_id;
    if (!reservaId) return res.json({ received: true });

    // Marcar depósito como pagado
    await pool.query(
      'UPDATE reservas SET deposito_pagado = TRUE WHERE id = $1',
      [reservaId]
    );

    // Obtener datos de la reserva para el voucher
    const reserva = await pool.query(
      `SELECT r.*, cv.nombre AS categoria_nombre, c.nombre AS conductor_nombre
       FROM reservas r
       LEFT JOIN categorias_vehiculos cv ON cv.id = r.categoria_id
       LEFT JOIN conductores c ON c.id = r.conductor_id
       WHERE r.id = $1`,
      [reservaId]
    );

    if (reserva.rows.length) {
      const r = reserva.rows[0];
      try {
        const htmlVoucher = await generarHtmlVoucher(reservaId);
        const _pvA = await obtenerPlantilla('cliente_voucher', {
          nombre_cliente: r.nombre_cliente,
          numero_reserva: r.numero_reserva
        });
        if (htmlVoucher) {
          await enviarEmail({
            to: r.email_cliente,
            subject: (_pvA && _pvA.asunto) || ('✔ Voucher de traslado — ' + r.numero_reserva),
            html: htmlVoucher
          });
          await pool.query('UPDATE reservas SET email_voucher_enviado = TRUE WHERE id = $1', [reservaId]);
        }
        // WhatsApp voucher al cliente
        if (r.telefono_cliente) {
          try {
            const firma = firmarVoucher(reservaId);
            const nombreDoc = `voucher-${r.numero_reserva}.pdf`;
            const urlDoc = `${BASE_URL}/voucher-descarga/${reservaId}/${firma}/${nombreDoc}`;
            const textoWaVoucherA = (_pvA && _pvA.whatsapp) || `Hola, ${r.nombre_cliente} 👋\n\nTe adjuntamos el voucher de tu traslado ${r.numero_reserva}.\n\nTraslados GC`;
            await pool.query(
              'INSERT INTO whatsapp_mensajes_pendientes (telefono, texto, url_documento, nombre_documento) VALUES ($1, $2, $3, $4)',
              [r.telefono_cliente, textoWaVoucherA, urlDoc, nombreDoc]
            );
          } catch(e) { console.warn('Error encolando WhatsApp voucher:', e.message); }
        }
        // Enviar cartel PDF al chofer
        const cartelPdf = await generarCartelPDF(reservaId);
        if (cartelPdf && cartelPdf.conductor_email) {
          const _pccA = await obtenerPlantilla('chofer_cartel', {
            nombre_chofer: cartelPdf.conductor_nombre || '',
            numero_reserva: r.numero_reserva,
            origen: r.origen || '—',
            destino: r.destino || '—',
            fecha: r.fecha ? new Date(r.fecha).toLocaleDateString('es-ES', {day:'numeric', month:'long', year:'numeric'}) : '—',
            hora: r.hora ? r.hora.slice(0,5) : '—'
          });
          await enviarEmailConAdjunto({
            to: cartelPdf.conductor_email,
            subject: (_pccA && _pccA.asunto) || ('Cartel de recogida — ' + r.numero_reserva),
            html: plantillaEmail((_pccA && _pccA.email) || ('<p>Hola ' + (cartelPdf.conductor_nombre || '') + ',</p><p>Adjuntamos el cartel de recogida para tu próximo servicio. Imprímelo y úsalo para identificar a tu cliente.</p><p>Reserva: <strong>' + r.numero_reserva + '</strong></p>')),
            adjunto: { filename: 'cartel-' + r.numero_reserva + '.pdf', content: cartelPdf.buffer }
          });
        }
      } catch(emailErr) {
        console.warn('Error enviando voucher/cartel automático:', emailErr.message);
      }
    }
  }

  if (event.type === 'checkout.session.expired' || event.type === 'payment_intent.payment_failed') {
    const session = event.data.object;
    const reservaId = session.metadata && session.metadata.reserva_id;
    if (!reservaId) return res.json({ received: true });

    const reserva = await pool.query('SELECT * FROM reservas WHERE id = $1', [reservaId]);
    if (reserva.rows.length) {
      const r = reserva.rows[0];
      try {
        await enviarEmail({
          to: r.email_cliente,
          subject: 'Problema con el pago — ' + r.numero_reserva,
          html: plantillaEmail(
            `<p>Hola <strong>${r.nombre_cliente}</strong>,</p>
             <p>No hemos podido procesar el pago del depósito para tu reserva <strong>${r.numero_reserva}</strong>.</p>
             <div class="caja-amarilla">⚠️ Por favor contacta con nosotros por WhatsApp para resolver el pago y confirmar tu traslado.</div>
             <p style="color:#888;font-size:13px;">Si crees que es un error, puedes intentarlo de nuevo.</p>`
          )
        });
      } catch(emailErr) {
        console.warn('Error enviando aviso de pago fallido:', emailErr.message);
      }
    }
  }

  res.json({ received: true });
}));

// Páginas de retorno de Stripe
app.get('/pago-exitoso', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Pago completado</title>
  <style>body{font-family:Arial,sans-serif;text-align:center;padding:60px 20px;background:#f5f5f5;}
  .box{background:#fff;border-radius:12px;padding:40px;max-width:480px;margin:0 auto;}
  .icono{font-size:48px;margin-bottom:16px;}h1{color:#2d7a4f;}p{color:#555;}</style>
  </head><body><div class="box">
  <div class="icono">✅</div>
  <h1>¡Pago completado!</h1>
  <p>Tu depósito ha sido procesado correctamente. En breve recibirás el voucher de tu traslado en tu email.</p>
  <p style="font-size:13px;color:#aaa;">Reserva: <strong>${req.query.reserva || ''}</strong></p>
  <a href="/" style="display:inline-block;margin-top:24px;background:#C1502E;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;">Volver al inicio</a>
  </div></body></html>`);
});

app.get('/pago-cancelado', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Pago cancelado</title>
  <style>body{font-family:Arial,sans-serif;text-align:center;padding:60px 20px;background:#f5f5f5;}
  .box{background:#fff;border-radius:12px;padding:40px;max-width:480px;margin:0 auto;}
  .icono{font-size:48px;margin-bottom:16px;}h1{color:#842029;}p{color:#555;}</style>
  </head><body><div class="box">
  <div class="icono">❌</div>
  <h1>Pago cancelado</h1>
  <p>No se ha procesado ningún cobro. Si necesitas ayuda para completar el pago, contáctanos por WhatsApp.</p>
  <p style="font-size:13px;color:#aaa;">Reserva: <strong>${req.query.reserva || ''}</strong></p>
  <a href="/" style="display:inline-block;margin-top:24px;background:#C1502E;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;">Volver al inicio</a>
  </div></body></html>`);
});

// ─── Admin: emails de reserva ────────────────────────────────────────────────

app.post('/admin/reservas/:id/email-confirmacion', requireAdmin, asyncHandler(async (req, res) => {
  const reserva = await pool.query(
    `SELECT r.*, cv.nombre AS categoria_nombre, c.nombre AS conductor_nombre
     FROM reservas r
     LEFT JOIN categorias_vehiculos cv ON cv.id = r.categoria_id
     LEFT JOIN conductores c ON c.id = r.conductor_id
     WHERE r.id = $1`,
    [req.params.id]
  );
  if (!reserva.rows.length) return res.status(404).json({ error: 'Reserva no encontrada' });
  const r = reserva.rows[0];

  // Obtener condiciones de no-show para la fecha del viaje
  const noshow = await pool.query(
    `SELECT * FROM configuracion_noshow
     WHERE es_general = FALSE AND activa = TRUE
     AND fecha_inicio <= $1 AND fecha_fin >= $1
     ORDER BY fecha_inicio DESC LIMIT 1`,
    [r.fecha]
  );
  let condiciones = noshow.rows[0];
  if (!condiciones) {
    const general = await pool.query('SELECT * FROM configuracion_noshow WHERE es_general = TRUE LIMIT 1');
    condiciones = general.rows[0];
  }

  const importe = condiciones ? parseFloat(condiciones.importe_deposito).toFixed(2) : '10.00';
  const horas = condiciones ? condiciones.horas_cancelacion : 12;
  const fechaViaje = r.fecha ? new Date(r.fecha).toLocaleDateString('es-ES', {day:'numeric', month:'long', year:'numeric'}) : '';
  const _fechaLimiteCancelEmail = calcularFechaCancelacion(new Date(r.fecha), r.hora, horas);
  const _textoLimiteCancelEmail = _fechaLimiteCancelEmail.toLocaleDateString('es-ES', {day:'numeric', month:'long', year:'numeric'}) + ' a las ' + _fechaLimiteCancelEmail.toLocaleTimeString('es-ES', {hour:'2-digit', minute:'2-digit'});

  // Crear sesión de pago en Stripe si está configurado
  let urlPago = null;
  if (stripe) {
    try {
      const BASE_URL = process.env.BASE_URL || 'https://traslados-gc.onrender.com';
      const lang = r.lang_cliente || 'es';
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'payment',
        locale: lang,
        line_items: [{
          price_data: {
            currency: 'eur',
            unit_amount: Math.round(parseFloat(condiciones ? condiciones.importe_deposito : 10) * 100),
            product_data: {
              name: 'Depósito de garantía — Traslado ' + r.numero_reserva,
              description: (r.origen || '') + ' → ' + (r.destino || '') +
                (r.fecha ? ' · ' + fechaViaje : '')
            }
          },
          quantity: 1
        }],
        customer_email: r.email_cliente,
        success_url: BASE_URL + '/pago-exitoso?reserva=' + r.numero_reserva + '&session_id={CHECKOUT_SESSION_ID}',
        cancel_url: BASE_URL + '/pago-cancelado?reserva=' + r.numero_reserva,
        metadata: { reserva_id: String(r.id), numero_reserva: r.numero_reserva }
      });
      urlPago = session.url;
      await pool.query('UPDATE reservas SET stripe_session_id = $1 WHERE id = $2', [session.id, r.id]);
    } catch(stripeErr) {
      console.warn('Error creando sesión Stripe:', stripeErr.message);
    }
  }

  const botonPago = urlPago
    ? `<div style="text-align:center;margin:24px 0;">
        <a href="${urlPago}" style="background:#C1502E;color:#fff;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">💳 Pagar depósito de ${importe} €</a>
       </div>`
    : `<p style="color:#888;font-size:13px;">Para completar la reserva, contacta con nosotros por WhatsApp para realizar el pago del depósito.</p>`;

  const _pc2 = await obtenerPlantilla('cliente_confirmacion', {
    nombre_cliente: r.nombre_cliente,
    numero_reserva: r.numero_reserva,
    origen: r.origen || '—',
    destino: r.destino || '—',
    fecha: fechaViaje,
    hora: r.hora ? r.hora.slice(0,5) : '—',
    categoria: r.categoria_nombre || '—',
    conductor: r.conductor_nombre || '',
    importe_deposito: importe,
    horas_cancelacion: horas,
    fecha_limite_cancelacion: _textoLimiteCancelEmail,
    boton_pago: botonPago
  });
  const html = plantillaEmail(
    (_pc2 && _pc2.email) ||
    `<p>Hola <strong>${r.nombre_cliente}</strong>,</p>
     <p>¡Tu traslado está confirmado! Hemos asignado un conductor para tu servicio.</p>
     <p style="text-align:center;margin:20px 0;">Reserva <span class="pnr">${r.numero_reserva}</span></p>
     <div class="info-box">
       <strong>Detalles del traslado:</strong><br>
       Origen: ${r.origen || '—'}<br>
       Destino: ${r.destino || '—'}<br>
       Fecha: ${fechaViaje}<br>
       Hora: ${r.hora ? r.hora.slice(0,5) : '—'}<br>
       Categoría: ${r.categoria_nombre || '—'}<br>
       ${r.conductor_nombre ? 'Conductor: ' + r.conductor_nombre : ''}
     </div>
     <div class="caja-verde">
       <p style="margin:0 0 8px 0;font-weight:600;">💳 Depósito de garantía — ${importe} €</p>
       <p style="margin:0 0 8px 0;font-size:13px;">Para garantizar tu plaza, realiza el pago del depósito de <strong>${importe} €</strong>. El voucher de tu traslado te llegará automáticamente al confirmar el pago.</p>
       <p style="margin:0 0 8px 0;font-size:13px;"><strong>⚠️ Importante:</strong> Si no recibimos el pago ${horas} horas antes de tu traslado, la reserva será cancelada.</p>
       <p style="margin:0;font-size:12px;">El depósito te será devuelto íntegramente una vez completado el servicio. No es reembolsable en caso de no presentarse o cancelar con menos de ${horas} horas de antelación.</p>
     </div>
     ${botonPago}
     <p style="font-size:13px;color:#888;">Nos pondremos en contacto contigo por WhatsApp para coordinar todos los detalles del servicio.</p>`
  );

  try {
    await enviarEmail({
      to: r.email_cliente,
      subject: (_pc2 && _pc2.asunto) || ('Traslado confirmado — ' + r.numero_reserva),
      html
    });
    await pool.query(
      'UPDATE reservas SET email_confirmacion_enviado = TRUE WHERE id = $1',
      [req.params.id]
    );
  } catch(err) {
    console.warn('Error enviando email confirmación manual:', err.message);
    return res.status(500).json({ error: 'Error enviando email: ' + err.message });
  }

  // WhatsApp de confirmación al cliente
  try {
    if (r.telefono_cliente) {
      const _pc2wa = await obtenerPlantilla('cliente_confirmacion', {
        nombre_cliente: r.nombre_cliente,
        numero_reserva: r.numero_reserva,
        origen: r.origen || '—',
        destino: r.destino || '—',
        fecha: r.fecha ? new Date(r.fecha).toLocaleDateString('es-ES', {day:'numeric', month:'long', year:'numeric'}) : '—',
        hora: r.hora ? r.hora.slice(0,5) : '—',
        categoria: r.categoria_nombre || '—',
        importe_deposito: importe,
        horas_cancelacion: horas,
        fecha_limite_cancelacion: _textoLimiteCancelEmail,
        url_pago: urlPago || ''
      });
      const textoWa = (_pc2wa && _pc2wa.whatsapp) ||
        ('¡Tu traslado ' + r.numero_reserva + ' está confirmado! Revisa tu email para ver los detalles y el enlace de pago del depósito.');
      await pool.query(
        'INSERT INTO whatsapp_mensajes_pendientes (telefono, texto) VALUES ($1, $2)',
        [r.telefono_cliente, textoWa]
      );
    }
  } catch(waErr) {
    console.warn('Error encolando WhatsApp confirmación manual:', waErr.message);
  }

  res.json({ ok: true, url_pago: urlPago });
}));

app.post('/admin/reservas/:id/reenviar-pago', requireAdmin, asyncHandler(async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe no configurado.' });

  const reserva = await pool.query('SELECT * FROM reservas WHERE id = $1', [req.params.id]);
  if (!reserva.rows.length) return res.status(404).json({ error: 'Reserva no encontrada' });
  const r = reserva.rows[0];

  if (r.deposito_pagado) return res.status(400).json({ error: 'El depósito ya fue pagado.' });

  // Obtener importe según fecha
  const noshow = await pool.query(
    `SELECT * FROM configuracion_noshow
     WHERE es_general = FALSE AND activa = TRUE
     AND fecha_inicio <= $1 AND fecha_fin >= $1
     ORDER BY fecha_inicio DESC LIMIT 1`,
    [r.fecha]
  );
  let condiciones = noshow.rows[0];
  if (!condiciones) {
    const general = await pool.query('SELECT * FROM configuracion_noshow WHERE es_general = TRUE LIMIT 1');
    condiciones = general.rows[0];
  }

  const importe = condiciones ? parseFloat(condiciones.importe_deposito).toFixed(2) : '10.00';
  const fechaViaje = r.fecha ? new Date(r.fecha).toLocaleDateString('es-ES', {day:'numeric', month:'long', year:'numeric'}) : '';
  const BASE_URL = process.env.BASE_URL || 'https://traslados-gc.onrender.com';
  const lang = r.lang_cliente || 'es';

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    mode: 'payment',
    locale: lang,
    line_items: [{
      price_data: {
        currency: 'eur',
        unit_amount: Math.round(parseFloat(condiciones ? condiciones.importe_deposito : 10) * 100),
        product_data: {
          name: 'Depósito de garantía — Traslado ' + r.numero_reserva,
          description: (r.origen || '') + ' → ' + (r.destino || '') + (fechaViaje ? ' · ' + fechaViaje : '')
        }
      },
      quantity: 1
    }],
    customer_email: r.email_cliente,
    success_url: BASE_URL + '/pago-exitoso?reserva=' + r.numero_reserva + '&session_id={CHECKOUT_SESSION_ID}',
    cancel_url: BASE_URL + '/pago-cancelado?reserva=' + r.numero_reserva,
    metadata: { reserva_id: String(r.id), numero_reserva: r.numero_reserva }
  });

  await pool.query('UPDATE reservas SET stripe_session_id = $1 WHERE id = $2', [session.id, r.id]);

  // Enviar email con nuevo enlace
  const botonPagoReenvio = `<p style="text-align:center;margin:24px 0;"><a href="${session.url}" class="boton">💳 Pagar depósito de ${importe} €</a></p>`;
  const _pep = await obtenerPlantilla('cliente_enlace_pago', {
    nombre_cliente: r.nombre_cliente,
    numero_reserva: r.numero_reserva,
    importe: importe,
    url_pago: session.url,
    boton_pago: botonPagoReenvio
  });
  const html = plantillaEmail(
    (_pep && _pep.email) ||
    `<p>Hola <strong>${r.nombre_cliente}</strong>,</p>
     <p>Te reenviamos el enlace de pago para confirmar tu reserva <strong>${r.numero_reserva}</strong>.</p>
     ${botonPagoReenvio}
     <p style="font-size:13px;color:#888;">Si tienes algún problema con el pago, contacta con nosotros por WhatsApp.</p>`
  );

  try {
    await enviarEmail({
      to: r.email_cliente,
      subject: (_pep && _pep.asunto) || ('Enlace de pago — Reserva ' + r.numero_reserva),
      html
    });
  } catch(err) {
    console.warn('Error enviando email enlace pago:', err.message);
    return res.status(500).json({ error: 'Error enviando email: ' + err.message });
  }

  // WhatsApp con enlace de pago
  try {
    if (r.telefono_cliente) {
      const _pepwa = await obtenerPlantilla('cliente_enlace_pago', {
        nombre_cliente: r.nombre_cliente,
        numero_reserva: r.numero_reserva,
        importe: importe,
        url_pago: session.url
      });
      const textoWa = (_pepwa && _pepwa.whatsapp) ||
        ('Te reenviamos el enlace de pago para tu reserva ' + r.numero_reserva + ': ' + session.url);
      await pool.query(
        'INSERT INTO whatsapp_mensajes_pendientes (telefono, texto) VALUES ($1, $2)',
        [r.telefono_cliente, textoWa]
      );
    }
  } catch(waErr) {
    console.warn('Error encolando WhatsApp enlace pago:', waErr.message);
  }

  res.json({ ok: true });
}));

app.post('/admin/reservas/:id/email-voucher', requireAdmin, asyncHandler(async (req, res) => {
  const reserva = await pool.query('SELECT * FROM reservas WHERE id = $1', [req.params.id]);
  if (!reserva.rows.length) return res.status(404).json({ error: 'Reserva no encontrada' });
  const r = reserva.rows[0];

  try {
    const html = await generarHtmlVoucher(req.params.id);
    if (!html) return res.status(500).json({ error: 'No se pudo generar el voucher.' });
    const _pvM = await obtenerPlantilla('cliente_voucher', {
      nombre_cliente: r.nombre_cliente,
      numero_reserva: r.numero_reserva
    });
    await enviarEmail({
      to: r.email_cliente,
      subject: (_pvM && _pvM.asunto) || ('Voucher de traslado — ' + r.numero_reserva),
      html
    });
    await pool.query('UPDATE reservas SET email_voucher_enviado = TRUE WHERE id = $1', [req.params.id]);
    // WhatsApp voucher al cliente
    if (r.telefono_cliente) {
      try {
        const firma = firmarVoucher(req.params.id);
        const nombreDoc = `voucher-${r.numero_reserva}.pdf`;
        const urlDoc = `${BASE_URL}/voucher-descarga/${req.params.id}/${firma}/${nombreDoc}`;
        const textoWaVoucherM = (_pvM && _pvM.whatsapp) || `Hola, ${r.nombre_cliente} 👋\n\nTe adjuntamos el voucher de tu traslado ${r.numero_reserva}.\n\nTraslados GC`;
        await pool.query(
          'INSERT INTO whatsapp_mensajes_pendientes (telefono, texto, url_documento, nombre_documento) VALUES ($1, $2, $3, $4)',
          [r.telefono_cliente, textoWaVoucherM, urlDoc, nombreDoc]
        );
      } catch(e) { console.warn('Error encolando WhatsApp voucher:', e.message); }
    }
    res.json({ ok: true });
  } catch(err) {
    res.status(500).json({ error: 'Error enviando email: ' + err.message });
  }
}));

// Reenviar cartel al chofer
app.post('/admin/reservas/:id/reenviar-cartel', requireAdmin, asyncHandler(async (req, res) => {
  const reserva = await pool.query('SELECT * FROM reservas WHERE id = $1', [req.params.id]);
  if (!reserva.rows.length) return res.status(404).json({ error: 'Reserva no encontrada' });
  const r = reserva.rows[0];
  if (!r.conductor_id) return res.status(400).json({ error: 'No hay chofer asignado.' });

  try {
    const cartel = await generarCartelPDF(req.params.id);
    if (!cartel || !cartel.conductor_email) return res.status(400).json({ error: 'El chofer no tiene email configurado.' });
    const fechaCartelM = r.fecha ? new Date(r.fecha).toLocaleDateString('es-ES', {day:'numeric', month:'long', year:'numeric'}) : '—';
    const _pccM = await obtenerPlantilla('chofer_cartel', {
      nombre_chofer: cartel.conductor_nombre || '',
      numero_reserva: r.numero_reserva,
      origen: r.origen || '—',
      destino: r.destino || '—',
      fecha: fechaCartelM,
      hora: r.hora ? r.hora.slice(0,5) : '—'
    });
    await enviarEmailConAdjunto({
      to: cartel.conductor_email,
      subject: (_pccM && _pccM.asunto) || ('Cartel de recogida — ' + r.numero_reserva),
      html: plantillaEmail((_pccM && _pccM.email) || ('<p>Hola ' + (cartel.conductor_nombre || '') + ',</p><p>Adjuntamos el cartel de recogida para tu próximo servicio.</p><p>Reserva: <strong>' + r.numero_reserva + '</strong></p>')),
      adjunto: { filename: 'cartel-' + r.numero_reserva + '.pdf', content: cartel.buffer }
    });
    // WhatsApp al chofer
    const choferQ = await pool.query('SELECT telefono FROM conductores WHERE id = $1', [r.conductor_id]);
    if (choferQ.rows.length && choferQ.rows[0].telefono) {
      try {
        const firma = firmarCartel(req.params.id);
        const nombreDoc = `cartel-${r.numero_reserva}.pdf`;
        const urlDoc = `${BASE_URL}/cartel-descarga/${req.params.id}/${firma}/${nombreDoc}`;
        const textoWaCartelM = (_pccM && _pccM.whatsapp) || `Hola, ${cartel.conductor_nombre || ''} 👋\n\nTe adjuntamos el cartel de recogida para la reserva ${r.numero_reserva}.\n\nTraslados GC`;
        await pool.query(
          'INSERT INTO whatsapp_mensajes_pendientes (telefono, texto, url_documento, nombre_documento) VALUES ($1, $2, $3, $4)',
          [choferQ.rows[0].telefono, textoWaCartelM, urlDoc, nombreDoc]
        );
      } catch(e) { console.warn('Error encolando WhatsApp cartel:', e.message); }
    }
    res.json({ ok: true });
  } catch(err) {
    res.status(500).json({ error: 'Error enviando cartel: ' + err.message });
  }
}));

// Admin: reenviar factura al cliente
app.post('/admin/reservas/:id/reenviar-factura-cliente', requireAdmin, asyncHandler(async (req, res) => {
  const reservaQ = await pool.query('SELECT * FROM reservas WHERE id = $1', [req.params.id]);
  if (!reservaQ.rows.length) return res.status(404).json({ error: 'Reserva no encontrada.' });
  const r = reservaQ.rows[0];
  if (!r.email_cliente) return res.status(400).json({ error: 'El cliente no tiene email registrado.' });

  const facturaQ = await pool.query('SELECT id FROM facturas WHERE reserva_id = $1 ORDER BY generada_en DESC LIMIT 1', [req.params.id]);
  if (!facturaQ.rows.length) return res.status(400).json({ error: 'No hay factura generada para esta reserva.' });

  try {
    const resultado = await generarFacturaPDF(req.params.id);
    if (!resultado) return res.status(500).json({ error: 'Error generando la factura.' });
    const pdfBuffer = resultado.buffer;
    const _pf = await obtenerPlantilla('cliente_factura', {
      nombre_cliente: r.nombre_cliente,
      numero_reserva: r.numero_reserva,
      numero_factura: resultado.numeroFactura
    });
    await enviarEmailConAdjunto({
      to: r.email_cliente,
      subject: (_pf && _pf.asunto) || ('📄 Factura ' + resultado.numeroFactura + ' — Reserva ' + r.numero_reserva),
      html: plantillaEmail((_pf && _pf.email) || `<p>Hola <strong>${r.nombre_cliente}</strong>,</p><p>Adjuntamos la factura <strong>${resultado.numeroFactura}</strong> correspondiente a tu reserva <strong>${r.numero_reserva}</strong>.</p><p>Gracias por viajar con Traslados GC.</p>`),
      adjunto: { filename: 'factura-' + r.numero_reserva + '.pdf', content: pdfBuffer }
    });
    if (r.telefono_cliente) {
      try {
        const firma = firmarFactura(req.params.id);
        const nombreDoc = `factura-${resultado.numeroFactura}.pdf`;
        const urlDoc = `${BASE_URL}/factura-descarga/${req.params.id}/${firma}/${nombreDoc}`;
        const textoWa = (_pf && _pf.whatsapp) || `Hola, ${r.nombre_cliente} 👋\n\nTe adjuntamos la factura ${resultado.numeroFactura} de tu reserva ${r.numero_reserva}.\n\nGracias por viajar con Traslados GC.`;
        await pool.query(
          'INSERT INTO whatsapp_mensajes_pendientes (telefono, texto, url_documento, nombre_documento) VALUES ($1, $2, $3, $4)',
          [r.telefono_cliente, textoWa, urlDoc, nombreDoc]
        );
      } catch(e) { console.warn('Error encolando WhatsApp factura:', e.message); }
    }
    res.json({ ok: true });
  } catch(err) {
    res.status(500).json({ error: 'Error enviando factura: ' + err.message });
  }
}));

app.get('/admin/reservas/:id/whatsapp-cartel', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT r.numero_reserva, r.conductor_id, c.nombre AS conductor_nombre, c.telefono AS conductor_telefono
     FROM reservas r LEFT JOIN conductores c ON c.id = r.conductor_id WHERE r.id = $1`,
    [req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Reserva no encontrada.' });
  const d = result.rows[0];
  if (!d.conductor_id) return res.status(400).json({ error: 'No hay chofer asignado en esta reserva.' });
  if (!d.conductor_telefono) return res.status(400).json({ error: 'Este chofer no tiene teléfono registrado.' });

  const firma = firmarCartel(req.params.id);
  res.json({
    nombre: d.conductor_nombre,
    telefono: d.conductor_telefono.replace(/[^0-9]/g, ''),
    numero_reserva: d.numero_reserva,
    url: BASE_URL + '/cartel-descarga/' + req.params.id + '/' + firma
  });
}));

app.get('/cartel-descarga/:id/:firma/:nombre?', asyncHandler(async (req, res) => {
  if (req.params.firma !== firmarCartel(req.params.id)) {
    return res.status(403).send('Enlace no válido o caducado.');
  }
  const cartel = await generarCartelPDF(req.params.id);
  if (!cartel) return res.status(404).send('Cartel no disponible.');
  const nombreArchivo = req.params.nombre || 'cartel-' + (cartel.numero_reserva || req.params.id) + '.pdf';
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', 'attachment; filename="' + nombreArchivo + '"');
  res.send(cartel.buffer);
}));

app.get('/voucher-descarga/:id/:firma/:nombre?', asyncHandler(async (req, res) => {
  if (req.params.firma !== firmarVoucher(req.params.id)) {
    return res.status(403).send('Enlace no válido o caducado.');
  }
  const resultado = await generarVoucherPDF(req.params.id);
  if (!resultado) return res.status(404).send('Voucher no disponible.');
  const nombreArchivo = req.params.nombre || 'voucher-' + (resultado.numero_reserva || req.params.id) + '.pdf';
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', 'attachment; filename="' + nombreArchivo + '"');
  res.send(resultado.buffer);
}));

async function obtenerPlantilla(clave, vars) {
  try {
    const r = await pool.query(
      'SELECT asunto_email, cuerpo_email, cuerpo_whatsapp FROM plantillas_comunicacion WHERE clave = $1',
      [clave]
    );
    if (!r.rows.length) return null;
    const p = r.rows[0];
    const sustituir = (txt) => {
      if (!txt) return txt;
      return txt.replace(/\{([^}]+)\}/g, (_, k) => {
        const v = vars[k];
        return (v !== undefined && v !== null) ? String(v) : '{' + k + '}';
      });
    };
    const emailTexto = sustituir(p.cuerpo_email);
    return {
      asunto: sustituir(p.asunto_email),
      email: emailTexto ? emailTexto.replace(/\n/g, '<br>') : emailTexto,
      whatsapp: sustituir(p.cuerpo_whatsapp)
    };
  } catch(e) {
    console.warn('obtenerPlantilla error (' + clave + '):', e.message);
    return null;
  }
}

function firmarFactura(reservaId) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET || 'cambia-este-secreto')
    .update('factura-' + String(reservaId)).digest('hex').slice(0, 20);
}

app.get('/factura-descarga/:id/:firma/:nombre?', asyncHandler(async (req, res) => {
  if (req.params.firma !== firmarFactura(req.params.id)) {
    return res.status(403).send('Enlace no válido o caducado.');
  }
  const resultado = await generarFacturaPDF(req.params.id);
  if (!resultado) return res.status(404).send('Factura no disponible.');
  const nombreArchivo = req.params.nombre || 'factura-' + (resultado.numero_reserva || req.params.id) + '.pdf';
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', 'attachment; filename="' + nombreArchivo + '"');
  res.send(resultado.buffer);
}));

// ─── Admin: extras ────────────────────────────────────────────────────────────
app.get('/admin/extras', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT id, nombre, precio, activo, bloque, orden, tipo_seleccion, notas_chofer, depende_chofer FROM extras ORDER BY depende_chofer DESC, bloque, orden, id'
  );
  res.json({ extras: result.rows });
}));

app.post('/admin/extras', requireAdmin, asyncHandler(async (req, res) => {
  const { nombre, precio, bloque, orden, tipo_seleccion, notas_chofer, depende_chofer } = req.body;
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'El nombre es obligatorio.' });
  const p = parseFloat(precio);
  if (isNaN(p) || p < 0) return res.status(400).json({ error: 'El precio no es válido.' });
  await pool.query(
    'INSERT INTO extras (nombre, precio, bloque, orden, tipo_seleccion, notas_chofer, depende_chofer, activo) VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)',
    [nombre.trim(), p, (bloque || 'F').trim(), parseInt(orden, 10) || 0,
     (tipo_seleccion || 'checkbox').trim(), notas_chofer ? notas_chofer.trim() : null, depende_chofer !== false]
  );
  res.json({ ok: true });
}));

app.post('/admin/extras/:id/editar', requireAdmin, asyncHandler(async (req, res) => {
  const { nombre, precio, bloque, orden, tipo_seleccion, notas_chofer, depende_chofer } = req.body;
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'El nombre es obligatorio.' });
  const p = parseFloat(precio);
  if (isNaN(p) || p < 0) return res.status(400).json({ error: 'El precio no es válido.' });
  await pool.query(
    `UPDATE extras SET nombre = $1, precio = $2,
       bloque = COALESCE(NULLIF($3, ''), bloque),
       orden = COALESCE($4, orden),
       tipo_seleccion = COALESCE(NULLIF($5, ''), tipo_seleccion),
       notas_chofer = COALESCE($6, notas_chofer),
       depende_chofer = $7
     WHERE id = $8`,
    [nombre.trim(), p, (bloque || '').trim(),
     (orden !== undefined && orden !== null && orden !== '') ? parseInt(orden, 10) : null,
     (tipo_seleccion || '').trim(), notas_chofer !== undefined ? (notas_chofer ? notas_chofer.trim() : '') : null,
     depende_chofer !== false, req.params.id]
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

// ─── Admin: avisos de reserva (Grupo B — información pura, sin precio) ───────
app.get('/admin/avisos', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT id, nombre, nota_interna, orden, activo FROM avisos_reserva ORDER BY orden, id'
  );
  res.json({ avisos: result.rows });
}));

app.post('/admin/avisos', requireAdmin, asyncHandler(async (req, res) => {
  const { nombre, nota_interna, orden } = req.body;
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'El nombre es obligatorio.' });
  await pool.query(
    'INSERT INTO avisos_reserva (nombre, nota_interna, orden, activo) VALUES ($1, $2, $3, FALSE)',
    [nombre.trim(), nota_interna ? nota_interna.trim() : null, parseInt(orden, 10) || 0]
  );
  res.json({ ok: true });
}));

app.post('/admin/avisos/:id/editar', requireAdmin, asyncHandler(async (req, res) => {
  const { nombre, nota_interna, orden } = req.body;
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'El nombre es obligatorio.' });
  await pool.query(
    'UPDATE avisos_reserva SET nombre = $1, nota_interna = $2, orden = COALESCE($3, orden) WHERE id = $4',
    [nombre.trim(), nota_interna ? nota_interna.trim() : null,
     (orden !== undefined && orden !== null && orden !== '') ? parseInt(orden, 10) : null, req.params.id]
  );
  res.json({ ok: true });
}));

app.post('/admin/avisos/:id/activo', requireAdmin, asyncHandler(async (req, res) => {
  await pool.query('UPDATE avisos_reserva SET activo = $1 WHERE id = $2', [!!req.body.activo, req.params.id]);
  res.json({ ok: true });
}));

app.post('/admin/avisos/:id/eliminar', requireAdmin, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM avisos_reserva WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ─── Admin: preferencias del pasajero (Grupo G — siempre gratuitas) ──────────
app.get('/admin/preferencias', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT id, nombre, opciones, orden, activo FROM preferencias_catalogo ORDER BY orden, id'
  );
  res.json({ preferencias: result.rows });
}));

app.post('/admin/preferencias', requireAdmin, asyncHandler(async (req, res) => {
  const { nombre, opciones, orden } = req.body;
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'El nombre es obligatorio.' });
  if (!opciones || !opciones.trim()) return res.status(400).json({ error: 'Las opciones son obligatorias.' });
  await pool.query(
    'INSERT INTO preferencias_catalogo (nombre, opciones, orden, activo) VALUES ($1, $2, $3, FALSE)',
    [nombre.trim(), opciones.trim(), parseInt(orden, 10) || 0]
  );
  res.json({ ok: true });
}));

app.post('/admin/preferencias/:id/editar', requireAdmin, asyncHandler(async (req, res) => {
  const { nombre, opciones, orden } = req.body;
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'El nombre es obligatorio.' });
  if (!opciones || !opciones.trim()) return res.status(400).json({ error: 'Las opciones son obligatorias.' });
  await pool.query(
    'UPDATE preferencias_catalogo SET nombre = $1, opciones = $2, orden = COALESCE($3, orden) WHERE id = $4',
    [nombre.trim(), opciones.trim(),
     (orden !== undefined && orden !== null && orden !== '') ? parseInt(orden, 10) : null, req.params.id]
  );
  res.json({ ok: true });
}));

app.post('/admin/preferencias/:id/activo', requireAdmin, asyncHandler(async (req, res) => {
  await pool.query('UPDATE preferencias_catalogo SET activo = $1 WHERE id = $2', [!!req.body.activo, req.params.id]);
  res.json({ ok: true });
}));

app.post('/admin/preferencias/:id/eliminar', requireAdmin, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM preferencias_catalogo WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ─── Admin: sugerencias de preferencias enviadas por los clientes ────────────
app.get('/admin/preferencias-sugerencias', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT id, email_cliente, texto, estado, creado_en FROM preferencias_sugerencias ORDER BY creado_en DESC'
  );
  res.json({ sugerencias: result.rows });
}));

app.post('/admin/preferencias-sugerencias/:id/estado', requireAdmin, asyncHandler(async (req, res) => {
  const estado = req.body.estado === 'revisada' ? 'revisada' : 'pendiente';
  await pool.query('UPDATE preferencias_sugerencias SET estado = $1 WHERE id = $2', [estado, req.params.id]);
  res.json({ ok: true });
}));

app.post('/admin/preferencias-sugerencias/:id/eliminar', requireAdmin, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM preferencias_sugerencias WHERE id = $1', [req.params.id]);
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
  if (!imagen || !imagen.startsWith('data:image/') || imagen.length > 3000000) {
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

  // Traducciones de destinos para este idioma
  const destinosTrad = await pool.query(
    `SELECT d.nombre AS nombre_es, dt.nombre AS nombre_traducido
     FROM destinos d
     LEFT JOIN destinos_traducciones dt ON dt.destino_id = d.id AND dt.lang_code = $1`,
    [lang]
  );
  const mapaDestinos = {};
  for (const d of destinosTrad.rows) {
    mapaDestinos[d.nombre_es] = (d.nombre_traducido && d.nombre_traducido.trim()) ? d.nombre_traducido : d.nombre_es;
  }

  // Traducciones de categorías para este idioma
  const catsTrad = await pool.query(
    `SELECT ti.texto_es, COALESCE(tit.texto, ti.texto_es) AS nombre_traducido
     FROM textos_interfaz ti
     LEFT JOIN textos_interfaz_traducciones tit ON tit.texto_id = ti.id AND tit.lang_code = $1
     WHERE ti.modulo = 'Categorías de vehículo'`,
    [lang]
  );
  const mapaCategorias = {};
  for (const c of catsTrad.rows) {
    mapaCategorias[c.texto_es] = c.nombre_traducido;
  }

  const origenTraducido = mapaDestinos[seo.origen] || seo.origen;
  const destinoTraducido = mapaDestinos[seo.destino] || seo.destino;

  res.render('traslado', {
    seo: Object.assign({}, seo, { origen: origenTraducido, destino: destinoTraducido }),
    precios: precios.rows.map(function(p) {
      return Object.assign({}, p, { nombre: mapaCategorias[p.nombre] || p.nombre });
    }),
    alternates: alternates.rows,
    relacionadas: relacionadas.rows.map(function(r) {
      return { destino: mapaDestinos[r.destino] || r.destino, slug_url: r.slug_url };
    }),
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


// ─── Admin: listado de clientes ──────────────────────────────────────────────
app.get('/admin/clientes', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT email_cliente, nombre, telefono FROM clientes_datos ORDER BY actualizado_en DESC'
  );
  res.json(result.rows);
}));

// ─── Admin: listado de equipo (choferes) ─────────────────────────────────────
app.get('/admin/equipo', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query(
    "SELECT nombre, email, telefono FROM conductores WHERE estado = 'aprobado' ORDER BY nombre ASC"
  );
  res.json(result.rows);
}));

// ─── Admin: enviar comunicado a clientes ─────────────────────────────────────
app.post('/admin/comunicado/clientes', requireAdmin, asyncHandler(async (req, res) => {
  const { destinatarios, email, whatsapp, asunto, mensaje } = req.body;
  if (!mensaje) return res.status(400).json({ error: 'El mensaje es obligatorio.' });

  // Si no hay destinatarios seleccionados, enviamos a todos
  let lista;
  if (Array.isArray(destinatarios) && destinatarios.length > 0) {
    const result = await pool.query(
      'SELECT email_cliente, nombre, telefono FROM clientes_datos WHERE email_cliente = ANY($1)',
      [destinatarios]
    );
    lista = result.rows;
  } else {
    const result = await pool.query('SELECT email_cliente, nombre, telefono FROM clientes_datos');
    lista = result.rows;
  }

  if (!lista.length) return res.status(400).json({ error: 'No hay destinatarios.' });

  const errores = [];
  for (const cliente of lista) {
    if (email) {
      try {
        await enviarEmail({
          to: cliente.email_cliente,
          subject: asunto,
          html: plantillaEmail(`<p>Hola <strong>${cliente.nombre || ''}</strong>,</p><p style="white-space:pre-wrap;">${mensaje}</p>`)
        });
      } catch(e) { errores.push(cliente.email_cliente); }
    }
    if (whatsapp && cliente.telefono) {
      try {
        await pool.query(
          'INSERT INTO whatsapp_mensajes_pendientes (telefono, texto) VALUES ($1, $2)',
          [cliente.telefono, mensaje]
        );
      } catch(e) { /* WhatsApp no bloquea el envío general */ }
    }
  }

  res.json({ ok: true, enviados: lista.length, errores: errores.length });
}));

// ─── Admin: enviar comunicado al equipo (choferes) ───────────────────────────
app.post('/admin/comunicado/equipo', requireAdmin, asyncHandler(async (req, res) => {
  const { destinatarios, email, whatsapp, asunto, mensaje } = req.body;
  if (!mensaje) return res.status(400).json({ error: 'El mensaje es obligatorio.' });

  let lista;
  if (Array.isArray(destinatarios) && destinatarios.length > 0) {
    const result = await pool.query(
      "SELECT nombre, email, telefono FROM conductores WHERE email = ANY($1) AND estado = 'aprobado'",
      [destinatarios]
    );
    lista = result.rows;
  } else {
    const result = await pool.query("SELECT nombre, email, telefono FROM conductores WHERE estado = 'aprobado' ORDER BY nombre ASC");
    lista = result.rows;
  }

  if (!lista.length) return res.status(400).json({ error: 'No hay destinatarios.' });

  const errores = [];
  for (const chofer of lista) {
    if (email) {
      try {
        await enviarEmail({
          to: chofer.email,
          subject: asunto,
          html: plantillaEmail(`<p>Hola <strong>${chofer.nombre || ''}</strong>,</p><p style="white-space:pre-wrap;">${mensaje}</p>`)
        });
      } catch(e) { errores.push(chofer.email); }
    }
    if (whatsapp && chofer.telefono) {
      try {
        await pool.query(
          'INSERT INTO whatsapp_mensajes_pendientes (telefono, texto) VALUES ($1, $2)',
          [chofer.telefono, mensaje]
        );
      } catch(e) { /* WhatsApp no bloquea el envío general */ }
    }
  }

  res.json({ ok: true, enviados: lista.length, errores: errores.length });
}));

// ─── Admin: guardar emails de notificación ───────────────────────────────────
app.post('/admin/notificaciones', requireAdmin, asyncHandler(async (req, res) => {
  const { emails_notificacion } = req.body;
  await pool.query(
    'UPDATE configuracion_contacto SET emails_notificacion = $1, actualizado_en = NOW() WHERE id = 1',
    [emails_notificacion || '']
  );
  res.json({ ok: true });
}));

// ═══════════════════════════════════════════════════════════════════════════════
// ─── PORTAL DEL CLIENTE (/mi-reserva) ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/mi-reserva', (req, res) => {
  if (req.session && req.session.clienteReservaId) return res.redirect('/cliente/portal');
  res.sendFile(path.join(__dirname, 'public', 'mi-reserva.html'));
});

app.get('/restablecer-password', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'restablecer-password.html'));
});

app.post('/api/restablecer-password', asyncHandler(async (req, res) => {
  const { token, password_nueva } = req.body;
  if (!token) return res.status(400).json({ error: 'Enlace no válido.' });
  if (!password_nueva || password_nueva.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });

  const result = await pool.query(
    'SELECT * FROM tokens_recuperacion WHERE token = $1 AND usado = FALSE AND expira_en > NOW()',
    [token]
  );
  if (!result.rows.length) return res.status(400).json({ error: 'Este enlace no es válido o ha caducado. Solicita uno nuevo.' });
  const fila = result.rows[0];

  const hash = await bcrypt.hash(password_nueva, 10);
  if (fila.tipo === 'cliente') {
    await pool.query('UPDATE reservas SET cliente_password_hash = $1, cliente_primer_acceso = FALSE WHERE id = $2', [hash, fila.referencia_id]);
    // Guardar también en clientes_datos para que la cuenta sea permanente
    const rEmail = await pool.query('SELECT email_cliente FROM reservas WHERE id = $1', [fila.referencia_id]);
    if (rEmail.rows.length) {
      await pool.query(
        `INSERT INTO clientes_datos (email_cliente, password_hash)
         VALUES ($1, $2)
         ON CONFLICT (email_cliente) DO UPDATE SET password_hash = $2, actualizado_en = NOW()`,
        [rEmail.rows[0].email_cliente.toLowerCase(), hash]
      );
    }
  } else if (fila.tipo === 'chofer') {
    await pool.query('UPDATE conductores SET password_hash = $1 WHERE id = $2', [hash, fila.referencia_id]);
  } else {
    return res.status(400).json({ error: 'Enlace no válido.' });
  }

  await pool.query('UPDATE tokens_recuperacion SET usado = TRUE WHERE id = $1', [fila.id]);
  res.json({ ok: true });
}));

app.get('/cliente/portal', (req, res) => {
  if (!req.session || !req.session.clienteReservaId) return res.redirect('/mi-reserva');
  res.sendFile(path.join(__dirname, 'public', 'cliente-portal.html'));
});

// Verificar PNR + email y enviar contraseña provisional
app.post('/api/cliente/solicitar-acceso', asyncHandler(async (req, res) => {
  const { pnr, email } = req.body;
  if (!pnr || !email) return res.status(400).json({ error: 'PNR y email son obligatorios.' });

  const result = await pool.query(
    'SELECT id, nombre_cliente, email_cliente, cliente_password_hash, cliente_primer_acceso FROM reservas WHERE UPPER(numero_reserva) = UPPER($1)',
    [pnr.trim()]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'No encontramos una reserva con ese número.' });
  const reserva = result.rows[0];
  if (reserva.email_cliente.toLowerCase() !== email.trim().toLowerCase()) {
    return res.status(403).json({ error: 'El email no coincide con el de la reserva.' });
  }

  // Si ya tiene contraseña creada (no provisional), no la sobrescribimos
  if (reserva.cliente_password_hash && !reserva.cliente_primer_acceso) {
    return res.status(403).json({ error: 'Ya tienes una cuenta creada. Accede con tu email y contraseña.' });
  }

  // Generar y guardar nueva contraseña provisional
  const pwd = generarPasswordProvisional();
  const hash = await bcrypt.hash(pwd, 10);
  await pool.query(
    'UPDATE reservas SET cliente_password_hash = $1, cliente_primer_acceso = TRUE WHERE id = $2',
    [hash, reserva.id]
  );

  // Enviar email con contraseña provisional
  const BASE_URL = process.env.BASE_URL || 'https://traslados-gc.onrender.com';
  await enviarEmail({
    to: reserva.email_cliente,
    subject: 'Acceso a tu reserva ' + pnr.toUpperCase() + ' — Traslados GC',
    html: plantillaEmail(
      `<p>Hola <strong>${reserva.nombre_cliente}</strong>,</p>
       <p>Aquí tienes tu contraseña provisional para acceder al seguimiento de tu reserva <span class="pnr">${pnr.toUpperCase()}</span>.</p>
       <div class="info-box" style="text-align:center;">
         <div style="font-size:12px;color:#5b5347;margin-bottom:8px;text-transform:uppercase;letter-spacing:1px;">Contraseña provisional</div>
         <div style="font-family:monospace;font-size:24px;font-weight:700;color:#C1502E;letter-spacing:4px;">${pwd}</div>
       </div>
       <p style="font-size:13px;color:#5b5347;">Al entrar por primera vez se te pedirá que la cambies por una propia.</p>
       <p style="text-align:center;"><a href="${BASE_URL}/mi-reserva" class="boton">Ver mi reserva</a></p>
       <p style="font-size:12px;color:#aaa;margin-top:20px;">Si no has solicitado este acceso, ignora este mensaje.</p>`
    )
  });

  res.json({ ok: true });
}));

// Login del cliente
app.post('/api/cliente/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña son obligatorios.' });

  const emailNorm = email.trim().toLowerCase();

  // 1. Buscar primero en clientes_datos (cuenta permanente, independiente de reservas)
  const cdResult = await pool.query(
    `SELECT email_cliente, nombre, password_hash FROM clientes_datos WHERE LOWER(email_cliente) = $1 AND password_hash IS NOT NULL`,
    [emailNorm]
  );

  if (cdResult.rows.length) {
    const cliente = cdResult.rows[0];
    const ok = await bcrypt.compare(password, cliente.password_hash);
    if (!ok) return res.status(401).json({ error: 'Contraseña incorrecta.' });

    // Sesión: usamos email como identificador principal (sin depender de reserva)
    req.session.clienteReservaId = 'cuenta_' + emailNorm;
    req.session.clientePnr = null;
    req.session.clienteEmail = cliente.email_cliente;
    return req.session.save(function(err) {
      res.json({ ok: true, primer_acceso: false });
    });
  }

  // 2. Compatibilidad: buscar en reservas (clientes que aún no tienen cuenta permanente)
  const result = await pool.query(
    `SELECT id, nombre_cliente, email_cliente, cliente_password_hash, cliente_primer_acceso
     FROM reservas
     WHERE LOWER(email_cliente) = $1 AND cliente_password_hash IS NOT NULL
     ORDER BY creado_en DESC LIMIT 1`,
    [emailNorm]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'No encontramos una cuenta con ese email. Si es tu primera vez, usa el acceso con número de reserva.' });
  const reserva = result.rows[0];

  const ok = await bcrypt.compare(password, reserva.cliente_password_hash);
  if (!ok) return res.status(401).json({ error: 'Contraseña incorrecta.' });

  req.session.clienteReservaId = reserva.id;
  req.session.clientePnr = reserva.id.toString();
  req.session.clienteEmail = reserva.email_cliente;
  req.session.save(function(err) {
    res.json({ ok: true, primer_acceso: reserva.cliente_primer_acceso });
  });
}));

// Cambiar contraseña (primer acceso o voluntario)
app.post('/api/cliente/cambiar-password', asyncHandler(async (req, res) => {
  if (!req.session || !req.session.clienteReservaId) return res.status(401).json({ error: 'No autenticado.' });
  const { password_nueva } = req.body;
  if (!password_nueva || password_nueva.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });

  const emailCliente = (req.session.clienteEmail || '').toLowerCase();
  const hash = await bcrypt.hash(password_nueva, 10);

  // Guardar en clientes_datos (cuenta permanente)
  await pool.query(
    `INSERT INTO clientes_datos (email_cliente, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (email_cliente) DO UPDATE SET password_hash = $2, actualizado_en = NOW()`,
    [emailCliente, hash]
  );

  // Si la sesión viene de una reserva (no de cuenta permanente), actualizar también la reserva
  const reservaId = req.session.clienteReservaId;
  if (reservaId && !String(reservaId).startsWith('cuenta_')) {
    await pool.query(
      'UPDATE reservas SET cliente_password_hash = $1, cliente_primer_acceso = FALSE WHERE id = $2',
      [hash, reservaId]
    );
  }

  res.json({ ok: true });
}));

// Recuperar contraseña (en cualquier momento, no solo la primera vez)
app.post('/api/cliente/recuperar-password', asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Indica tu email.' });

  const result = await pool.query(
    `SELECT id, nombre_cliente, email_cliente
     FROM reservas
     WHERE LOWER(email_cliente) = LOWER($1) AND cliente_password_hash IS NOT NULL
     ORDER BY creado_en DESC LIMIT 1`,
    [email.trim()]
  );
  // Por seguridad, respondemos ok igual exista o no la cuenta (no revelamos si el email está registrado)
  if (!result.rows.length) return res.json({ ok: true });
  const reserva = result.rows[0];

  const token = crypto.randomBytes(32).toString('hex');
  const expira = new Date(Date.now() + 60 * 60 * 1000); // 1 hora
  await pool.query(
    'INSERT INTO tokens_recuperacion (tipo, referencia_id, token, expira_en) VALUES ($1,$2,$3,$4)',
    ['cliente', reserva.id, token, expira]
  );

  const BASE_URL = process.env.BASE_URL || 'https://traslados-gc.onrender.com';
  const enlace = `${BASE_URL}/restablecer-password?token=${token}&tipo=cliente`;
  await enviarEmail({
    to: reserva.email_cliente,
    subject: 'Recupera tu contraseña — Traslados GC',
    html: plantillaEmail(
      `<p>Hola <strong>${reserva.nombre_cliente}</strong>,</p>
       <p>Has solicitado recuperar el acceso a tu cuenta. Pulsa el botón para elegir una contraseña nueva:</p>
       <p style="text-align:center;"><a href="${enlace}" class="boton">Crear nueva contraseña</a></p>
       <p style="font-size:13px;color:#5b5347;">Este enlace caduca en 1 hora y solo se puede usar una vez. Tu contraseña actual sigue funcionando hasta que la cambies desde aquí.</p>
       <p style="font-size:12px;color:#aaa;margin-top:20px;">Si no has solicitado esto, simplemente ignora este mensaje — no se cambiará nada.</p>`
    )
  });

  res.json({ ok: true });
}));

// Logout del cliente
app.post('/api/cliente/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Comprobar sesión del cliente
app.get('/api/cliente/sesion', (req, res) => {
  if (req.session && req.session.clienteReservaId) {
    res.json({ autenticado: true, pnr: req.session.clientePnr });
  } else {
    res.json({ autenticado: false });
  }
});

// ─── Preferencias del pasajero (Grupo G): el cliente ve y guarda las suyas ───
// Ayudante: email del cliente con sesión abierta (su identidad entre reservas)
async function emailClienteSesion(req) {
  if (!req.session || !req.session.clienteReservaId) return null;
  // El email siempre se guarda en sesión al hacer login; no depende de que
  // la reserva de acceso siga existiendo en la base de datos.
  if (req.session.clienteEmail) return req.session.clienteEmail.toLowerCase();
  // Fallback para sesiones antiguas sin clienteEmail en sesión
  const r = await pool.query('SELECT LOWER(email_cliente) AS email FROM reservas WHERE id = $1', [req.session.clienteReservaId]);
  return r.rows.length ? r.rows[0].email : null;
}

app.get('/api/cliente/preferencias', asyncHandler(async (req, res) => {
  const email = await emailClienteSesion(req);
  if (!email) return res.status(401).json({ error: 'No autenticado.' });
  const cat = await pool.query(
    'SELECT id, nombre, opciones FROM preferencias_catalogo WHERE activo = TRUE ORDER BY orden, id'
  );
  const mias = await pool.query(
    'SELECT preferencia_id, opcion, detalle FROM preferencias_cliente WHERE email_cliente = $1', [email]
  );
  const vis = await pool.query(
    'SELECT visibles FROM preferencias_visibilidad_cliente WHERE email_cliente = $1', [email]
  );
  const elegidas = {};
  mias.rows.forEach(m => { elegidas[m.preferencia_id] = { opcion: m.opcion, detalle: m.detalle }; });
  res.json({
    visibles: vis.rows.length ? vis.rows[0].visibles : true,
    preferencias: cat.rows.map(p => ({
      id: p.id, nombre: p.nombre, opciones: p.opciones,
      elegida: elegidas[p.id] ? elegidas[p.id].opcion : null,
      detalle: elegidas[p.id] ? elegidas[p.id].detalle : null
    }))
  });
}));

app.post('/api/cliente/preferencias/visibilidad', asyncHandler(async (req, res) => {
  const email = await emailClienteSesion(req);
  if (!email) return res.status(401).json({ error: 'No autenticado.' });
  await pool.query(
    `INSERT INTO preferencias_visibilidad_cliente (email_cliente, visibles)
     VALUES ($1, $2)
     ON CONFLICT (email_cliente) DO UPDATE SET visibles = $2, actualizado_en = NOW()`,
    [email, !!req.body.visibles]
  );
  res.json({ ok: true });
}));

app.post('/api/cliente/preferencias', asyncHandler(async (req, res) => {
  const email = await emailClienteSesion(req);
  if (!email) return res.status(401).json({ error: 'No autenticado.' });
  const selecciones = Array.isArray(req.body.selecciones) ? req.body.selecciones : [];
  // Solo se aceptan opciones que existan tal cual en el catálogo publicado
  const cat = await pool.query('SELECT id, opciones FROM preferencias_catalogo WHERE activo = TRUE');
  const validas = {};
  cat.rows.forEach(p => { validas[p.id] = p.opciones.split('/').map(o => o.trim()); });
  await pool.query('DELETE FROM preferencias_cliente WHERE email_cliente = $1', [email]);
  for (const s of selecciones) {
    const pid = parseInt(s.preferencia_id, 10);
    const opcion = (s.opcion || '').trim();
    if (!validas[pid] || validas[pid].indexOf(opcion) === -1) continue;
    const detalle = (s.detalle || '').toString().trim().slice(0, 120) || null;
    await pool.query(
      `INSERT INTO preferencias_cliente (email_cliente, preferencia_id, opcion, detalle)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email_cliente, preferencia_id) DO UPDATE SET opcion = $3, detalle = $4, actualizado_en = NOW()`,
      [email, pid, opcion, detalle]
    );
  }
  res.json({ ok: true });
}));

app.post('/api/cliente/preferencias/sugerencia', asyncHandler(async (req, res) => {
  const email = await emailClienteSesion(req);
  if (!email) return res.status(401).json({ error: 'No autenticado.' });
  const texto = (req.body.texto || '').trim().slice(0, 500);
  if (!texto) return res.status(400).json({ error: 'Escribe tu sugerencia.' });
  await pool.query(
    'INSERT INTO preferencias_sugerencias (email_cliente, texto) VALUES ($1, $2)', [email, texto]
  );
  res.json({ ok: true });
}));

// Datos de contacto del cliente logueado (para prellenar el formulario de nueva reserva)
app.get('/api/cliente/mis-datos', asyncHandler(async (req, res) => {
  if (!req.session || !req.session.clienteReservaId) return res.status(401).json({ error: 'No autenticado.' });
  const emailCliente = req.session.clienteEmail;
  // Prioridad: datos guardados por el propio cliente; si no hay, su última reserva
  const emailNorm = (emailCliente || '').toLowerCase().trim();
  const propios = await pool.query(
    'SELECT nombre, telefono, idioma FROM clientes_datos WHERE LOWER(email_cliente) = $1', [emailNorm]
  );
  const result = await pool.query(
    `SELECT nombre_cliente, telefono_cliente, email_cliente
     FROM reservas WHERE LOWER(email_cliente) = $1
     ORDER BY fecha DESC, hora DESC LIMIT 1`,
    [emailNorm]
  );
  if (!result.rows.length && !propios.rows.length) return res.status(404).json({ error: 'No encontrado.' });
  const nombreFinal = (propios.rows.length && propios.rows[0].nombre) || (result.rows.length ? result.rows[0].nombre_cliente : '');
  console.log('[mis-datos] email:', emailNorm, '| clientes_datos nombre:', propios.rows[0] && propios.rows[0].nombre, '| reserva nombre:', result.rows[0] && result.rows[0].nombre_cliente, '| devuelve:', nombreFinal);
  res.json({
    nombre_cliente: nombreFinal,
    telefono_cliente: (propios.rows.length && propios.rows[0].telefono) || (result.rows.length ? result.rows[0].telefono_cliente : ''),
    email_cliente: result.rows.length ? result.rows[0].email_cliente : emailNorm,
    idioma: (propios.rows.length && propios.rows[0].idioma) || 'es'
  });
}));

app.post('/api/cliente/mis-datos', asyncHandler(async (req, res) => {
  if (!req.session || !req.session.clienteReservaId) return res.status(401).json({ error: 'No autenticado.' });
  const emailCliente = (req.session.clienteEmail || '').toLowerCase();
  if (!emailCliente) return res.status(401).json({ error: 'No autenticado.' });
  const nombre = (req.body.nombre || '').trim().slice(0, 120);
  const telefono = (req.body.telefono || '').trim().slice(0, 40);
  const idioma = (req.body.idioma || 'es').trim().slice(0, 5);
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio.' });
  if (telefono.replace(/[^\d]/g, '').length < 7) return res.status(400).json({ error: 'Introduce un teléfono válido.' });
  await pool.query(
    `INSERT INTO clientes_datos (email_cliente, nombre, telefono, idioma) VALUES ($1, $2, $3, $4)
     ON CONFLICT (email_cliente) DO UPDATE SET nombre = $2, telefono = $3, idioma = $4, actualizado_en = NOW()`,
    [emailCliente, nombre, telefono, idioma]
  );
  res.json({ ok: true });
}));

// Datos completos de las reservas para el portal
app.get('/api/cliente/mi-reserva', asyncHandler(async (req, res) => {
  if (!req.session || !req.session.clienteReservaId) return res.status(401).json({ error: 'No autenticado.' });

  // El email vive en la sesión desde el login; no depende de que la reserva
  // de acceso siga existiendo (puede haber sido eliminada del admin).
  const emailCliente = req.session.clienteEmail;
  if (!emailCliente) return res.status(401).json({ error: 'Sesión caducada, vuelve a entrar.' });

  // Todas las reservas de ese email
  const result = await pool.query(
    `SELECT r.id, r.numero_reserva, r.nombre_cliente, r.email_cliente, r.telefono_cliente,
            r.fecha, r.hora, r.origen, r.destino, r.num_pasajeros,
            r.numero_vuelo, r.hora_llegada_vuelo, r.nombre_barco, r.hora_atraque,
            r.tipo_llegada, r.direccion_recogida, r.direccion_destino,
            r.notas_cliente, r.pasaporte_dni,
            r.estado, r.deposito_pagado, r.deposito_liberado, r.deposito_devolucion_pendiente, r.deposito_retenido_noshow,
            r.precio_estimado,
            r.email_confirmacion_enviado, r.email_voucher_enviado,
            cv.nombre AS categoria_nombre,
            c.nombre AS conductor_nombre, c.foto AS conductor_foto, c.foto_estado AS conductor_foto_estado
     FROM reservas r
     LEFT JOIN categorias_vehiculos cv ON cv.id = r.categoria_id
     LEFT JOIN conductores c ON c.id = r.conductor_id
     WHERE LOWER(r.email_cliente) = LOWER($1) AND r.archivada = FALSE
     ORDER BY r.fecha DESC, r.hora DESC`,
    [emailCliente]
  );

  // Para cada reserva obtener extras y noshow
  const reservas = await Promise.all(result.rows.map(async function(r) {
    const extras = await pool.query(
      `SELECT e.nombre, re.precio_en_reserva FROM reservas_extras re
       JOIN extras e ON e.id = re.extra_id WHERE re.reserva_id = $1`,
      [r.id]
    );
    const cfgNoshow = await obtenerConfigNoshow(r.fecha);
    const fechaCancelacion = calcularFechaCancelacion(new Date(r.fecha), r.hora, cfgNoshow.horas_cancelacion);
    const ahora = new Date();
    const esHistorial = new Date(r.fecha) < ahora;
    const facturaQ = await pool.query('SELECT id FROM facturas WHERE reserva_id = $1 LIMIT 1', [r.id]);
    return Object.assign({}, r, {
      extras: extras.rows,
      tiene_factura: facturaQ.rows.length > 0,
      noshow: {
        importe: parseFloat(cfgNoshow.importe_deposito).toFixed(2),
        horas: cfgNoshow.horas_cancelacion,
        fecha_limite: fechaCancelacion.toISOString(),
        puede_modificar: ahora < fechaCancelacion
      },
      es_historial: esHistorial
    });
  }));

  // Coger el nombre de clientes_datos (lo que el cliente tiene en Mis datos)
  const nombreCliente = await pool.query(
    'SELECT nombre FROM clientes_datos WHERE LOWER(email_cliente) = LOWER($1)',
    [emailCliente]
  );
  const nombre = (nombreCliente.rows.length && nombreCliente.rows[0].nombre)
    || (result.rows.length ? result.rows[0].nombre_cliente : '');
  res.json({ reservas, nombre });
}));

// Modificar datos de la reserva (cliente)
app.post('/api/cliente/modificar', asyncHandler(async (req, res) => {
  if (!req.session || !req.session.clienteReservaId) return res.status(401).json({ error: 'No autenticado.' });

  const reservaId = req.body.reserva_id || req.session.clienteReservaId;

  // El email lo leemos de la sesión directamente — no de la reserva de acceso
  // (que puede haber sido eliminada desde el admin).
  const emailCliente = req.session.clienteEmail;

  const reserva = await pool.query(
    'SELECT fecha, hora, estado, email_cliente FROM reservas WHERE id = $1',
    [reservaId]
  );
  if (!reserva.rows.length) return res.status(404).json({ error: 'Reserva no encontrada.' });
  const r = reserva.rows[0];
  if (r.email_cliente.toLowerCase() !== emailCliente.toLowerCase()) return res.status(403).json({ error: 'No autorizado.' });

  const cfgNoshow = await obtenerConfigNoshow(r.fecha);
  const fechaCancelacion = calcularFechaCancelacion(new Date(r.fecha), r.hora, cfgNoshow.horas_cancelacion);
  if (new Date() >= fechaCancelacion) {
    return res.status(403).json({ error: 'El plazo de modificación ha vencido. El servicio está cerrado a cambios.' });
  }

  const { hora, numero_vuelo, hora_llegada_vuelo, nombre_barco, hora_atraque, direccion_recogida, direccion_destino, notas_cliente } = req.body;
  await pool.query(
    `UPDATE reservas SET
      hora = COALESCE($1, hora),
      numero_vuelo = COALESCE($2, numero_vuelo),
      hora_llegada_vuelo = COALESCE($3, hora_llegada_vuelo),
      nombre_barco = COALESCE($4, nombre_barco),
      hora_atraque = COALESCE($5, hora_atraque),
      direccion_recogida = COALESCE($6, direccion_recogida),
      direccion_destino = COALESCE($7, direccion_destino),
      notas_cliente = COALESCE($8, notas_cliente)
     WHERE id = $9`,
    [hora||null, numero_vuelo||null, hora_llegada_vuelo||null, nombre_barco||null,
     hora_atraque||null, direccion_recogida||null, direccion_destino||null, notas_cliente||null,
     reservaId]
  );

  // Notificar al equipo
  try {
    const emails = await obtenerEmailsNotificacion();
    const pnr = req.session.clientePnr;
    if (emails.length) {
      for (const em of emails) {
        await enviarEmail({
          to: em,
          subject: '✏️ Cliente modificó datos — ' + pnr,
          html: plantillaEmail(`<p>El cliente de la reserva <strong>${pnr}</strong> ha modificado los datos de su traslado.</p><p>Accede al panel de administración para ver los cambios.</p>`)
        });
      }
    }
  } catch(e) { console.warn('Error notificando modificación:', e.message); }

  res.json({ ok: true });
}));

// Enviar mensaje al operador (siempre disponible)
app.post('/api/cliente/mensaje', asyncHandler(async (req, res) => {
  if (!req.session || !req.session.clienteReservaId) return res.status(401).json({ error: 'No autenticado.' });
  const { mensaje, reserva_id } = req.body;
  if (!mensaje || !mensaje.trim()) return res.status(400).json({ error: 'El mensaje no puede estar vacío.' });
  const reservaId = reserva_id || req.session.clienteReservaId;

  await pool.query(
    'INSERT INTO reservas_mensajes (reserva_id, autor, mensaje) VALUES ($1, $2, $3)',
    [reservaId, 'cliente', mensaje.trim()]
  );

  // Notificar al equipo
  try {
    const emails = await obtenerEmailsNotificacion();
    const reservaInfo = await pool.query('SELECT nombre_cliente, numero_reserva FROM reservas WHERE id = $1', [reservaId]);
    const nombre = reservaInfo.rows[0] ? reservaInfo.rows[0].nombre_cliente : 'Cliente';
    const pnr = reservaInfo.rows[0] ? reservaInfo.rows[0].numero_reserva : '—';
    if (emails.length) {
      for (const em of emails) {
        await enviarEmail({
          to: em,
          subject: '💬 Nuevo mensaje de cliente — ' + pnr,
          html: plantillaEmail(`<p><strong>${nombre}</strong> (reserva <strong>${pnr}</strong>) ha enviado un mensaje:</p><blockquote>${mensaje.trim()}</blockquote><p>Accede al panel de administración para responder o ver el historial.</p>`)
        });
      }
    }
  } catch(e) { console.warn('Error notificando mensaje:', e.message); }

  res.json({ ok: true });
}));

// Ver mensajes de la reserva (cliente)
app.get('/api/cliente/mensajes', asyncHandler(async (req, res) => {
  if (!req.session || !req.session.clienteReservaId) return res.status(401).json({ error: 'No autenticado.' });
  const reservaId = req.query.reserva_id || req.session.clienteReservaId;
  const result = await pool.query(
    'SELECT id, autor, mensaje, creado_en FROM reservas_mensajes WHERE reserva_id = $1 ORDER BY creado_en ASC',
    [reservaId]
  );
  res.json({ mensajes: result.rows });
}));

// ─── Portal cliente: página de modificación ──────────────────────────────────
app.get('/modificar-reserva', (req, res) => {
  res.sendFile('modificar-reserva.html', { root: path.join(__dirname, 'public') });
});

// ─── Portal cliente: cargar datos de reserva para pre-rellenar el formulario ─
app.get('/api/cliente/datos-modificacion', asyncHandler(async (req, res) => {
  if (!req.session || !req.session.clienteReservaId) return res.status(401).json({ error: 'No autenticado.' });
  const pnr = req.query.pnr;
  if (!pnr) return res.status(400).json({ error: 'PNR requerido.' });

  // Si la sesión es de cuenta permanente, el email está directo en la sesión
  let emailCliente = req.session.clienteEmail || null;
  if (!emailCliente) {
    const emailResult = await pool.query('SELECT email_cliente FROM reservas WHERE id = $1', [req.session.clienteReservaId]);
    if (!emailResult.rows.length) return res.status(401).json({ error: 'No autenticado.' });
    emailCliente = emailResult.rows[0].email_cliente;
  }
  if (!emailCliente) return res.status(401).json({ error: 'No autenticado.' });

  const result = await pool.query(
    `SELECT r.*, cv.nombre AS categoria_nombre, cv.id AS categoria_id_actual
     FROM reservas r
     LEFT JOIN categorias_vehiculos cv ON cv.id = r.categoria_id
     WHERE UPPER(r.numero_reserva) = UPPER($1) AND LOWER(r.email_cliente) = LOWER($2) AND r.archivada = FALSE`,
    [pnr, emailCliente]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Reserva no encontrada.' });
  const r = result.rows[0];

  const extras = await pool.query(
    `SELECT re.extra_id, e.nombre, re.precio_en_reserva FROM reservas_extras re
     JOIN extras e ON e.id = re.extra_id WHERE re.reserva_id = $1`,
    [r.id]
  );

  const cfgNoshow = await obtenerConfigNoshow(r.fecha);
  const fechaCancelacion = calcularFechaCancelacion(new Date(r.fecha), r.hora, cfgNoshow.horas_cancelacion);
  if (new Date() >= fechaCancelacion) {
    return res.status(403).json({ error: 'El plazo de modificación ha vencido para esta reserva.' });
  }

  res.json({ reserva: Object.assign({}, r, { extras: extras.rows }) });
}));

// ─── Portal cliente: guardar modificación de reserva ─────────────────────────
app.post('/api/cliente/modificar-completo', asyncHandler(async (req, res) => {
  if (!req.session || !req.session.clienteReservaId) return res.status(401).json({ error: 'No autenticado.' });

  // Si la sesión es de cuenta permanente, el email está directo en la sesión
  let emailCliente = req.session.clienteEmail || null;
  if (!emailCliente) {
    const emailResult = await pool.query('SELECT email_cliente FROM reservas WHERE id = $1', [req.session.clienteReservaId]);
    if (!emailResult.rows.length) return res.status(401).json({ error: 'No autenticado.' });
    emailCliente = emailResult.rows[0].email_cliente;
  }
  if (!emailCliente) return res.status(401).json({ error: 'No autenticado.' });

  const { pnr, fecha, hora, num_pasajeros, tipo_llegada, numero_vuelo, hora_llegada_vuelo,
          nombre_barco, hora_atraque, direccion_recogida, direccion_destino,
          notas_cliente, categoria_id, precio_estimado, extras } = req.body;

  const reservaQ = await pool.query(
    'SELECT * FROM reservas WHERE UPPER(numero_reserva) = UPPER($1) AND LOWER(email_cliente) = LOWER($2) AND archivada = FALSE',
    [pnr, emailCliente]
  );
  if (!reservaQ.rows.length) return res.status(404).json({ error: 'Reserva no encontrada.' });
  const r = reservaQ.rows[0];

  const cfgNoshow = await obtenerConfigNoshow(r.fecha);
  const fechaCancelacion = calcularFechaCancelacion(new Date(r.fecha), r.hora, cfgNoshow.horas_cancelacion);
  if (new Date() >= fechaCancelacion) {
    return res.status(403).json({ error: 'El plazo de modificación ha vencido.' });
  }

  // Detectar cambios para el historial
  const cambios = [];
  if (fecha && fecha !== (r.fecha ? r.fecha.toISOString().slice(0,10) : '')) cambios.push('Fecha: ' + (r.fecha ? r.fecha.toISOString().slice(0,10) : '—') + ' → ' + fecha);
  if (hora && hora !== (r.hora ? r.hora.slice(0,5) : '')) cambios.push('Hora: ' + (r.hora ? r.hora.slice(0,5) : '—') + ' → ' + hora);
  if (num_pasajeros && parseInt(num_pasajeros) !== r.num_pasajeros) cambios.push('Pasajeros: ' + (r.num_pasajeros || '—') + ' → ' + num_pasajeros);
  if (direccion_recogida && direccion_recogida !== (r.direccion_recogida || '')) cambios.push('Recogida: ' + (r.direccion_recogida || '—') + ' → ' + direccion_recogida);
  if (direccion_destino && direccion_destino !== (r.direccion_destino || '')) cambios.push('Destino dirección: ' + (r.direccion_destino || '—') + ' → ' + direccion_destino);
  if (numero_vuelo && numero_vuelo !== (r.numero_vuelo || '')) cambios.push('Vuelo: ' + (r.numero_vuelo || '—') + ' → ' + numero_vuelo);
  if (nombre_barco && nombre_barco !== (r.nombre_barco || '')) cambios.push('Barco: ' + (r.nombre_barco || '—') + ' → ' + nombre_barco);
  if (categoria_id && parseInt(categoria_id) !== r.categoria_id) {
    const catQ = await pool.query('SELECT nombre FROM categorias_vehiculos WHERE id = $1', [categoria_id]);
    const catActQ = await pool.query('SELECT nombre FROM categorias_vehiculos WHERE id = $1', [r.categoria_id]);
    cambios.push('Categoría: ' + (catActQ.rows[0] ? catActQ.rows[0].nombre : '—') + ' → ' + (catQ.rows[0] ? catQ.rows[0].nombre : '—'));
  }

  // Extras
  const extrasActualesQ = await pool.query('SELECT extra_id FROM reservas_extras WHERE reserva_id = $1 ORDER BY extra_id', [r.id]);
  const idsActuales = extrasActualesQ.rows.map(e => e.extra_id).sort();
  const idsNuevos = Array.isArray(extras) ? extras.map(e => e.extra_id).sort() : idsActuales;
  const extrasChanged = JSON.stringify(idsActuales) !== JSON.stringify(idsNuevos);
  if (extrasChanged) {
    const nombresActualesQ = await pool.query('SELECT id, nombre FROM extras WHERE id = ANY($1)', [idsActuales.length ? idsActuales : [0]]);
    const nombresNuevosQ = await pool.query('SELECT id, nombre FROM extras WHERE id = ANY($1)', [idsNuevos.length ? idsNuevos : [0]]);
    const mapAct = {}; nombresActualesQ.rows.forEach(e => { mapAct[e.id] = e.nombre; });
    const mapNuev = {}; nombresNuevosQ.rows.forEach(e => { mapNuev[e.id] = e.nombre; });
    const descAntes = idsActuales.length ? idsActuales.map(id => mapAct[id] || id).join(', ') : 'ninguno';
    const descDespues = idsNuevos.length ? idsNuevos.map(id => mapNuev[id] || id).join(', ') : 'ninguno';
    cambios.push('Extras: ' + descAntes + ' → ' + descDespues);
  }

  // Actualizar reserva
  await pool.query(
    `UPDATE reservas SET
      estado = 'modificacion_pendiente',
      fecha = COALESCE($1::date, fecha),
      hora = COALESCE($2::time, hora),
      num_pasajeros = COALESCE($3::int, num_pasajeros),
      tipo_llegada = COALESCE(NULLIF($4,''), tipo_llegada),
      numero_vuelo = COALESCE(NULLIF($5,''), numero_vuelo),
      hora_llegada_vuelo = COALESCE(NULLIF($6,'')::time, hora_llegada_vuelo),
      nombre_barco = COALESCE(NULLIF($7,''), nombre_barco),
      hora_atraque = COALESCE(NULLIF($8,'')::time, hora_atraque),
      direccion_recogida = COALESCE(NULLIF($9,''), direccion_recogida),
      direccion_destino = COALESCE(NULLIF($10,''), direccion_destino),
      notas_cliente = COALESCE(NULLIF($11,''), notas_cliente),
      categoria_id = COALESCE($12, categoria_id),
      precio_estimado = COALESCE($13, precio_estimado)
     WHERE id = $14`,
    [fecha||null, hora||null, num_pasajeros||null,
     tipo_llegada||null, numero_vuelo||null, hora_llegada_vuelo||null,
     nombre_barco||null, hora_atraque||null,
     direccion_recogida||null, direccion_destino||null, notas_cliente||null,
     categoria_id ? parseInt(categoria_id) : null,
     precio_estimado ? parseFloat(precio_estimado) : null,
     r.id]
  );

  // Actualizar extras si cambiaron
  if (extrasChanged && Array.isArray(extras)) {
    await pool.query('DELETE FROM reservas_extras WHERE reserva_id = $1', [r.id]);
    for (const ex of extras) {
      await pool.query(
        'INSERT INTO reservas_extras (reserva_id, extra_id, precio_en_reserva) VALUES ($1, $2, $3)',
        [r.id, ex.extra_id, ex.precio]
      );
    }
  }

  // Registrar en historial
  const textoHistorial = '✏️ Modificación solicitada por el cliente:\n' + (cambios.length ? cambios.join('\n') : 'Sin cambios detectados');
  await pool.query(
    'INSERT INTO reservas_mensajes (reserva_id, autor, mensaje) VALUES ($1, $2, $3)',
    [r.id, 'admin', textoHistorial]
  );

  // Notificar al equipo
  try {
    const emails = await obtenerEmailsNotificacion();
    for (const em of emails) {
      await enviarEmail({
        to: em,
        subject: '✏️ Modificación solicitada — ' + r.numero_reserva,
        html: plantillaEmail(`<p>El cliente <strong>${r.nombre_cliente}</strong> ha solicitado modificaciones en la reserva <strong>${r.numero_reserva}</strong>.</p><p><strong>Cambios solicitados:</strong></p><ul>${cambios.map(c => '<li>' + c + '</li>').join('')}</ul><p>Accede al panel de administración para revisar y aprobar.</p>`)
      });
    }
  } catch(e) { console.warn('Error notificando modificación al equipo:', e.message); }

  res.json({ ok: true });
}));

// ─── Portal cliente: cancelar reserva ────────────────────────────────────────
app.post('/api/cliente/cancelar', asyncHandler(async (req, res) => {
  if (!req.session || !req.session.clienteReservaId) return res.status(401).json({ error: 'No autenticado.' });

  // Si la sesión es de cuenta permanente, el email está directo en la sesión
  let emailCliente = req.session.clienteEmail || null;
  if (!emailCliente) {
    const emailResult = await pool.query('SELECT email_cliente FROM reservas WHERE id = $1', [req.session.clienteReservaId]);
    if (!emailResult.rows.length) return res.status(401).json({ error: 'No autenticado.' });
    emailCliente = emailResult.rows[0].email_cliente;
  }
  if (!emailCliente) return res.status(401).json({ error: 'No autenticado.' });

  const { reserva_id } = req.body;
  const reservaQ = await pool.query(
    'SELECT * FROM reservas WHERE id = $1 AND LOWER(email_cliente) = LOWER($2) AND archivada = FALSE',
    [reserva_id, emailCliente]
  );
  if (!reservaQ.rows.length) return res.status(404).json({ error: 'Reserva no encontrada.' });
  const r = reservaQ.rows[0];

  if (['completada', 'cancelada'].includes(r.estado)) {
    return res.status(400).json({ error: 'Esta reserva no se puede cancelar.' });
  }

  // Verificar política de cancelación (no-show)
  const cfgNoshow = await obtenerConfigNoshow(r.fecha);
  const fechaCancelacion = calcularFechaCancelacion(new Date(r.fecha), r.hora, cfgNoshow.horas_cancelacion);
  const fueraDePlazo = new Date() >= fechaCancelacion;

  await pool.query('UPDATE reservas SET estado = $1 WHERE id = $2', ['cancelada', r.id]);

  const devolucionPendiente = r.deposito_pagado && !fueraDePlazo;
  if (devolucionPendiente) {
    await pool.query('UPDATE reservas SET deposito_devolucion_pendiente = TRUE WHERE id = $1', [r.id]);
  }

  if (r.conductor_id) {
    try {
      const choferQ = await pool.query('SELECT nombre, telefono FROM conductores WHERE id = $1', [r.conductor_id]);
      if (choferQ.rows.length && choferQ.rows[0].telefono) {
        const fechaTextoChofer = r.fecha ? new Date(r.fecha).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
        const _pcc = await obtenerPlantilla('chofer_cancelacion', {
          nombre_chofer: choferQ.rows[0].nombre || '',
          numero_reserva: r.numero_reserva,
          origen: r.origen || '—',
          destino: r.destino || '—',
          fecha: fechaTextoChofer,
          hora: r.hora ? r.hora.slice(0,5) : '—'
        });
        const textoChofer = (_pcc && _pcc.whatsapp) || ('❌ Cancelación de reserva\nReserva: ' + r.numero_reserva + '\nRuta: ' + (r.origen || '—') + ' → ' + (r.destino || '—') + '\nFecha: ' + fechaTextoChofer + ' · ' + (r.hora ? r.hora.slice(0, 5) : '—') + '\n\nEsta reserva ha sido cancelada por el cliente. Queda liberada de tu agenda.');
        await pool.query(
          'INSERT INTO whatsapp_mensajes_pendientes (telefono, texto) VALUES ($1, $2)',
          [choferQ.rows[0].telefono, textoChofer]
        );
      }
    } catch(e) { console.warn('Error notificando cancelaci\u00f3n al chofer:', e.message); }
  }


  await pool.query(
    'INSERT INTO reservas_mensajes (reserva_id, autor, mensaje) VALUES ($1, $2, $3)',
    [r.id, 'admin', '❌ Reserva cancelada por el cliente.']
  );

  // Notificar al equipo
  try {
    const emails = await obtenerEmailsNotificacion();
    for (const em of emails) {
      await enviarEmail({
        to: em,
        subject: '❌ Cancelación de reserva — ' + r.numero_reserva,
        html: plantillaEmail(`<p>El cliente <strong>${r.nombre_cliente}</strong> ha cancelado la reserva <strong>${r.numero_reserva}</strong>.</p><p>Ruta: ${r.origen || '—'} → ${r.destino || '—'}</p><p>Fecha: ${r.fecha ? new Date(r.fecha).toLocaleDateString('es-ES') : '—'}</p>`)
      });
    }
  } catch(e) { console.warn('Error notificando cancelación:', e.message); }

  // Confirmar al cliente
  try {
    const fechaTextoCancel = r.fecha ? new Date(r.fecha).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
    const avisoDeposito = r.deposito_pagado
      ? (fueraDePlazo
          ? '<p style="background:#fff3cd;border:1px solid #ffe083;border-radius:6px;padding:10px 14px;font-size:13px;color:#856404;">⚠️ La cancelación se ha realizado fuera del plazo permitido. El depósito de garantía podría ser retenido según nuestra política de cancelación.</p>'
          : '<p style="background:#e8f5e9;border:1px solid #c8e6c9;border-radius:6px;padding:10px 14px;font-size:13px;color:#2e7d32;">✅ La cancelación se ha realizado dentro del plazo establecido. El depósito de garantía te será devuelto en breve. Recibirás una notificación cuando se procese la devolución.</p>')
      : '<p style="color:#2e7d32;font-size:13px;">✅ La cancelación se ha realizado dentro del plazo establecido.</p>';
    const _pcancelE = await obtenerPlantilla('cliente_cancelacion', {
      nombre_cliente: r.nombre_cliente,
      numero_reserva: r.numero_reserva,
      origen: r.origen || '—',
      destino: r.destino || '—',
      fecha: fechaTextoCancel,
      aviso_deposito: avisoDeposito
    });
    await enviarEmail({
      to: r.email_cliente,
      subject: (_pcancelE && _pcancelE.asunto) || ('Tu reserva ' + r.numero_reserva + ' ha sido cancelada'),
      html: plantillaEmail(
        (_pcancelE && _pcancelE.email) ||
        `<p>Hola <strong>${r.nombre_cliente}</strong>,</p>
         <p>Tu reserva <strong>${r.numero_reserva}</strong> ha sido cancelada correctamente.</p>
         <div class="info-box">
           <strong>Origen:</strong> ${r.origen || '—'}<br>
           <strong>Destino:</strong> ${r.destino || '—'}
         </div>
         ${avisoDeposito}
         <p>Si tienes alguna duda, puedes contactarnos por WhatsApp.</p>`
      )
    });
  } catch(e) { console.warn('Error enviando email cancelación al cliente:', e.message); }

  // WhatsApp al cliente
  if (r.telefono_cliente) {
    try {
      const fechaTextoWa = r.fecha ? new Date(r.fecha).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
      const _pcancelWa = await obtenerPlantilla('cliente_cancelacion', {
        nombre_cliente: r.nombre_cliente,
        numero_reserva: r.numero_reserva,
        origen: r.origen || '—',
        destino: r.destino || '—',
        fecha: fechaTextoWa,
        aviso_deposito: fueraDePlazo ? '⚠️ La cancelación se ha realizado fuera del plazo establecido. El depósito de garantía podría ser retenido.' : '✅ La cancelación se ha realizado dentro del plazo establecido. El depósito de garantía te será devuelto en breve.'
      });
      const textoWa = (_pcancelWa && _pcancelWa.whatsapp) || (fueraDePlazo
        ? `Hola, ${r.nombre_cliente} 👋\n\nTu reserva ${r.numero_reserva} (${r.origen || '—'} → ${r.destino || '—'}) del ${fechaTextoWa} ha sido cancelada.\n\n⚠️ La cancelación se ha realizado fuera del plazo establecido. El depósito de garantía podría ser retenido según nuestra política de cancelación.\n\nSi tienes alguna duda, contáctanos. Un saludo 🙏`
        : `Hola, ${r.nombre_cliente} 👋\n\nTu reserva ${r.numero_reserva} (${r.origen || '—'} → ${r.destino || '—'}) del ${fechaTextoWa} ha sido cancelada correctamente.\n\n✅ La cancelación se ha realizado dentro del plazo establecido. El depósito de garantía te será devuelto en breve. Recibirás una notificación cuando se procese la devolución.\n\nUn saludo 🙏`);
      await pool.query(
        'INSERT INTO whatsapp_mensajes_pendientes (telefono, texto) VALUES ($1, $2)',
        [r.telefono_cliente, textoWa]
      );
    } catch(e) { console.warn('Error encolando WhatsApp cancelación:', e.message); }
  }

  res.json({ ok: true, fuera_de_plazo: fueraDePlazo });
}));

// ─── Admin: aprobar modificación de reserva ───────────────────────────────────
app.post('/admin/reservas/:id/aprobar-modificacion', requireAdmin, asyncHandler(async (req, res) => {
  const { comentario } = req.body;
  const reservaQ = await pool.query('SELECT * FROM reservas WHERE id = $1', [req.params.id]);
  if (!reservaQ.rows.length) return res.status(404).json({ error: 'Reserva no encontrada.' });
  const r = reservaQ.rows[0];

  const nuevoEstado = r.conductor_id ? 'confirmada' : 'pendiente';
  await pool.query('UPDATE reservas SET estado = $1 WHERE id = $2', [nuevoEstado, r.id]);

  // Mensaje unificado: aprobación + comentario si existe
  const textoMensaje = comentario
    ? '✅ Modificación aprobada por el equipo. Comentario: ' + comentario
    : '✅ Modificación aprobada por el equipo.';

  await pool.query(
    'INSERT INTO reservas_mensajes (reserva_id, autor, mensaje) VALUES ($1, $2, $3)',
    [r.id, 'admin', textoMensaje]
  );

  // Notificar al cliente
  try {
    const actualizada = await pool.query(
      `SELECT r.*, cv.nombre AS categoria_nombre FROM reservas r
       LEFT JOIN categorias_vehiculos cv ON cv.id = r.categoria_id WHERE r.id = $1`,
      [r.id]
    );
    const ra = actualizada.rows[0];
    const extrasQ = await pool.query(
      `SELECT e.nombre, re.precio_en_reserva FROM reservas_extras re
       JOIN extras e ON e.id = re.extra_id WHERE re.reserva_id = $1`, [r.id]
    );
    const fechaViaje = ra.fecha ? new Date(ra.fecha).toLocaleDateString('es-ES', {day:'numeric', month:'long', year:'numeric'}) : '—';
    const lineas = [
      '<strong>Ruta:</strong> ' + (ra.origen || '—') + ' → ' + (ra.destino || '—'),
      '<strong>Fecha:</strong> ' + fechaViaje,
      '<strong>Hora:</strong> ' + (ra.hora ? ra.hora.slice(0,5) : '—'),
      '<strong>Pasajeros:</strong> ' + (ra.num_pasajeros || '—'),
      '<strong>Categoría:</strong> ' + (ra.categoria_nombre || '—'),
    ];
    if (ra.direccion_recogida) lineas.push('<strong>Recogida:</strong> ' + ra.direccion_recogida);
    if (ra.direccion_destino) lineas.push('<strong>Destino:</strong> ' + ra.direccion_destino);
    if (ra.numero_vuelo) lineas.push('<strong>Vuelo:</strong> ' + ra.numero_vuelo + (ra.hora_llegada_vuelo ? ' · Llegada ' + ra.hora_llegada_vuelo.slice(0,5) : ''));
    if (ra.nombre_barco) lineas.push('<strong>Barco:</strong> ' + ra.nombre_barco + (ra.hora_atraque ? ' · Atraque ' + ra.hora_atraque.slice(0,5) : ''));
    if (extrasQ.rows.length) lineas.push('<strong>Extras:</strong> ' + extrasQ.rows.map(e => e.nombre + ' (' + parseFloat(e.precio_en_reserva).toFixed(2) + ' €)').join(', '));

    const _pma = await obtenerPlantilla('cliente_modificacion_aprobada', {
      nombre_cliente: ra.nombre_cliente,
      numero_reserva: ra.numero_reserva
    });
    await enviarEmail({
      to: ra.email_cliente,
      subject: (_pma && _pma.asunto) || ('✅ Tu modificación ha sido aprobada — ' + ra.numero_reserva),
      html: plantillaEmail(
        (_pma && _pma.email) ||
        `<p>Hola <strong>${ra.nombre_cliente}</strong>,</p>
         <p>Hemos revisado y aprobado los cambios en tu reserva <strong>${ra.numero_reserva}</strong>.</p>
         <div class="info-box">${lineas.join('<br>')}</div>
         <p>Accede a tu portal para ver todos los detalles:<br>
         <a href="${BASE_URL}/mi-reserva" style="color:#C1502E;">${BASE_URL}/mi-reserva</a></p>`
      )
    });
  } catch(e) { console.warn('Error enviando email aprobación:', e.message); }

  res.json({ ok: true, nuevo_estado: nuevoEstado });
}));

// ─── Admin: mensaje al chofer ─────────────────────────────────────────────────
app.post('/admin/reservas/:id/mensaje-chofer', requireAdmin, asyncHandler(async (req, res) => {
  const { mensaje } = req.body;
  if (!mensaje || !mensaje.trim()) return res.status(400).json({ error: 'El mensaje no puede estar vacío.' });

  const reserva = await pool.query(
    `SELECT r.*, c.email AS conductor_email, c.nombre AS conductor_nombre
     FROM reservas r LEFT JOIN conductores c ON c.id = r.conductor_id WHERE r.id = $1`,
    [req.params.id]
  );
  if (!reserva.rows.length) return res.status(404).json({ error: 'Reserva no encontrada.' });
  const r = reserva.rows[0];

  await pool.query(
    'INSERT INTO reservas_mensajes_chofer (reserva_id, autor, mensaje) VALUES ($1, $2, $3)',
    [req.params.id, 'admin', mensaje.trim()]
  );

  // Notificar al chofer por email si tiene email
  if (r.conductor_email) {
    try {
      await enviarEmail({
        to: r.conductor_email,
        subject: '💬 Mensaje sobre la reserva ' + r.numero_reserva,
        html: plantillaEmail(
          `<p>Hola <strong>${r.conductor_nombre || 'Chofer'}</strong>,</p>
           <p>El equipo de Traslados GC te ha enviado un mensaje sobre la reserva <strong>${r.numero_reserva}</strong>:</p>
           <blockquote>${mensaje.trim().replace(/\n/g,'<br>')}</blockquote>
           <p>Accede a tu portal para ver los detalles:<br>
           <a href="${BASE_URL}/chofer/portal" style="color:#C1502E;">${BASE_URL}/chofer/portal</a></p>`
        )
      });
    } catch(e) { console.warn('Error enviando email al chofer:', e.message); }
  }

  res.json({ ok: true });
}));

app.get('/admin/reservas/:id/mensajes-chofer', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT id, autor, mensaje, creado_en FROM reservas_mensajes_chofer WHERE reserva_id = $1 ORDER BY creado_en ASC',
    [req.params.id]
  );
  res.json({ mensajes: result.rows });
}));

// ─── Admin: mensajes de una reserva ──────────────────────────────────────────
// Admin: editar datos de una reserva
app.post('/admin/reservas/:id/editar', requireAdmin, asyncHandler(async (req, res) => {
  const { fecha, hora, num_pasajeros, direccion_recogida, direccion_destino,
          numero_vuelo, hora_llegada_vuelo, nombre_barco, hora_atraque, notas_cliente,
          categoria_id, extras } = req.body;

  const actual = await pool.query('SELECT * FROM reservas WHERE id = $1', [req.params.id]);
  if (!actual.rows.length) return res.status(404).json({ error: 'Reserva no encontrada.' });
  const r = actual.rows[0];

  // ── Validar cambio de categoría ──────────────────────────────────────────
  let nuevoPrecio = null;
  let categoriaNombreNueva = null;
  if (categoria_id && parseInt(categoria_id) !== r.categoria_id) {
    // Verificar que existe precio para ruta × categoría nueva
    const precioQ = await pool.query(
      'SELECT precio FROM rutas_precios WHERE ruta_id = $1 AND categoria_id = $2',
      [r.ruta_id, categoria_id]
    );
    if (!precioQ.rows.length) {
      const catQ = await pool.query('SELECT nombre FROM categorias_vehiculos WHERE id = $1', [categoria_id]);
      const nombreCat = catQ.rows.length ? catQ.rows[0].nombre : 'seleccionada';
      return res.json({ ok: false, error: 'La categoría "' + nombreCat + '" no tiene precio configurado para esta ruta. Añádelo primero en la sección Precios.' });
    }
    nuevoPrecio = precioQ.rows[0].precio;
    const catQ = await pool.query('SELECT nombre FROM categorias_vehiculos WHERE id = $1', [categoria_id]);
    categoriaNombreNueva = catQ.rows.length ? catQ.rows[0].nombre : '';
  }

  // ── Detectar cambios de campos básicos ──────────────────────────────────
  const cambios = [];
  if (fecha && fecha !== (r.fecha ? r.fecha.toISOString().slice(0,10) : '')) cambios.push('Fecha: ' + (r.fecha ? r.fecha.toISOString().slice(0,10) : '—') + ' → ' + fecha);
  if (hora && hora !== (r.hora ? r.hora.slice(0,5) : '')) cambios.push('Hora: ' + (r.hora ? r.hora.slice(0,5) : '—') + ' → ' + hora);
  if (num_pasajeros && parseInt(num_pasajeros) !== r.num_pasajeros) cambios.push('Pasajeros: ' + (r.num_pasajeros || '—') + ' → ' + num_pasajeros);
  if (direccion_recogida && direccion_recogida !== (r.direccion_recogida || '')) cambios.push('Recogida: ' + (r.direccion_recogida || '—') + ' → ' + direccion_recogida);
  if (direccion_destino && direccion_destino !== (r.direccion_destino || '')) cambios.push('Destino: ' + (r.direccion_destino || '—') + ' → ' + direccion_destino);
  if (numero_vuelo && numero_vuelo !== (r.numero_vuelo || '')) cambios.push('Vuelo: ' + (r.numero_vuelo || '—') + ' → ' + numero_vuelo);
  if (hora_llegada_vuelo && hora_llegada_vuelo !== (r.hora_llegada_vuelo ? r.hora_llegada_vuelo.slice(0,5) : '')) cambios.push('Hora vuelo: ' + (r.hora_llegada_vuelo ? r.hora_llegada_vuelo.slice(0,5) : '—') + ' → ' + hora_llegada_vuelo);
  if (nombre_barco && nombre_barco !== (r.nombre_barco || '')) cambios.push('Barco: ' + (r.nombre_barco || '—') + ' → ' + nombre_barco);
  if (hora_atraque && hora_atraque !== (r.hora_atraque ? r.hora_atraque.slice(0,5) : '')) cambios.push('Hora atraque: ' + (r.hora_atraque ? r.hora_atraque.slice(0,5) : '—') + ' → ' + hora_atraque);
  if (notas_cliente && notas_cliente !== (r.notas_cliente || '')) cambios.push('Notas: actualizadas');
  if (categoriaNombreNueva) {
    const catActualQ = await pool.query('SELECT nombre FROM categorias_vehiculos WHERE id = $1', [r.categoria_id]);
    const catActualNombre = catActualQ.rows.length ? catActualQ.rows[0].nombre : '—';
    cambios.push('Categoría: ' + catActualNombre + ' → ' + categoriaNombreNueva + ' (' + parseFloat(nuevoPrecio).toFixed(2) + ' €)');
  }

  // ── Detectar cambios de extras ───────────────────────────────────────────
  const extrasActualesQ = await pool.query(
    'SELECT extra_id FROM reservas_extras WHERE reserva_id = $1 ORDER BY extra_id',
    [req.params.id]
  );
  const idsActuales = extrasActualesQ.rows.map(function(e) { return e.extra_id; }).sort();
  const idsNuevos = Array.isArray(extras) ? extras.map(function(e) { return e.extra_id; }).sort() : idsActuales;
  const extrasChanged = JSON.stringify(idsActuales) !== JSON.stringify(idsNuevos);

  // ── Actualizar campos básicos ────────────────────────────────────────────
  const catIdFinal = (categoria_id && parseInt(categoria_id) !== r.categoria_id) ? parseInt(categoria_id) : null;
  await pool.query(
    `UPDATE reservas SET
      fecha = COALESCE($1::date, fecha),
      hora = COALESCE($2::time, hora),
      num_pasajeros = COALESCE($3::int, num_pasajeros),
      direccion_recogida = COALESCE(NULLIF($4,''), direccion_recogida),
      direccion_destino = COALESCE(NULLIF($5,''), direccion_destino),
      numero_vuelo = COALESCE(NULLIF($6,''), numero_vuelo),
      hora_llegada_vuelo = COALESCE(NULLIF($7,'')::time, hora_llegada_vuelo),
      nombre_barco = COALESCE(NULLIF($8,''), nombre_barco),
      hora_atraque = COALESCE(NULLIF($9,'')::time, hora_atraque),
      notas_cliente = COALESCE(NULLIF($10,''), notas_cliente),
      categoria_id = COALESCE($11, categoria_id),
      precio_estimado = COALESCE($12, precio_estimado)
     WHERE id = $13`,
    [fecha||null, hora||null, num_pasajeros||null,
     direccion_recogida||null, direccion_destino||null,
     numero_vuelo||null, hora_llegada_vuelo||null,
     nombre_barco||null, hora_atraque||null,
     notas_cliente||null,
     catIdFinal, nuevoPrecio,
     req.params.id]
  );

  // ── Actualizar extras si cambiaron ──────────────────────────────────────
  if (extrasChanged && Array.isArray(extras)) {
    await pool.query('DELETE FROM reservas_extras WHERE reserva_id = $1', [req.params.id]);
    for (const ex of extras) {
      await pool.query(
        'INSERT INTO reservas_extras (reserva_id, extra_id, precio_en_reserva) VALUES ($1, $2, $3)',
        [req.params.id, ex.extra_id, ex.precio]
      );
    }
    // Descripción del cambio de extras
    const nombresQ = await pool.query('SELECT id, nombre FROM extras WHERE id = ANY($1)', [idsNuevos.length ? idsNuevos : [0]]);
    const nombresMap = {};
    nombresQ.rows.forEach(function(e) { nombresMap[e.id] = e.nombre; });
    const desc = idsNuevos.length ? idsNuevos.map(function(id) { return nombresMap[id] || id; }).join(', ') : 'ninguno';
    cambios.push('Extras: ' + desc);
  }

  // ── Leer reserva actualizada ─────────────────────────────────────────────
  const actualizada = await pool.query(
    `SELECT r.*, cv.nombre AS categoria_nombre
     FROM reservas r
     LEFT JOIN categorias_vehiculos cv ON cv.id = r.categoria_id
     WHERE r.id = $1`,
    [req.params.id]
  );
  const ra = actualizada.rows[0];

  // ── Extras finales para el email ─────────────────────────────────────────
  const extrasFinalesQ = await pool.query(
    `SELECT e.nombre, re.precio_en_reserva FROM reservas_extras re JOIN extras e ON e.id = re.extra_id WHERE re.reserva_id = $1`,
    [req.params.id]
  );
  const extrasFin = extrasFinalesQ.rows;

  if (cambios.length && ra) {
    // Registrar en historial
    const texto = '✏️ Reserva modificada por el equipo:\n' + cambios.join('\n');
    await pool.query(
      'INSERT INTO reservas_mensajes (reserva_id, autor, mensaje) VALUES ($1, $2, $3)',
      [req.params.id, 'admin', texto]
    );

    // Enviar email al cliente con resumen actualizado
    try {
      const fechaViaje = ra.fecha ? new Date(ra.fecha).toLocaleDateString('es-ES', {day:'numeric', month:'long', year:'numeric'}) : '—';
      const lineas = [
        '<strong>Ruta:</strong> ' + (ra.origen || '—') + ' → ' + (ra.destino || '—'),
        '<strong>Fecha:</strong> ' + fechaViaje,
        '<strong>Hora de recogida:</strong> ' + (ra.hora ? ra.hora.slice(0,5) : '—'),
        '<strong>Pasajeros:</strong> ' + (ra.num_pasajeros || '—'),
        '<strong>Categoría:</strong> ' + (ra.categoria_nombre || '—'),
        '<strong>Precio estimado:</strong> ' + (ra.precio_estimado ? parseFloat(ra.precio_estimado).toFixed(2) + ' €' : '—'),
      ];
      if (ra.direccion_recogida) lineas.push('<strong>Dirección de recogida:</strong> ' + ra.direccion_recogida);
      if (ra.direccion_destino) lineas.push('<strong>Dirección de destino:</strong> ' + ra.direccion_destino);
      if (ra.numero_vuelo) lineas.push('<strong>Vuelo:</strong> ' + ra.numero_vuelo + (ra.hora_llegada_vuelo ? ' · Llegada ' + ra.hora_llegada_vuelo.slice(0,5) : ''));
      if (ra.nombre_barco) lineas.push('<strong>Barco:</strong> ' + ra.nombre_barco + (ra.hora_atraque ? ' · Atraque ' + ra.hora_atraque.slice(0,5) : ''));
      if (extrasFin.length) lineas.push('<strong>Extras:</strong> ' + extrasFin.map(function(e) { return e.nombre + ' (' + parseFloat(e.precio_en_reserva).toFixed(2) + ' €)'; }).join(', '));
      if (ra.notas_cliente) lineas.push('<strong>Notas:</strong> ' + ra.notas_cliente);

      await enviarEmail({
        to: ra.email_cliente,
        subject: '✏️ Tu reserva ' + ra.numero_reserva + ' ha sido actualizada',
        html: plantillaEmail(
          `<p>Hola <strong>${ra.nombre_cliente}</strong>,</p>
           <p>Tu reserva <strong>${ra.numero_reserva}</strong> ha sido actualizada por nuestro equipo.</p>
           <p><strong>Resumen actualizado:</strong></p>
           <div class="info-box">${lineas.join('<br>')}</div>
           <p>Si tienes alguna pregunta, accede a tu portal:<br>
           <a href="${BASE_URL}/mi-reserva" style="color:#C1502E;">${BASE_URL}/mi-reserva</a></p>`
        )
      });
    } catch(e) { console.warn('Error enviando email de modificación al cliente:', e.message); }
  }

  res.json({ ok: true, cambios: cambios.length });
}));


// Admin: responder al cliente
app.post('/admin/reservas/:id/mensaje', requireAdmin, asyncHandler(async (req, res) => {
  const { mensaje } = req.body;
  if (!mensaje || !mensaje.trim()) return res.status(400).json({ error: 'El mensaje no puede estar vacío.' });

  await pool.query(
    'INSERT INTO reservas_mensajes (reserva_id, autor, mensaje) VALUES ($1, $2, $3)',
    [req.params.id, 'admin', mensaje.trim()]
  );

  // Notificar al cliente por email
  try {
    const reserva = await pool.query(
      'SELECT nombre_cliente, email_cliente, numero_reserva FROM reservas WHERE id = $1',
      [req.params.id]
    );
    if (reserva.rows.length) {
      const r = reserva.rows[0];
      const _pmsg = await obtenerPlantilla('cliente_mensaje_admin', {
        nombre_cliente: r.nombre_cliente,
        numero_reserva: r.numero_reserva,
        mensaje: mensaje.trim().replace(/\n/g,'<br>')
      });
      await enviarEmail({
        to: r.email_cliente,
        subject: (_pmsg && _pmsg.asunto) || ('💬 Tienes un mensaje sobre tu reserva ' + r.numero_reserva),
        html: plantillaEmail(
          (_pmsg && _pmsg.email) ||
          `<p>Hola <strong>${r.nombre_cliente}</strong>,</p>
           <p>El equipo de Traslados GC te ha enviado un mensaje sobre tu reserva <strong>${r.numero_reserva}</strong>:</p>
           <blockquote>${mensaje.trim().replace(/\n/g,'<br>')}</blockquote>
           <p>Accede a tu portal para ver el hilo completo y responder:<br>
           <a href="${BASE_URL}/mi-reserva" style="color:#C1502E;">${BASE_URL}/mi-reserva</a></p>`
        )
      });
    }
  } catch(e) { console.warn('Error enviando email al cliente:', e.message); }

  res.json({ ok: true });
}));

// Admin: mensajes del cliente
app.get('/admin/reservas/:id/mensajes', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT id, autor, mensaje, leido, creado_en FROM reservas_mensajes WHERE reserva_id = $1 ORDER BY creado_en ASC',
    [req.params.id]
  );
  // Marcar mensajes del cliente como leídos
  await pool.query(
    "UPDATE reservas_mensajes SET leido = TRUE WHERE reserva_id = $1 AND autor = 'cliente'",
    [req.params.id]
  );
  res.json({ mensajes: result.rows });
}));

// Admin: liberar depósito
app.post('/admin/reservas/:id/liberar-deposito', requireAdmin, asyncHandler(async (req, res) => {
  const reserva = await pool.query('SELECT * FROM reservas WHERE id = $1', [req.params.id]);
  if (!reserva.rows.length) return res.status(404).json({ error: 'Reserva no encontrada.' });
  const r = reserva.rows[0];

  await pool.query('UPDATE reservas SET deposito_liberado = TRUE WHERE id = $1', [req.params.id]);

  // Generar factura PDF
  let facturaBuffer = null;
  let numeroFactura = null;
  try {
    const resultado = await generarFacturaPDF(req.params.id);
    if (resultado) {
      facturaBuffer = resultado.buffer;
      numeroFactura = resultado.numeroFactura;
    }
  } catch(e) { console.warn('Error generando factura:', e.message); }

  // Email elegante al cliente con factura adjunta
  try {
    const adjunto = facturaBuffer ? { filename: 'factura-' + r.numero_reserva + '.pdf', content: facturaBuffer } : null;
    const fnEmail = adjunto ? enviarEmailConAdjunto : enviarEmail;
    const fechaViaje = r.fecha ? new Date(r.fecha).toLocaleDateString('es-ES', {day:'numeric', month:'long', year:'numeric'}) : '—';
    const _pdl = await obtenerPlantilla('cliente_deposito_liberado', {
      nombre_cliente: r.nombre_cliente,
      numero_reserva: r.numero_reserva,
      origen: r.origen || '—',
      destino: r.destino || '—',
      fecha: fechaViaje,
      numero_factura: numeroFactura || ''
    });
    await fnEmail({
      to: r.email_cliente,
      subject: (_pdl && _pdl.asunto) || ('✅ Servicio completado — ' + r.numero_reserva),
      html: plantillaEmail(
        (_pdl && _pdl.email) ||
        `<p>Hola <strong>${r.nombre_cliente}</strong> 👋</p>
         <div class="caja-verde">
           ✅ <strong>Servicio completado con éxito.</strong> El depósito de garantía correspondiente a tu reserva <span class="pnr">${r.numero_reserva}</span> ha sido liberado correctamente. El importe quedará disponible en tu tarjeta en un plazo de 5 a 10 días hábiles según tu entidad bancaria.
         </div>
         <div class="info-box">
           <strong>Ruta:</strong> ${r.origen || '—'} → ${r.destino || '—'}<br>
           <strong>Fecha del servicio:</strong> ${fechaViaje}<br>
           <strong>Reserva:</strong> <span class="pnr">${r.numero_reserva}</span>
         </div>
         ${facturaBuffer ? `<div class="caja-amarilla">📄 Adjuntamos la <strong>factura ${numeroFactura}</strong> de tu servicio para tus registros.</div>` : ''}
         <p>Ha sido un placer acompañarte en este viaje. Si en algún momento necesitas otro traslado en Gran Canaria, estaremos encantados de ayudarte.<br><br>Un saludo cordial,<br><strong>El equipo de Traslados GC</strong></p>`
      ),
      ...(adjunto ? { adjunto } : {})
    });
  } catch(e) { console.warn('Error enviando email liberación depósito:', e.message); }

  // Email de gracias al chofer
  try {
    const conductorQ = await pool.query(
      'SELECT c.email, c.nombre FROM conductores c JOIN reservas r ON r.conductor_id = c.id WHERE r.id = $1',
      [req.params.id]
    );
    if (conductorQ.rows.length && conductorQ.rows[0].email) {
      const chofer = conductorQ.rows[0];
      const fechaViaje = r.fecha ? new Date(r.fecha).toLocaleDateString('es-ES', {day:'numeric', month:'long', year:'numeric'}) : '—';
      const _pgs = await obtenerPlantilla('chofer_gracias_servicio', {
        nombre_chofer: chofer.nombre,
        numero_reserva: r.numero_reserva,
        origen: r.origen || '—',
        destino: r.destino || '—',
        fecha: fechaViaje
      });
      await enviarEmail({
        to: chofer.email,
        subject: (_pgs && _pgs.asunto) || ('🙏 Gracias por el servicio — ' + r.numero_reserva),
        html: plantillaEmail(
          (_pgs && _pgs.email) ||
          `<p>Hola <strong>${chofer.nombre}</strong> 👋</p>
           <div class="caja-verde">
             ✅ <strong>Servicio completado.</strong> Gracias por realizar el traslado con profesionalidad y puntualidad. Tu trabajo es la base de nuestro servicio.
           </div>
           <div class="info-box">
             <strong>Reserva:</strong> <span class="pnr" style="font-size:15px;">${r.numero_reserva}</span><br>
             <strong>Ruta:</strong> ${r.origen || '—'} → ${r.destino || '—'}<br>
             <strong>Fecha:</strong> ${fechaViaje}
           </div>
           <p>Seguimos contando contigo para los próximos servicios. ¡Hasta pronto!<br><br>Un saludo,<br><strong>El equipo de Traslados GC</strong></p>`
        )
      });
    }
  } catch(e) { console.warn('Error enviando email gracias al chofer:', e.message); }

  // WhatsApp al cliente
  if (r.telefono_cliente) {
    try {
      const fechaViajeDl = r.fecha ? new Date(r.fecha).toLocaleDateString('es-ES', {day:'numeric', month:'long', year:'numeric'}) : '—';
      const _pdlwa = await obtenerPlantilla('cliente_deposito_liberado', {
        nombre_cliente: r.nombre_cliente,
        numero_reserva: r.numero_reserva,
        origen: r.origen || '—',
        destino: r.destino || '—',
        fecha: fechaViajeDl,
        numero_factura: numeroFactura || ''
      });
      const textoWa = (_pdlwa && _pdlwa.whatsapp) || `Hola, ${r.nombre_cliente} 👋\n\nEl depósito de garantía de tu reserva ${r.numero_reserva} (${r.origen || '—'} → ${r.destino || '—'}) ha sido liberado. El importe quedará disponible en tu tarjeta en un plazo de 5 a 10 días hábiles según tu entidad bancaria.\n\nUn saludo, el equipo de Traslados GC 🙏`;
      await pool.query(
        'INSERT INTO whatsapp_mensajes_pendientes (telefono, texto) VALUES ($1, $2)',
        [r.telefono_cliente, textoWa]
      );
    } catch(e) { console.warn('Error encolando WhatsApp liberación depósito:', e.message); }
  }

  res.json({ ok: true });
}));

// Admin: retener depósito por no-show
app.post('/admin/reservas/:id/retener-noshow', requireAdmin, asyncHandler(async (req, res) => {
  const reserva = await pool.query('SELECT * FROM reservas WHERE id = $1', [req.params.id]);
  if (!reserva.rows.length) return res.status(404).json({ error: 'Reserva no encontrada.' });
  const r = reserva.rows[0];

  await pool.query('UPDATE reservas SET deposito_retenido_noshow = TRUE WHERE id = $1', [req.params.id]);

  const fechaViaje = r.fecha ? new Date(r.fecha).toLocaleDateString('es-ES', {day:'numeric', month:'long', year:'numeric'}) : '—';
  const importe = r.deposito_importe || '10';

  // Email al cliente
  try {
    const _pns2 = await obtenerPlantilla('cliente_deposito_noshow', {
      nombre_cliente: r.nombre_cliente,
      numero_reserva: r.numero_reserva,
      origen: r.origen || '—',
      destino: r.destino || '—',
      fecha: fechaViaje,
      importe: importe
    });
    await enviarEmail({
      to: r.email_cliente,
      subject: (_pns2 && _pns2.asunto) || ('🔒 Depósito retenido por no-show — ' + r.numero_reserva),
      html: plantillaEmail(
        (_pns2 && _pns2.email) ||
        `<p>Hola <strong>${r.nombre_cliente}</strong> 👋</p>
         <div class="caja-roja">
           <p style="margin:0 0 8px 0;font-weight:700;font-size:15px;">🔒 Depósito retenido por no-show</p>
           <p style="margin:0;font-size:14px;line-height:1.6;">Lamentamos informarte de que tu traslado <strong>${r.numero_reserva}</strong> (${r.origen || '—'} → ${r.destino || '—'}) del ${fechaViaje} no pudo realizarse al no haberse presentado en el punto de recogida.<br><br>De acuerdo con nuestra política de reservas, el depósito de garantía de ${importe} € ha sido retenido por no-show.</p>
         </div>
         <div class="info-box">
           <strong>Ruta:</strong> ${r.origen || '—'} → ${r.destino || '—'}<br>
           <strong>Fecha del servicio:</strong> ${fechaViaje}<br>
           <strong>Reserva:</strong> <span class="pnr">${r.numero_reserva}</span>
         </div>
         <p>Si crees que ha habido un error, no dudes en contactarnos.<br><br>Un saludo cordial,<br><strong>El equipo de Traslados GC</strong></p>`
      )
    });
  } catch(e) { console.warn('Error enviando email no-show:', e.message); }

  // WhatsApp al cliente
  if (r.telefono_cliente) {
    try {
      const _pns2wa = await obtenerPlantilla('cliente_deposito_noshow', {
        nombre_cliente: r.nombre_cliente,
        numero_reserva: r.numero_reserva,
        origen: r.origen || '—',
        destino: r.destino || '—',
        fecha: fechaViaje,
        importe: importe
      });
      const textoWa = (_pns2wa && _pns2wa.whatsapp) || `Hola, ${r.nombre_cliente} 👋\n\nTu traslado ${r.numero_reserva} (${r.origen || '—'} → ${r.destino || '—'}) no pudo realizarse al no presentarse en el punto de recogida. El depósito de garantía ha sido retenido según nuestra política de reservas.\n\nSi crees que ha habido un error, contáctanos. Un saludo 🙏`;
      await pool.query(
        'INSERT INTO whatsapp_mensajes_pendientes (telefono, texto) VALUES ($1, $2)',
        [r.telefono_cliente, textoWa]
      );
    } catch(e) { console.warn('Error encolando WhatsApp no-show:', e.message); }
  }

  res.json({ ok: true });
}));

// ─── Admin: imágenes de WhatsApp ─────────────────────────────────────────────
// Devuelve los tipos que ya tienen imagen guardada
app.get('/admin/whatsapp-imagenes', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT tipo, tipo_mime, actualizado_en FROM whatsapp_imagenes ORDER BY tipo');
  res.json({ imagenes: result.rows });
}));

// Sube o actualiza la imagen de un tipo concreto (valoracion, factura, cartel)
app.post('/admin/whatsapp-imagenes/:tipo', requireAdmin, asyncHandler(async (req, res) => {
  const tipo = req.params.tipo;
  const tiposPermitidos = ['valoracion'];
  if (!tiposPermitidos.includes(tipo)) return res.status(400).json({ error: 'Tipo no válido.' });
  const { imagen } = req.body;
  if (!imagen || !imagen.startsWith('data:image/')) return res.status(400).json({ error: 'Imagen no válida.' });
  if (imagen.length > 4000000) return res.status(400).json({ error: 'La imagen pesa demasiado (máx. ~3MB).' });
  const [header, base64] = imagen.split(',');
  const tipoMime = header.match(/data:([^;]+)/)[1];
  const buffer = Buffer.from(base64, 'base64');
  await pool.query(
    `INSERT INTO whatsapp_imagenes (tipo, imagen, tipo_mime, actualizado_en)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (tipo) DO UPDATE SET imagen = $2, tipo_mime = $3, actualizado_en = NOW()`,
    [tipo, buffer, tipoMime]
  );
  res.json({ ok: true });
}));

// Sirve la imagen pública para og:image
app.get('/foto-chofer/:slug', asyncHandler(async (req, res) => {
  const result = await pool.query(
    "SELECT foto, foto_estado FROM conductores WHERE id = $1",
    [req.params.slug.split('-').pop()]
  );
  if (!result.rows.length || !result.rows[0].foto || result.rows[0].foto_estado !== 'aprobada') {
    return res.status(404).send('Foto no disponible.');
  }
  const foto = result.rows[0].foto;
  const match = foto.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!match) return res.status(400).send('Formato no válido.');
  const buffer = Buffer.from(match[2], 'base64');
  res.set('Content-Type', match[1]);
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(buffer);
}));

app.get('/og-imagen/:tipo', asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT imagen, tipo_mime FROM whatsapp_imagenes WHERE tipo = $1',
    [req.params.tipo]
  );
  if (!result.rows.length) return res.status(404).send('Imagen no disponible.');
  res.set('Content-Type', result.rows[0].tipo_mime);
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(result.rows[0].imagen);
}));



app.get('/admin/contacto-info', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT * FROM configuracion_contacto WHERE id = 1');
  res.json(result.rows[0] || {});
}));

app.post('/admin/contacto', requireAdmin, asyncHandler(async (req, res) => {
  const { nombre_empresa, telefono, whatsapp, email, direccion, horario, emails_notificacion } = req.body;
  await pool.query(
    `UPDATE configuracion_contacto SET nombre_empresa=$1, telefono=$2, whatsapp=$3, email=$4, direccion=$5, horario=$6, emails_notificacion=$7, actualizado_en=NOW() WHERE id=1`,
    [nombre_empresa||'', telefono||'', whatsapp||'', email||'', direccion||'', horario||'', emails_notificacion||'']
  );
  res.json({ ok: true });
}));

// ─── Helper: generar factura PDF ────────────────────────────────────────────
async function generarFacturaPDF(reservaId) {
  const reservaQ = await pool.query(
    `SELECT r.*, cv.nombre AS categoria_nombre
     FROM reservas r
     LEFT JOIN categorias_vehiculos cv ON cv.id = r.categoria_id
     WHERE r.id = $1`, [reservaId]
  );
  if (!reservaQ.rows.length) return null;
  const r = reservaQ.rows[0];

  const extrasQ = await pool.query(
    `SELECT e.nombre, re.precio_en_reserva FROM reservas_extras re
     JOIN extras e ON e.id = re.extra_id WHERE re.reserva_id = $1`, [reservaId]
  );
  const extras = extrasQ.rows;

  const cfgQ = await pool.query('SELECT * FROM configuracion_facturacion WHERE id = 1');
  const cfg = cfgQ.rows[0] || {};

  const facturaExistente = await pool.query(
    'SELECT id, numero_factura FROM facturas WHERE reserva_id = $1 ORDER BY generada_en ASC LIMIT 1', [reservaId]
  );

  // Conceptos extra añadidos manualmente desde el admin
  let conceptosExtra = [];
  if (facturaExistente.rows.length) {
    const ceQ = await pool.query(
      'SELECT id, descripcion, importe FROM factura_conceptos_extra WHERE factura_id = $1 ORDER BY creado_en ASC',
      [facturaExistente.rows[0].id]
    );
    conceptosExtra = ceQ.rows;
  }

  const totalExtras = extras.reduce((s, e) => s + parseFloat(e.precio_en_reserva), 0);
  const totalConceptosExtra = conceptosExtra.reduce((s, c) => s + parseFloat(c.importe), 0);
  const totalFactura = (parseFloat(r.precio_estimado) || 0) + totalExtras + totalConceptosExtra;

  let numeroFactura;
  if (facturaExistente.rows.length) {
    numeroFactura = facturaExistente.rows[0].numero_factura;
  } else {
    await pool.query('UPDATE configuracion_facturacion SET contador_facturas = contador_facturas + 1 WHERE id = 1');
    const cntQ = await pool.query('SELECT contador_facturas FROM configuracion_facturacion WHERE id = 1');
    const num = cntQ.rows[0].contador_facturas;
    const anio = new Date().getFullYear();
    numeroFactura = 'TGC-' + anio + '-' + String(num).padStart(4, '0');
    await pool.query(
      'INSERT INTO facturas (reserva_id, numero_factura, importe_total) VALUES ($1, $2, $3)',
      [reservaId, numeroFactura, totalFactura]
    );
  }

  const fechaViaje = r.fecha ? new Date(r.fecha).toLocaleDateString('es-ES', {day:'numeric', month:'long', year:'numeric'}) : '—';
  const fechaFactura = new Date().toLocaleDateString('es-ES', {day:'numeric', month:'long', year:'numeric'});

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'portrait', margin: 50 });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), numeroFactura, numero_reserva: r.numero_reserva }));
    doc.on('error', reject);

    const W = doc.page.width - 100;
    let y = 50;

    const linea = (texto, negrita, tam, color) => {
      if (!texto) return;
      tam = tam || 11; color = color || '#1C1815';
      doc.fontSize(tam).font(negrita ? 'Helvetica-Bold' : 'Helvetica').fillColor(color).text(texto, 50, y, { width: W });
      y += tam + 5;
    };

    const lineaDoble = (label, valor) => {
      const yAntes = doc.y;
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#1C1815').text(label + ': ', 50, y, { continued: true, width: W });
      doc.font('Helvetica').fillColor('#333333').text(valor || '—', { width: W });
      y = doc.y + 4;
    };

    const separador = () => {
      y += 6;
      doc.moveTo(50, y).lineTo(50 + W, y).strokeColor('#AAAAAA').lineWidth(0.5).stroke();
      y += 10;
    };

    // Cabecera empresa
    doc.fontSize(18).font('Helvetica-Bold').fillColor('#1C1815').text(cfg.razon_social || 'Traslados GC', 50, y, { width: W }); y += 24;
    if (cfg.nif) linea('NIF: ' + cfg.nif, false, 10, '#555555');
    if (cfg.direccion) linea(cfg.direccion, false, 10, '#555555');
    if (cfg.codigo_postal || cfg.ciudad) linea([cfg.codigo_postal, cfg.ciudad].filter(Boolean).join(' '), false, 10, '#555555');
    if (cfg.email) linea(cfg.email, false, 10, '#555555');
    if (cfg.telefono) linea(cfg.telefono, false, 10, '#555555');
    separador();

    // Título factura
    y += 6;
    doc.fontSize(20).font('Helvetica-Bold').fillColor('#C1502E').text('FACTURA', 50, y, { align: 'center', width: W }); y += 30;
    separador();

    // Datos factura
    lineaDoble('Nº Factura', numeroFactura);
    lineaDoble('Fecha', fechaFactura);
    separador();

    // Datos cliente
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#555555').text('DATOS DEL CLIENTE', 50, y, { width: W }); y += 18;
    lineaDoble('Nombre', r.nombre_cliente);
    lineaDoble('Email', r.email_cliente);
    lineaDoble('Teléfono', r.telefono_cliente);
    separador();

    // Detalle servicio
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#555555').text('DETALLE DEL SERVICIO', 50, y, { width: W }); y += 18;
    lineaDoble('PNR / Nº Reserva', r.numero_reserva);
    lineaDoble('Ruta', (r.origen || '—') + ' → ' + (r.destino || '—'));
    lineaDoble('Fecha del traslado', fechaViaje);
    lineaDoble('Hora', r.hora ? r.hora.slice(0,5) : '—');
    lineaDoble('Pasajeros', String(r.num_pasajeros || '—'));
    lineaDoble('Categoría', r.categoria_nombre || '—');
    if (r.numero_vuelo) lineaDoble('Vuelo', r.numero_vuelo);
    if (r.nombre_barco) lineaDoble('Barco', r.nombre_barco);
    separador();

    // Importes
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#555555').text('IMPORTES', 50, y, { width: W }); y += 18;
    doc.fontSize(11).font('Helvetica').fillColor('#1C1815').text('Traslado (' + (r.categoria_nombre || '—') + ')', 50, y, { continued: true, width: W });
    doc.font('Helvetica-Bold').text('    ' + (parseFloat(r.precio_estimado) || 0).toFixed(2) + ' €'); y += 16;
    extras.forEach(function(e) {
      doc.fontSize(11).font('Helvetica').fillColor('#1C1815').text('Extra: ' + e.nombre, 50, y, { continued: true, width: W });
      doc.font('Helvetica-Bold').text('    ' + parseFloat(e.precio_en_reserva).toFixed(2) + ' €'); y += 16;
    });
    conceptosExtra.forEach(function(c) {
      doc.fontSize(11).font('Helvetica').fillColor('#1C1815').text(c.descripcion, 50, y, { continued: true, width: W });
      doc.font('Helvetica-Bold').text('    ' + parseFloat(c.importe).toFixed(2) + ' €'); y += 16;
    });
    separador();

    // Total
    doc.fontSize(14).font('Helvetica-Bold').fillColor('#1C1815').text('TOTAL: ', 50, y, { continued: true, width: W });
    doc.fillColor('#C1502E').text(totalFactura.toFixed(2) + ' €'); y += 25;
    separador();

    linea('Gracias por viajar con nosotros.', false, 10, '#555555');

    doc.end();
  });
}

// ─── Admin: conceptos extra de factura ───────────────────────────────────────
async function recalcularTotalFactura(facturaId) {
  const f = await pool.query('SELECT reserva_id FROM facturas WHERE id = $1', [facturaId]);
  if (!f.rows.length) return;
  const reservaId = f.rows[0].reserva_id;
  const r = await pool.query('SELECT precio_estimado FROM reservas WHERE id = $1', [reservaId]);
  const base = parseFloat(r.rows[0]?.precio_estimado || 0);
  const extrasR = await pool.query(
    'SELECT COALESCE(SUM(precio_en_reserva),0) AS total FROM reservas_extras WHERE reserva_id = $1', [reservaId]
  );
  const totalExtras = parseFloat(extrasR.rows[0].total);
  const conceptosR = await pool.query(
    'SELECT COALESCE(SUM(importe),0) AS total FROM factura_conceptos_extra WHERE factura_id = $1', [facturaId]
  );
  const totalConceptos = parseFloat(conceptosR.rows[0].total);
  const total = base + totalExtras + totalConceptos;
  await pool.query('UPDATE facturas SET importe_total = $1 WHERE id = $2', [total, facturaId]);
}

app.post('/admin/facturas/:id/conceptos-extra', requireAdmin, asyncHandler(async (req, res) => {
  const { descripcion, importe } = req.body;
  if (!descripcion || !descripcion.trim()) return res.status(400).json({ error: 'La descripción es obligatoria.' });
  const imp = parseFloat(importe);
  if (isNaN(imp) || imp <= 0) return res.status(400).json({ error: 'El importe no es válido.' });
  await pool.query(
    'INSERT INTO factura_conceptos_extra (factura_id, descripcion, importe) VALUES ($1, $2, $3)',
    [req.params.id, descripcion.trim(), imp]
  );
  await recalcularTotalFactura(req.params.id);
  res.json({ ok: true });
}));

app.delete('/admin/facturas/conceptos-extra/:id', requireAdmin, asyncHandler(async (req, res) => {
  const ceQ = await pool.query('SELECT factura_id FROM factura_conceptos_extra WHERE id = $1', [req.params.id]);
  await pool.query('DELETE FROM factura_conceptos_extra WHERE id = $1', [req.params.id]);
  if (ceQ.rows.length) await recalcularTotalFactura(ceQ.rows[0].factura_id);
  res.json({ ok: true });
}));

app.get('/admin/facturas/:id/conceptos-extra', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT id, descripcion, importe FROM factura_conceptos_extra WHERE factura_id = $1 ORDER BY creado_en ASC',
    [req.params.id]
  );
  res.json({ conceptos: result.rows });
}));

// ─── Admin: configuración de facturación ─────────────────────────────────────
app.get('/admin/facturacion', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT * FROM configuracion_facturacion WHERE id = 1');
  res.json({ facturacion: result.rows[0] || {} });
}));

app.post('/admin/facturacion', requireAdmin, asyncHandler(async (req, res) => {
  const { razon_social, nif, direccion, codigo_postal, ciudad, email, telefono } = req.body;
  await pool.query(
    `UPDATE configuracion_facturacion SET
      razon_social=$1, nif=$2, direccion=$3, codigo_postal=$4,
      ciudad=$5, email=$6, telefono=$7, actualizado_en=NOW()
     WHERE id=1`,
    [razon_social||'', nif||'', direccion||'', codigo_postal||'', ciudad||'', email||'', telefono||'']
  );
  res.json({ ok: true });
}));

// ─── Admin: listar facturas emitidas ─────────────────────────────────────────
app.get('/admin/facturas', requireAdmin, asyncHandler(async (req, res) => {
  const pnr = req.query.pnr ? req.query.pnr.trim() : null;
  let query = `
    SELECT f.id, f.numero_factura, f.importe_total, f.generada_en,
           f.reserva_id, r.numero_reserva, r.nombre_cliente, r.email_cliente
    FROM facturas f
    JOIN reservas r ON r.id = f.reserva_id
    WHERE r.estado != 'cancelada'
  `;
  const params = [];
  if (pnr) {
    params.push('%' + pnr + '%');
    query += ' AND r.numero_reserva ILIKE $1';
  }
  query += ' ORDER BY f.generada_en DESC';
  const result = await pool.query(query, params);
  res.json({ facturas: result.rows });
}));

// ─── Admin: enviar factura por id de factura ──────────────────────────────────
app.post('/admin/facturas/:id/enviar', requireAdmin, asyncHandler(async (req, res) => {
  const facturaQ = await pool.query('SELECT * FROM facturas WHERE id = $1', [req.params.id]);
  if (!facturaQ.rows.length) return res.status(404).json({ error: 'Factura no encontrada.' });
  const factura = facturaQ.rows[0];
  const emailDestino = req.body.email || null;

  const reservaQ = await pool.query('SELECT * FROM reservas WHERE id = $1', [factura.reserva_id]);
  if (!reservaQ.rows.length) return res.status(404).json({ error: 'Reserva no encontrada.' });
  const r = reservaQ.rows[0];
  const emailFinal = emailDestino || r.email_cliente;
  if (!emailFinal) return res.status(400).json({ error: 'No hay email de destino.' });

  const resultado = await generarFacturaPDF(factura.reserva_id);
  if (!resultado) return res.status(500).json({ error: 'Error generando la factura.' });

  const _pf = await obtenerPlantilla('cliente_factura', {
    nombre_cliente: r.nombre_cliente,
    numero_reserva: r.numero_reserva,
    numero_factura: factura.numero_factura
  });
  await enviarEmailConAdjunto({
    to: emailFinal,
    subject: (_pf && _pf.asunto) || ('📄 Factura ' + factura.numero_factura + ' — Reserva ' + r.numero_reserva),
    html: plantillaEmail((_pf && _pf.email) || `<p>Hola <strong>${r.nombre_cliente}</strong>,</p><p>Adjuntamos la factura <strong>${factura.numero_factura}</strong> correspondiente a tu reserva <strong>${r.numero_reserva}</strong>.</p><p>Gracias por viajar con Traslados GC.</p>`),
    adjunto: { filename: 'factura-' + r.numero_reserva + '.pdf', content: resultado.buffer }
  });
  res.json({ ok: true });
}));

// ─── Admin: descargar factura de una reserva ──────────────────────────────────
app.get('/admin/reservas/:id/factura', requireAdmin, asyncHandler(async (req, res) => {
  const reservaQ = await pool.query('SELECT numero_reserva FROM reservas WHERE id = $1', [req.params.id]);
  if (!reservaQ.rows.length) return res.status(404).json({ error: 'Reserva no encontrada.' });
  const pnr = reservaQ.rows[0].numero_reserva;

  // Ver si ya existe factura generada
  const facturaQ = await pool.query('SELECT numero_factura FROM facturas WHERE reserva_id = $1 ORDER BY generada_en DESC LIMIT 1', [req.params.id]);

  const factPdfAdmin = await generarFacturaPDF(req.params.id);
  if (!factPdfAdmin) return res.status(500).json({ error: 'Error generando factura.' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="factura-' + pnr + '.pdf"');
  res.send(factPdfAdmin.buffer);
}));

// ─── Puente WhatsApp (OpenWA, en el PC de Germán) ──────────────────────────────
function requierePuenteWhatsapp(req, res, next) {
  const llave = req.headers['x-llave-puente'];
  if (!llave || llave !== process.env.LLAVE_PUENTE_WHATSAPP) {
    return res.status(401).json({ error: 'Llave incorrecta.' });
  }
  next();
}

// Endpoint para que puente.js pueda leer plantillas de comunicacion
app.get('/api/whatsapp/plantilla/:clave', requierePuenteWhatsapp, asyncHandler(async (req, res) => {
  const resultado = await obtenerPlantilla(req.params.clave, req.query);
  if (!resultado) return res.json({ ok: false });
  res.json({ ok: true, whatsapp: resultado.whatsapp });
}));

app.get('/api/whatsapp/mensajes-pendientes', requierePuenteWhatsapp, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT id, telefono, texto, url_documento, nombre_documento, documento_base64 FROM whatsapp_mensajes_pendientes WHERE enviado = FALSE ORDER BY creado_en ASC LIMIT 20'
  );
  res.json(result.rows);
}));

app.post('/api/whatsapp/mensajes-pendientes/:id/enviado', requierePuenteWhatsapp, asyncHandler(async (req, res) => {
  await pool.query('UPDATE whatsapp_mensajes_pendientes SET enviado = TRUE WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

app.get('/api/whatsapp/choferes-disponibles', requierePuenteWhatsapp, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT id, nombre, telefono FROM conductores
     WHERE estado = 'aprobado'
       AND disponible_hoy = TRUE
     ORDER BY nombre`
  );
  res.json(result.rows);
}));

app.get('/api/whatsapp/reservas-pendientes', requierePuenteWhatsapp, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT r.id, r.numero_reserva, r.fecha, r.hora, r.origen, r.destino,
            r.nombre_cliente, r.telefono_cliente,
            cv.nombre AS categoria_nombre
     FROM reservas r
     LEFT JOIN categorias_vehiculos cv ON cv.id = r.categoria_id
     WHERE r.estado_aviso_whatsapp = 'pendiente'
     ORDER BY r.id ASC`
  );
  res.json(result.rows);
}));

// Reservas que llevan 15 minutos o más avisadas a los choferes sin que nadie
// haya aceptado todavía. El puente las usa para avisar al cliente de que
// seguimos buscando chofer.
app.get('/api/whatsapp/reservas-15min-sin-respuesta', requierePuenteWhatsapp, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT r.id, r.numero_reserva, r.nombre_cliente, r.telefono_cliente, r.email_cliente
     FROM reservas r
     WHERE r.estado_aviso_whatsapp = 'enviado'
       AND r.whatsapp_aviso_enviado_en IS NOT NULL
       AND r.whatsapp_aviso_enviado_en <= NOW() - INTERVAL '15 minutes'
       AND r.estado NOT IN ('cancelada', 'completada', 'confirmada')
     ORDER BY r.id ASC`
  );
  res.json(result.rows);
}));

// Reservas que llevan 24 horas desde su creación sin que ningún chofer haya
// aceptado. El puente las usa para avisar al cliente de la cancelación.
app.get('/api/whatsapp/reservas-24h-sin-respuesta', requierePuenteWhatsapp, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT r.id, r.numero_reserva, r.nombre_cliente, r.telefono_cliente, r.email_cliente
     FROM reservas r
     WHERE r.estado_aviso_whatsapp IN ('enviado', 'sin_respuesta')
       AND r.creado_en <= NOW() - INTERVAL '24 hours'
       AND r.estado NOT IN ('cancelada', 'completada')
     ORDER BY r.id ASC`
  );
  res.json(result.rows);
}));

// El puente avisa que ya mandó el WhatsApp a los choferes de esta reserva,
// para que no se les vuelva a mandar si vuelve a preguntar.
app.post('/api/whatsapp/marcar-enviado/:id', requierePuenteWhatsapp, asyncHandler(async (req, res) => {
  await pool.query(
    `UPDATE reservas SET estado_aviso_whatsapp = 'enviado', whatsapp_aviso_enviado_en = NOW() WHERE id = $1`,
    [req.params.id]
  );
  res.json({ ok: true });
}));

// El puente ya avisó al cliente por WhatsApp de que seguimos buscando chofer
// (15 min sin respuesta). Aquí mandamos el email equivalente al cliente y
// avisamos también al admin por si quiere intervenir a mano.
app.post('/api/whatsapp/marcar-sin-respuesta/:id', requierePuenteWhatsapp, asyncHandler(async (req, res) => {
  const reserva = await pool.query(
    `UPDATE reservas SET estado_aviso_whatsapp = 'sin_respuesta'
     WHERE id = $1 AND estado_aviso_whatsapp = 'enviado'
     RETURNING numero_reserva, nombre_cliente, email_cliente`,
    [req.params.id]
  );
  if (!reserva.rows.length) return res.json({ ok: true, ya_marcada: true });

  const { numero_reserva, nombre_cliente, email_cliente } = reserva.rows[0];

  try {
    await enviarEmail({
      to: email_cliente,
      subject: 'Seguimos gestionando tu traslado — ' + numero_reserva,
      html: plantillaEmailSimple(
        nombre_cliente,
        'Seguimos gestionando tu solicitud de traslado. Aún no hemos podido confirmar chofer, pero continuamos buscando disponibilidad. Te avisaremos en cuanto tengamos una respuesta.',
        numero_reserva
      )
    });
  } catch (err) {
    console.warn('Error enviando email de "sin respuesta" al cliente:', err.message);
  }

  try {
    const destinatarios = await obtenerEmailsNotificacion();
    for (const em of destinatarios) {
      await enviarEmail({
        to: em,
        subject: 'Reserva ' + numero_reserva + ' sin respuesta de choferes (15 min)',
        html: '<p>La reserva <strong>' + numero_reserva + '</strong> lleva 15 minutos avisada a los choferes disponibles sin que nadie haya aceptado. Puede que quieras buscar chofer manualmente desde el panel de administración.</p>'
      });
    }
  } catch (err) {
    console.warn('Error enviando email de aviso al admin:', err.message);
  }

  res.json({ ok: true });
}));

// El puente ya avisó al cliente por WhatsApp de la cancelación (24h sin
// respuesta). Aquí cancelamos la reserva y mandamos el email equivalente.
app.post('/api/whatsapp/cancelar-sin-respuesta/:id', requierePuenteWhatsapp, asyncHandler(async (req, res) => {
  const reserva = await pool.query(
    `UPDATE reservas SET estado = 'cancelada', estado_aviso_whatsapp = 'cancelada_sin_respuesta'
     WHERE id = $1 AND estado NOT IN ('cancelada', 'completada')
     RETURNING numero_reserva, nombre_cliente, email_cliente`,
    [req.params.id]
  );
  if (!reserva.rows.length) return res.json({ ok: true, ya_cancelada: true });

  const { numero_reserva, nombre_cliente, email_cliente } = reserva.rows[0];

  try {
    await enviarEmail({
      to: email_cliente,
      subject: 'Tu reserva ' + numero_reserva + ' ha sido anulada',
      html: plantillaEmailSimple(
        nombre_cliente,
        'Lamentamos informarte que no hemos podido confirmar un chofer disponible para tu traslado en la fecha solicitada, por lo que hemos anulado la reserva. Puedes enviarnos una nueva solicitud más adelante; con gusto intentaremos ayudarte si tenemos disponibilidad.',
        numero_reserva
      )
    });
  } catch (err) {
    console.warn('Error enviando email de cancelación al cliente:', err.message);
  }

  res.json({ ok: true });
}));

// El puente avisa que un chofer respondió "SI": se asigna igual que si lo
// hiciera el admin a mano (mismo email, mismo enlace de pago, mismo comportamiento).
app.post('/api/whatsapp/asignar/:id', requierePuenteWhatsapp, asyncHandler(async (req, res) => {
  const { conductor_id } = req.body;
  if (!conductor_id) return res.status(400).json({ error: 'Falta conductor_id.' });

  await asignarChoferAReserva(req.params.id, conductor_id, 'Asignado automáticamente por WhatsApp');
  await pool.query(
    `UPDATE reservas SET estado_aviso_whatsapp = 'asignado' WHERE id = $1`,
    [req.params.id]
  );
  res.json({ ok: true });
}));

// ─── Plantillas de comunicación ───────────────────────────────────────────────

// GET: listar todas las plantillas
app.get('/admin/plantillas-comunicacion', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT id, clave, nombre, categoria, asunto_email, cuerpo_email, cuerpo_whatsapp, activa, actualizado_en FROM plantillas_comunicacion ORDER BY categoria, nombre'
  );
  res.json({ plantillas: result.rows });
}));

// GET: obtener una plantilla por clave
app.get('/admin/plantillas-comunicacion/:clave', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM plantillas_comunicacion WHERE clave = $1',
    [req.params.clave]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Plantilla no encontrada.' });
  res.json({ plantilla: result.rows[0] });
}));

// PUT: guardar cambios en una plantilla
app.put('/admin/plantillas-comunicacion/:clave', requireAdmin, asyncHandler(async (req, res) => {
  const { asunto_email, cuerpo_email, cuerpo_whatsapp, nombre } = req.body;
  const result = await pool.query(
    `UPDATE plantillas_comunicacion
     SET asunto_email = $1, cuerpo_email = $2, cuerpo_whatsapp = $3, nombre = $4, actualizado_en = NOW()
     WHERE clave = $5
     RETURNING *`,
    [asunto_email, cuerpo_email, cuerpo_whatsapp || null, nombre, req.params.clave]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Plantilla no encontrada.' });
  res.json({ ok: true, plantilla: result.rows[0] });
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
