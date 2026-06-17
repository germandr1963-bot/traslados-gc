const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

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
  limits: { fileSize: 1024 * 1024 }
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

app.get('/api/categorias', asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT id, nombre, capacidad_pasajeros, capacidad_maletas FROM categorias_vehiculos WHERE activa = TRUE ORDER BY orden, nombre'
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

app.get('/admin/categorias', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT id, nombre, capacidad_pasajeros, capacidad_maletas, activa, orden FROM categorias_vehiculos ORDER BY orden, nombre'
  );
  res.json(result.rows);
}));

app.post('/admin/categorias', requireAdmin, asyncHandler(async (req, res) => {
  const { nombre, capacidad_pasajeros, capacidad_maletas } = req.body;
  if (!nombre) {
    return res.status(400).json({ error: 'Falta el nombre' });
  }
  const result = await pool.query(
    'INSERT INTO categorias_vehiculos (nombre, capacidad_pasajeros, capacidad_maletas) VALUES ($1, $2, $3) RETURNING id',
    [nombre, capacidad_pasajeros || 4, capacidad_maletas || 2]
  );
  res.json({ ok: true, id: result.rows[0].id });
}));

app.post('/admin/categorias/:id/estado', requireAdmin, asyncHandler(async (req, res) => {
  const { activa } = req.body;
  await pool.query('UPDATE categorias_vehiculos SET activa = $1 WHERE id = $2', [!!activa, req.params.id]);
  res.json({ ok: true });
}));

app.get('/admin/rutas', requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT id, origen, destino, activa FROM rutas ORDER BY origen, destino');
  res.json(result.rows);
}));

app.post('/admin/rutas', requireAdmin, asyncHandler(async (req, res) => {
  const { origen, destino } = req.body;
  if (!origen || !destino) {
    return res.status(400).json({ error: 'Falta origen o destino' });
  }
  const result = await pool.query(
    'INSERT INTO rutas (origen, destino) VALUES ($1, $2) RETURNING id',
    [origen, destino]
  );
  res.json({ ok: true, id: result.rows[0].id });
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
