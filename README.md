# Traslados GC

Servicio de traslados de larga distancia en Gran Canaria. Reserva bajo petición, con precio fijo por combinación de ruta y categoría de vehículo. No hay matching en tiempo real: toda reserva pasa por petición al chofer, aceptación y confirmación.

Este es el esqueleto inicial del proyecto. Repositorio separado del de Taxi Guanche / taxi-av: comparten el mismo tipo de tecnología pero no la misma base de datos ni la misma flota de choferes.

## Qué incluye esta primera versión

- Página pública de reserva (`public/index.html`): el cliente elige origen, destino y categoría de vehículo, y ve el precio fijo si la ruta está cargada (o "a consultar" si no lo está).
- Panel de administración (`public/admin.html`), con tres secciones:
  - **Fondos de portada**: subir hasta 5 imágenes de fondo para la página de inicio, marcar cuál está activa y dejar el resto en reserva.
  - **Categorías de vehículo**: alta y activación/desactivación de categorías.
  - **Rutas y precios**: alta de rutas y una tabla para fijar el precio de cada ruta por cada categoría.
- Página de choferes (`public/conductor.html`): de momento es solo un aviso de "en construcción" — el flujo de aceptación de viajes todavía no está diseñado.

## Lo que falta (a propósito, todavía no se ha decidido)

- Envío del viaje a los choferes (SMS) y lógica de aceptación.
- Coordinación por WhatsApp con el cliente.
- Cobro del cargo por no-show con Stripe.
- Opción de escribir un lugar que no esté en la lista de rutas.

## Variables de entorno necesarias en Render

| Variable | Para qué sirve |
|---|---|
| `DATABASE_URL` | Cadena de conexión de la base de datos de Neon (la de este proyecto, no la de taxi-av) |
| `SESSION_SECRET` | Cualquier texto largo y aleatorio, para proteger las sesiones de admin |
| `ADMIN_USUARIO` | Usuario del primer administrador (solo se usa la primera vez que arranca, si no hay ningún admin todavía) |
| `ADMIN_PASSWORD` | Contraseña de ese primer administrador |

## Cómo desplegar

1. Crea un proyecto nuevo en Neon y copia su cadena de conexión.
2. Crea un servicio Web nuevo en Render, conectado a este repositorio.
3. Comando de arranque: `npm start`.
4. Añade las 4 variables de entorno de la tabla de arriba.
5. Al arrancar por primera vez, el propio servidor crea las tablas que necesita y, si no existe ningún admin, crea uno con el usuario y contraseña indicados en las variables de entorno.
6. Entra en `/admin.html`, inicia sesión, y desde ahí carga las categorías, las rutas con sus precios, y un fondo de portada.

Recuerda desactivar la traducción automática de Chrome antes de entrar en Neon o en Render — rompe los botones interactivos de esas páginas.
