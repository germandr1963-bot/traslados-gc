const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const ExcelJS = require('exceljs');

const app = express();
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
const IDIOMAS_PERMITIDOS = ['es', 'en', 'de', 'sv', 'no', 'nl', 'it', 'fr', 'fi'];

// Palabra "traslado" en cada idioma — forma parte de la URL pública
const SECCIONES_TRASLADO = {
  es: 'traslado',
  en: 'transfer',
  de: 'transfer',
  sv: 'transfer',
  no: 'transfer',
  nl: 'transfer',
  it: 'trasferimento',
  fr: 'transfert',
  fi: 'siirto'
};

// URL base del sitio — se usa para construir canonical y hreflang
const BASE_URL = process.env.BASE_URL || 'https://traslados-gc.onrender.com';

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
    'SELECT id, nombre, capacidad_pasajeros, capacidad_maletas, descripcion, limite_sillas FROM categorias_vehiculos WHERE disponible = TRUE ORDER BY orden, nombre'
  );
  res.json(result.rows);
}));

app.get('/api/rutas', asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT id, origen, destino FROM rutas WHERE activa = TRUE ORDER BY origen, destino'
  );
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
    sheet.addRow(row);
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
    } catch (err) {
      errores.push('Ruta ' + f.rutaId + '/' + f.langCode + ': ' + err.message);
    }
  }

  res.json({ ok: true, actualizadas, errores });
}));

// ─── Páginas públicas por ruta (SSR) ─────────────────────────────────────────
// URL: /:lang/traslado/:slug  (ej: /es/traslado/las-palmas-a-maspalomas)
// El parámetro :lang solo acepta los 9 idiomas permitidos.
// El parámetro :seccion debe coincidir con la palabra del idioma (traslado/transfer/etc.)
app.get('/:lang(es|en|de|sv|no|nl|it|fr|fi)/:seccion/:slug', asyncHandler(async (req, res) => {
  const { lang, seccion, slug } = req.params;

  // Verificar que la sección del URL corresponde al idioma
  if (seccion !== SECCIONES_TRASLADO[lang]) {
    return res.status(404).render('404', { mensaje: 'Página no encontrada' });
  }

  // Buscar la ficha SEO activa para este slug e idioma
  const seoResult = await pool.query(
    `SELECT rss.*, r.origen, r.destino, r.id AS ruta_id
     FROM route_seo_settings rss
     JOIN rutas r ON r.id = rss.route_id
     WHERE rss.lang_code = $1 AND rss.slug_url = $2 AND rss.activo = TRUE AND r.activa = TRUE`,
    [lang, slug]
  );

  if (seoResult.rows.length === 0) {
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

  res.render('traslado', {
    seo,
    precios: precios.rows,
    alternates: alternates.rows,
    lang,
    BASE_URL,
    SECCIONES_TRASLADO
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
