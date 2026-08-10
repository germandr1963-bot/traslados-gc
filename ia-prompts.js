'use strict';

// =============================================================================
// ia-prompts.js — Traslados GC
// Centralización de todos los prompts activos de IA.
// Cada generador es una función que recibe los datos variables y devuelve
// el texto del prompt exactamente igual a como estaba en server.js.
// Para mejorar un prompt, edítalo aquí. No tocar server.js para eso.
// =============================================================================


// ─── GENERADOR 1 ─────────────────────────────────────────────────────────────
// Alt text foto nueva — 1 idioma
// Endpoint: POST /admin/seo/destinos/:id/fotos/sugerir-ia
// Botón admin: ✨ Sugerir en ES con IA
// Línea original server.js: ~3785
function GENERADOR_ALT_NUEVO_ES(nombre, isla, lang, nombreIdioma) {
  return `Eres un experto en SEO de imágenes para webs de turismo y transporte.\nAnaliza esta imagen del destino "${nombre}" en ${isla} y devuelve dos cosas:\n\n1. nombre_archivo: Un nombre de archivo SEO optimizado en ${lang === 'es' ? 'español' : nombreIdioma}, en minúsculas, con guiones en lugar de espacios, sin tildes ni caracteres especiales, con extensión .webp. Debe describir lo que se ve en la imagen e incluir el nombre del destino. Ejemplo: "maspalomas-dunas-atardecer-gran-canaria.webp"\n\n2. alt_texto: Un texto alternativo descriptivo en ${lang === 'es' ? 'español' : nombreIdioma}. Describe con detalle lo que se ve en la imagen — paisaje, luz, elementos visuales — e incluye el destino y Gran Canaria. Debe tener entre 110 y 125 caracteres como máximo absoluto.\n\nResponde ÚNICAMENTE con JSON válido, sin markdown, con esta forma exacta:\n{"nombre_archivo": "...", "alt_texto": "..."}`;
}


// ─── GENERADOR 2 ─────────────────────────────────────────────────────────────
// Alt text foto nueva — todos los idiomas a la vez
// Endpoint: POST /admin/seo/destinos/:id/fotos/nueva/alt/generar-todos
// Botón admin: ✨ Generar todos los idiomas con IA
// Línea original server.js: ~3932
function GENERADOR_ALT_NUEVO_TODOS(nombre, isla, listaIdiomas, codigos) {
  return `Eres un experto en SEO de imagenes para webs de turismo y transporte. Trabajas para multiples mercados europeos.\nAnaliza esta imagen del destino "${nombre}" en ${isla} y escribe un alt text para cada uno de estos idiomas: ${listaIdiomas}.\n\nPara cada idioma:\n- Escribe de forma completamente nativa — como lo escribiria un SEO local de ese mercado, NO como una traduccion del espanol\n- Describe lo que se ve en la imagen de forma natural e incluye el nombre del destino\n- Describe con detalle lo que se ve — paisaje, luz, elementos visuales — e incluye el destino y Gran Canaria. Debe tener entre 110 y 125 caracteres como máximo absoluto\n- Maximo 125 caracteres\n\nResponde UNICAMENTE con JSON valido, sin markdown:\n{${codigos}}`;
}


// ─── GENERADOR 3 ─────────────────────────────────────────────────────────────
// Alt text foto existente — por idioma
// Endpoint: POST /admin/seo/destinos/:id/fotos/:fotoId/alt/:lang/sugerir-ia
// Botón admin: ✨ Sugerir con IA
// Línea original server.js: ~3999
function GENERADOR_ALT_EXISTENTE_LANG(nombre, isla, esBase, nombreIdioma) {
  return `Eres un experto en SEO de imágenes para webs de turismo y transporte. Trabajas en el mercado de habla ${esBase ? 'español' : nombreIdioma}.\nAnaliza esta imagen del destino "${nombre}" en ${isla} y escribe un alt text.\n\nEl alt text debe:\n- Estar escrito en ${esBase ? 'español' : nombreIdioma} de forma completamente nativa — como lo escribiría un SEO local de ese mercado, no como una traducción\n- Describir lo que se ve en la imagen de forma natural e incluir el nombre del destino\n- Describe con detalle lo que se ve — paisaje, luz, elementos visuales — e incluye el destino y Gran Canaria. Debe tener entre 110 y 125 caracteres como máximo absoluto\n- Máximo 125 caracteres\n\nResponde ÚNICAMENTE con JSON válido, sin markdown:\n{"alt_texto": "..."}`;
}


// ─── GENERADOR 4 ─────────────────────────────────────────────────────────────
// Contenido completo de destino — todo de una vez
// Endpoint: POST /admin/seo/destinos/:id/generar-todo
// Botón admin: 🤖 Generar todo con IA
// Línea original server.js: ~4231
function GENERADOR_DESTINO_TODO(nombre, isla, nombreIdioma, reglasSlug) {
  return `# INSTRUCCIONES GENERALES DE REDACCIÓN SEO LOCAL Y METADATOS MULTIIDIOMA\n\nActúa como un Experto en SEO Local y Redactor Creativo Nativo. Tu trabajo consiste en redactar metadatos y contenidos altamente persuasivos, escritos de "humano a humano", para una página de captación del destino "${nombre}" (${isla}, Islas Canarias) de una empresa de traslados y transportes privados intermunicipales.\n\nREGLA DE NATIVIDAD (NO TRADUCIR):\nNo traduzcas nunca literalmente desde otro idioma. Redacta de forma 100% nativa desde cero en ${nombreIdioma}, pensando en cómo busca, piensa y reserva un usuario real de ese idioma cuando planifica su viaje a "${nombre}".\n\n---\n\n## CONCEPTO Y OBJETIVO DE LA PÁGINA\nEsta página es una landing de atracción/captación. Su objetivo es inspirar al cliente a visitar "${nombre}" y presentar el servicio de traslado/transporte privado como la opción más cómoda, rápida y directa para llegar hasta allí (desde aeropuertos, hoteles u otros puntos).\n\n---\n\n## REGLAS DE ORO Y ESTILO (HUMAN-LIKE)\n\n1. ENFOQUE HACIA EL DESTINO:\nTodo el contenido (Título, Descripción, Tarjeta y Texto Principal) debe enfocar el viaje y transporte privado HACIA "${nombre}".\n\n2. LÍMITES ESTRICTOS DE CARACTERES (INFRANQUEABLES):\nLos límites indicados son MÁXIMOS ABSOLUTOS (incluyendo espacios, letras y signos de puntuación). Aproxímate lo máximo posible al rango sugerido para aprovechar el espacio SEO, pero NUNCA, bajo ninguna circunstancia, sobrepases el LÍMITE MÁXIMO en ${nombreIdioma}. Es preferible quedarse 3 o 4 caracteres por debajo antes que pasarse por 1 solo carácter.\n\nLímites de caracteres por idioma:\n- Español (ES): Título (52-58 chars | MÁX 60) | Descripción (145-152 chars | MÁX 155)\n- Inglés (EN): Título (54-60 chars | MÁX 62) | Descripción (150-157 chars | MÁX 160)\n- Alemán (DE): Título (48-53 chars | MÁX 55) | Descripción (130-137 chars | MÁX 140)\n- Francés (FR): Título (52-58 chars | MÁX 60) | Descripción (145-152 chars | MÁX 155)\n- Italiano (IT): Título (52-58 chars | MÁX 60) | Descripción (148-155 chars | MÁX 158)\n- Neerlandés (NL): Título (50-55 chars | MÁX 57) | Descripción (138-145 chars | MÁX 148)\n- Sueco (SV): Título (50-55 chars | MÁX 57) | Descripción (140-147 chars | MÁX 150)\n- Noruego (NO): Título (50-55 chars | MÁX 57) | Descripción (142-149 chars | MÁX 152)\n- Finlandés (FI): Título (46-52 chars | MÁX 54) | Descripción (128-135 chars | MÁX 138)\n- Ruso (RU): Título (42-48 chars | MÁX 50) | Descripción (118-125 chars | MÁX 128)\n\n3. ESTILO NATURAL Y PROHIBICIONES DE IA:\n- Prohibido usar palabras y clichés típicos de IA como: "oasis de", "un sinfín de", "sumérgete", "en conclusión", "en resumen", "tesoro escondido".\n- Usa un tono cercano, natural y conversacional (de persona local a viajero).\n- Alterna la longitud de las frases (cortas y directas con explicativas) para dar un ritmo de lectura 100% humano.\n\n### REGLAS OBLIGATORIAS SOBRE PRECIOS Y TARIFAS:\n1. PROHIBICIÓN ABSOLUTA (¡MUY IMPORTANTE!):\n   Está ESTRICTAMENTE PROHIBIDO usar las palabras o conceptos: "precio fijo", "tarifa fija", "precio cerrado" o cualquier frase que sugiera que el coste final no varía.\n2. CONCEPTOS Y ALTERNATIVAS PERMITIDAS:\n   "Precios ajustados", "tarifas competitivas", "precios económicos", "los mejores precios locales", "tarifas transparentes", "sin costes ocultos", "precio oficial".\n\n---\n\n## ESTRUCTURA DE LOS CONTENIDOS A GENERAR\n\n1. SLUG:\nURL amigable para este destino. ${reglasSlug} Solo letras minúsculas a-z y guiones. Sin números salvo que sean parte del nombre propio.\n\n2. PALABRA_DESTINO:\nLa palabra "destino" (lugar al que se viaja) traducida a ${nombreIdioma}, en caracteres latinos a-z y guiones únicamente. Sin tildes, sin caracteres especiales, sin cirílico. Solo la palabra.\n\n3. NOMBRE_ISLA:\nEl nombre de la isla "${isla}" traducido o transliterado a ${nombreIdioma} en caracteres latinos a-z y guiones únicamente.\n\n4. META_TITLE (campo: meta_title):\n- Usa el separador "|" para estructurar en 2 o 3 bloques visuales.\n- Formato habitual: [Traslado / Taxi Privado a ${nombre}] | [Propuesta de Valor] | [CTA o Garantía]\n\n5. META_DESCRIPTION (campo: meta_description):\n- Redactada como una solución persuasiva de transporte para el viajero.\n- Formato habitual: [Solución/Promesa de llegada a ${nombre}] + [Ventajas: tarifas competitivas, comodidad, sin colas] + [Llamada a la Acción corta].\n\n6. TEXTO INTRODUCTORIO PARA TARJETA DE DESTINO (campo: texto_tarjeta):\n- EXTENSIÓN: Entre 150 y 200 caracteres (MÁXIMO ABSOLUTO: 200 caracteres, incluidos espacios).\n- OBJETIVO: Pincelada corta y atractiva para la ficha previa del destino con botón hacia la página completa.\n- ESTRUCTURA (2 frases): [Frase 1: Atractivo principal de ${nombre}] + [Frase 2: Ventaja del traslado privado + CTA de clic].\n\n7. TEXTO PRINCIPAL DEL DESTINO (campo: texto_descripcion):\nEXTENSIÓN TOTAL OBLIGATORIA: Entre 400 y 550 palabras (LÍMITE MÁXIMO ABSOLUTO: 600 palabras).\nFORMATO: HTML válido. Usa <h2>, <h3>, <p>, <ul>, <li>, <strong>. NUNCA <h1>. NUNCA Markdown.\nESTRUCTURA:\n- <h2> Encabezado Principal: 1 frase potente.\n- <h2> Descubre ${nombre} + <p>: Máximo 1 párrafo (aprox. 60-80 palabras).\n- <h2> Qué ver y hacer en ${nombre} + <p> o <ul><li>: Máximo 2-3 bloques breves (aprox. 120-150 palabras).\n- <h2> La mejor forma de llegar a ${nombre} + <p>: Máximo 2 párrafos (aprox. 100-120 palabras).\n- <h2> Consejos del Local + <ul><li>: 2-3 tips breves (aprox. 60-80 palabras).\n- <h2> Reserva tu traslado + <p>: 1 párrafo final con CTA (aprox. 40-50 palabras).\n\n---\n\n## AUTOCONTROL DE CARACTERES\nAntes de entregar la respuesta, cuenta los caracteres exactos (incluidos espacios) del meta_title, meta_description y texto_tarjeta. Si superan por 1 solo carácter el límite máximo, reescríbelos.\n\n---\n\n## FORMATO DE SALIDA (OBLIGATORIO)\nResponde ÚNICAMENTE con JSON válido, sin markdown:\n{"slug": "...", "palabra_destino": "...", "nombre_isla": "...", "meta_title": "...", "meta_description": "...", "texto_tarjeta": "...", "texto_descripcion": "..."}`;
}


// ─── GENERADOR 5 ─────────────────────────────────────────────────────────────
// Contenido destinos pendientes — por lote
// Endpoint: POST /admin/seo/destinos/traducir-ia/:lang
// Botón admin: Generar lo que falte
// Línea original server.js: ~4438
function GENERADOR_DESTINO_LOTE(nombreIdioma, items) {
  return `Eres un experto en SEO de destinos turísticos. Tu tarea es escribir contenido SEO en ${nombreIdioma} para una web de traslados privados intermunicipales en Gran Canaria (Islas Canarias, España).\n\nEscribe como lo haría un profesional SEO nativo de ${nombreIdioma} — con el ritmo, las expresiones y las palabras clave que usa de verdad alguien de ese mercado cuando busca un traslado privado en Gran Canaria. No traduces. Creas desde cero.\n\nPara cada destino genera:\n- meta_title: Título para Google. Límites de caracteres por idioma (MÁXIMOS ABSOLUTOS, nunca superarlos):\n  Español (ES): MÁX 60 | Inglés (EN): MÁX 62 | Alemán (DE): MÁX 55 | Francés (FR): MÁX 60 | Italiano (IT): MÁX 60 | Neerlandés (NL): MÁX 57 | Sueco (SV): MÁX 57 | Noruego (NO): MÁX 57 | Finlandés (FI): MÁX 54 | Ruso (RU): MÁX 50\n  Usa términos de búsqueda reales de ese mercado. En idiomas con palabras largas (alemán, neerlandés, finés) usa menos palabras.\n- meta_description: Descripción para Google. Límites de caracteres por idioma (MÁXIMOS ABSOLUTOS, nunca superarlos):\n  Español (ES): MÁX 155 | Inglés (EN): MÁX 160 | Alemán (DE): MÁX 140 | Francés (FR): MÁX 155 | Italiano (IT): MÁX 158 | Neerlandés (NL): MÁX 148 | Sueco (SV): MÁX 150 | Noruego (NO): MÁX 152 | Finlandés (FI): MÁX 138 | Ruso (RU): MÁX 128\n  Invita al clic con tono natural de ese mercado. NUNCA superes el límite de tu idioma.\n- PROHIBICIÓN ABSOLUTA: Está ESTRICTAMENTE PROHIBIDO usar "precio fijo", "tarifa fija", "precio cerrado" o cualquier frase que sugiera que el coste final no varía. Alternativas permitidas: "tarifas competitivas", "sin costes ocultos", "precio oficial".\n- texto_descripcion: Exactamente 3 párrafos para la página pública del destino. Contenido:\n  Párrafo 1 — Describe el destino: qué se puede ver, qué hacer, gastronomía, ambiente, qué lo hace especial. Concreto y sensorial, nada genérico.\n  Párrafo 2 — Cómo llegar: menciona que se puede llegar desde cualquier punto de Gran Canaria con nuestro servicio de traslado privado. Cómodo, sin esperas, ideal con equipaje o en familia. Sin inventar tiempos ni precios.\n  Párrafo 3 — Invitación a reservar: cálida y directa. El precio depende del tipo de vehículo elegido, siempre asequible. Que reserves y nosotros nos encargamos del trayecto.\n  Sin listas. Solo párrafos fluidos. Sin frases hechas tipo "joya escondida" o "paraíso".\n\nDestinos (JSON con id, nombre, isla, zona):\n${JSON.stringify(items, null, 2)}\n\nResponde EXCLUSIVAMENTE con JSON válido, sin markdown, con esta estructura exacta donde la clave es el destino_id:\n{"1": {"meta_title": "...", "meta_description": "...", "texto_descripcion": "..."}, "2": {...}}`;
}


// ─── GENERADOR 6 ─────────────────────────────────────────────────────────────
// SEO de rutas — por idioma
// Función: traducirSEOConClaudeIA()
// Botón admin: Traducir con IA — pestaña SEO rutas
// Línea original server.js: ~4735
function GENERADOR_RUTAS_SEO(nombreIdioma, items) {
  return `# INSTRUCCIONES GENERALES DE REDACCIÓN SEO LOCAL Y METADATOS MULTIIDIOMA

Actúa como un Experto en SEO Local y Redactor Creativo Nativo. Tu trabajo consiste en redactar metadatos y contenidos altamente persuasivos, escritos de "humano a humano", para una página de captación de la ruta de transporte/traslado desde "${items[0].origen}" hasta "${items[0].destino}" (Gran Canaria, Islas Canarias) de una empresa de traslados y transportes privados intermunicipales.

REGLA DE NATIVIDAD (NO TRADUCIR):
No traduzcas nunca literalmente desde otro idioma. Redacta de forma 100% nativa desde cero en ${nombreIdioma}, pensando en cómo busca, piensa y reserva un usuario real de ese idioma cuando planifica su trayecto de "${items[0].origen}" a "${items[0].destino}".

---

## CONCEPTO Y OBJETIVO DE LA PÁGINA
Esta página es una landing de atracción/captación para la ruta específica entre dos puntos. Su objetivo es responder a la intención de búsqueda directa del usuario que necesita trasladarse desde "${items[0].origen}" hasta "${items[0].destino}" y presentar el servicio de traslado/transporte privado como la opción más cómoda, rápida, segura y directa para realizar este trayecto sin complicaciones.

---

## REGLAS DE ORO Y ESTILO (HUMAN-LIKE)

1. ENFOQUE HACIA LA RUTA:
Todo el contenido (Título, Descripción, Tarjeta y Texto Principal) debe enfocar el trayecto de transporte privado DESDE "${items[0].origen}" HASTA "${items[0].destino}".

2. LÍMITES ESTRICTOS DE CARACTERES (INFRANQUEABLES):
Los límites indicados son MÁXIMOS ABSOLUTOS (incluyendo espacios, letras y signos de puntuación). Aproxímate lo máximo posible al rango sugerido para aprovechar el espacio SEO, pero NUNCA, bajo ninguna circunstancia, sobrepases el LÍMITE MÁXIMO en ${nombreIdioma}. Es preferible quedarse 3 o 4 caracteres por debajo antes que pasarse por 1 solo carácter.

Límites de caracteres por idioma:
- Español (ES): Título (52-58 chars | MÁX 60) | Descripción (145-152 chars | MÁX 155)
- Inglés (EN): Título (54-60 chars | MÁX 62) | Descripción (150-157 chars | MÁX 160)
- Alemán (DE): Título (48-53 chars | MÁX 55) | Descripción (130-137 chars | MÁX 140)
- Francés (FR): Título (52-58 chars | MÁX 60) | Descripción (145-152 chars | MÁX 155)
- Italiano (IT): Título (52-58 chars | MÁX 60) | Descripción (148-155 chars | MÁX 158)
- Neerlandés (NL): Título (50-55 chars | MÁX 57) | Descripción (138-145 chars | MÁX 148)
- Sueco (SV): Título (50-55 chars | MÁX 57) | Descripción (140-147 chars | MÁX 150)
- Noruego (NO): Título (50-55 chars | MÁX 57) | Descripción (142-149 chars | MÁX 152)
- Finlandés (FI): Título (46-52 chars | MÁX 54) | Descripción (128-135 chars | MÁX 138)
- Ruso (RU): Título (42-48 chars | MÁX 50) | Descripción (118-125 chars | MÁX 128)

3. ESTILO NATURAL Y PROHIBICIONES DE IA:
- Prohibido usar palabras y clichés típicos de IA como: "oasis de", "un sinfín de", "sumérgete", "en conclusión", "en resumen", "tesoro escondido".
- Usa un tono cercano, natural y conversacional (de persona local a viajero).
- Alterna la longitud de las frases (cortas y directas con explicativas) para dar un ritmo de lectura 100% humano.

### REGLAS OBLIGATORIAS SOBRE PRECIOS Y TARIFAS:
1. PROHIBICIÓN ABSOLUTA (¡MUY IMPORTANTE!):
   Está ESTRICTAMENTE PROHIBIDO usar las palabras o conceptos: "precio fijo", "tarifa fija", "precio cerrado" o cualquier frase que sugiera que el coste final no varía.
2. CONCEPTOS Y ALTERNATIVAS PERMITIDAS:
   "Precios ajustados", "tarifas competitivas", "precios económicos", "los mejores precios locales", "tarifas transparentes", "sin costes ocultos", "precio oficial".

---

## ESTRUCTURA DE LOS CONTENIDOS A GENERAR

1. SLUG:
URL amigable para esta ruta (ejemplo tipico: origen-a-destino). ${items[0].reglasSlug} Solo letras minúsculas a-z y guiones. Sin números salvo que sean parte del nombre propio.

2. PALABRA_RUTA:
La palabra o expresión para "ruta" o "trayecto" (ejemplo: traslado, transferencia, taxi o ruta según aplique mejor al contexto) traducida a ${nombreIdioma}, en caracteres latinos a-z y guiones únicamente. Sin tildes, sin caracteres especiales, sin cirílico. Solo la palabra o expresión clave.

3. NOMBRE_ISLA:
El nombre de la isla "Gran Canaria" traducido o transliterado a ${nombreIdioma} en caracteres latinos a-z y guiones únicamente.

4. META_TITLE (campo: meta_title):
- Usa el separador "|" para estructurar en 2 o 3 bloques visuales.
- Formato habitual: [Traslado / Taxi de ${items[0].origen} a ${items[0].destino}] | [Propuesta de Valor] | [CTA o Garantía]

5. META_DESCRIPTION (campo: meta_description):
- Redactada como una solución directa de transporte para el viajero que necesita hacer este trayecto.
- Formato habitual: [Solución de traslado desde ${items[0].origen} a ${items[0].destino}] + [Ventajas: tiempo, comodidad, tarifas competitivas, sin esperas] + [Llamada a la Acción corta].

6. RESEÑA BREVE PARA TARJETA DE RUTA (campo: resena_breve):
- EXTENSIÓN: Entre 150 y 200 caracteres (MÁXIMO ABSOLUTO: 200 caracteres, incluidos espacios).
- OBJETIVO: Pincelada corta y atractiva para la ficha previa de la ruta con botón hacia la página completa.
- ESTRUCTURA (2 frases): [Frase 1: Solución de conexión rápida de ${items[0].origen} a ${items[0].destino}] + [Frase 2: Ventaja del traslado privado + CTA de clic].

7. TEXTO PRINCIPAL DE LA RUTA (campo: texto_descripcion):
EXTENSIÓN TOTAL OBLIGATORIA: Entre 400 y 550 palabras (LÍMITE MÁXIMO ABSOLUTO: 600 palabras).
FORMATO: HTML válido. Usa <h2>, <h3>, <p>, <ul>, <li>, <strong>. NUNCA <h1>. NUNCA Markdown.
ESTRUCTURA:
- <h2> Encabezado Principal: 1 frase potente enfocado en la ruta ${items[0].origen} a ${items[0].destino}.
- <h2> Traslado privado de ${items[0].origen} a ${items[0].destino} + <p>: Máximo 1 párrafo introduciendo el trayecto, distancia/comodidad (aprox. 60-80 palabras).
- <h2> Ventajas de este trayecto directo + <p> o <ul><li>: Máximo 2-3 puntos o bloques breves sobre por qué elegir transporte privado para ir de ${items[0].origen} a ${items[0].destino} frente a alternativas públicas (aprox. 120-150 palabras).
- <h2> Qué esperar de tu viaje entre ${items[0].origen} y ${items[0].destino} + <p>: Máximo 2 párrafos describiendo la experiencia a bordo, recogida puntual y llegada al punto exacto (aprox. 100-120 palabras).
- <h2> Consejos para tu ruta + <ul><li>: 2-3 tips breves para el viaje (duración estimada, equipaje, recomendaciones) (aprox. 60-80 palabras).
- <h2> Reserva tu traslado de ${items[0].origen} a ${items[0].destino} + <p>: 1 párrafo final con CTA (aprox. 40-50 palabras).

---

## AUTOCONTROL DE CARACTERES
Antes de entregar la respuesta, cuenta los caracteres exactos (incluidos espacios) del meta_title, meta_description y resena_breve. Si superan por 1 solo carácter el límite máximo, reescríbelos.

---

## FORMATO DE SALIDA (OBLIGATORIO)
Responde ÚNICAMENTE con JSON válido, sin markdown:
{"slug": "...", "palabra_ruta": "...", "nombre_isla": "...", "meta_title": "...", "meta_description": "...", "resena_breve": "...", "texto_descripcion": "..."}`;
}


// ─── GENERADOR 7 ─────────────────────────────────────────────────────────────
// Textos de interfaz — por idioma
// Función: traducirConClaudeIA()
// Botón admin: Traducir con IA — pestaña Idiomas
// Línea original server.js: ~4691
function GENERADOR_INTERFAZ_TEXTOS(nombreIdioma, items) {
  return 'Traduce los siguientes textos de una web de traslados privados en Gran Canaria, ' +
    'del español al ' + nombreIdioma + '. Cada texto incluye una clave única y un contexto que explica ' +
    'dónde aparece en la web — úsalo para elegir la traducción más natural (por ejemplo, un botón necesita ' +
    'un tono distinto a un párrafo explicativo). Mantén un tono profesional pero cercano.\n' +
    '- Traduce TODOS los textos sin excepción, incluidos nombres de categorías como "Business", "Económico", "Confort", "Premium" — tradúcelos a su equivalente natural en ' + nombreIdioma + '.\n\n' +
    'Textos a traducir (JSON):\n' + JSON.stringify(items, null, 2) + '\n\n' +
    'Responde EXCLUSIVAMENTE con un objeto JSON válido, sin texto adicional antes ni después, ' +
    'sin bloques de markdown ni comillas triples, con esta forma exacta: ' +
    '{"clave1": "traducción1", "clave2": "traducción2"}';
}


// ─── GENERADOR 8 ─────────────────────────────────────────────────────────────
// Nombres de destinos — por idioma
// Endpoint: POST /admin/destinos/traducciones/sugerir-ia/:lang
// Botón admin: ✨ Sugerir con IA los que faltan
// Línea original server.js: ~6770
function GENERADOR_NOMBRES_DESTINOS(nombreIdioma, pendientes) {
  return 'Traduce los siguientes nombres de lugares turísticos de Gran Canaria del español al ' + nombreIdioma + '.\n' +
    'Usa la forma más natural y reconocida en ese idioma (ej: "Aeropuerto de Gran Canaria" → "Gran Canaria Airport" en inglés).\n' +
    'Si el nombre no tiene traducción establecida, devuélvelo igual en español.\n\n' +
    'Lugares a traducir (JSON con id y nombre en español):\n' + JSON.stringify(pendientes) + '\n\n' +
    'Responde EXCLUSIVAMENTE con un JSON válido, sin texto adicional, sin markdown, con esta forma exacta:\n' +
    '[{"id": 1, "nombre": "..."}, {"id": 2, "nombre": "..."}]';
}


// ─── GENERADOR 9 ─────────────────────────────────────────────────────────────
// Alt text foto nueva de ruta — 1 idioma
// Endpoint: POST /admin/seo/rutas/:id/fotos/sugerir-ia
// Botón admin: ✨ Sugerir en ES con IA
function GENERADOR_ALT_FOTO_RUTA(origen, destino, lang, nombreIdioma) {
  return `Eres un experto en SEO de imágenes para webs de turismo y transporte.\nAnaliza esta imagen relacionada con la ruta de traslado privado de "${origen}" a "${destino}" en Gran Canaria y devuelve dos cosas:\n\n1. nombre_archivo: Un nombre de archivo SEO optimizado en ${lang === 'es' ? 'español' : nombreIdioma}, en minúsculas, con guiones en lugar de espacios, sin tildes ni caracteres especiales, con extensión .webp. Debe describir lo que se ve en la imagen e incluir origen y destino. Ejemplo: "las-palmas-gran-canaria-maspalomas-traslado-privado.webp"\n\n2. alt_texto: Un texto alternativo descriptivo en ${lang === 'es' ? 'español' : nombreIdioma}. Describe con detalle lo que se ve en la imagen — paisaje, luz, elementos visuales — y vincúlalo al traslado privado de "${origen}" a "${destino}". Debe tener entre 110 y 125 caracteres como máximo absoluto.\n\nResponde ÚNICAMENTE con JSON válido, sin markdown, con esta forma exacta:\n{"nombre_archivo": "...", "alt_texto": "..."}`;
}


// ─── GENERADOR 10 ────────────────────────────────────────────────────────────
// Alt text foto nueva de ruta — todos los idiomas a la vez
// Endpoint: POST /admin/seo/rutas/:id/fotos/nueva/alt/generar-todos
// Botón admin: ✨ Generar todos los idiomas con IA
function GENERADOR_ALT_FOTO_RUTA_TODOS(origen, destino, listaIdiomas, codigos) {
  return 'Eres un experto en SEO de imagenes para webs de turismo y transporte. Trabajas para multiples mercados europeos.\n' +
    'Analiza esta imagen relacionada con la ruta de traslado privado de "' + origen + '" a "' + destino + '" en Gran Canaria y escribe un alt text para cada uno de estos idiomas: ' + listaIdiomas + '.\n\n' +
    'Para cada idioma:\n' +
    '- Escribe de forma completamente nativa — como lo escribiria un SEO local de ese mercado, NO como una traduccion del espanol\n' +
    '- Describe lo que se ve en la imagen de forma natural y vinculalo al traslado de "' + origen + '" a "' + destino + '"\n' +
    '- Describe con detalle lo que se ve — paisaje, luz, elementos visuales — e incluye la ruta y Gran Canaria. Debe tener entre 110 y 125 caracteres como maximo absoluto\n' +
    '- Maximo 125 caracteres\n\n' +
    'Responde UNICAMENTE con JSON valido, sin markdown:\n' +
    '{' + codigos + '}';
}


// ─── GENERADOR 11 ────────────────────────────────────────────────────────────
// Alt text foto existente de ruta — por idioma
// Endpoint: POST /admin/seo/rutas/:id/fotos/:fotoId/alt/:lang/sugerir-ia
// Botón admin: ✨ Sugerir con IA
// Línea original server.js: ~4261
function GENERADOR_ALT_EXISTENTE_RUTA(origen, destino, esBase, nombreIdioma) {
  return 'Eres un experto en SEO de imagenes para webs de turismo y transporte. Trabajas en el mercado de habla ' + (esBase ? 'español' : nombreIdioma) + '.\n' +
    'Analiza esta imagen de la ruta de traslado privado de "' + origen + '" a "' + destino + '" en Gran Canaria y escribe un alt text.\n\n' +
    'El alt text debe:\n' +
    '- Estar escrito en ' + (esBase ? 'español' : nombreIdioma) + ' de forma completamente nativa — como lo escribiría un SEO local de ese mercado, no como una traducción\n' +
    '- Describir lo que se ve en la imagen de forma natural y vincularlo al traslado de "' + origen + '" a "' + destino + '"\n' +
    '- Describir con detalle lo que se ve — paisaje, luz, elementos visuales — e incluir la ruta y Gran Canaria. Debe tener entre 110 y 125 caracteres como máximo absoluto\n' +
    '- Máximo 125 caracteres\n\n' +
    'Responde ÚNICAMENTE con JSON válido, sin markdown:\n' +
    '{"alt_texto": "..."}';
}


// =============================================================================
module.exports = {
  GENERADOR_ALT_NUEVO_ES,
  GENERADOR_ALT_NUEVO_TODOS,
  GENERADOR_ALT_EXISTENTE_LANG,
  GENERADOR_DESTINO_TODO,
  GENERADOR_DESTINO_LOTE,
  GENERADOR_RUTAS_SEO,
  GENERADOR_INTERFAZ_TEXTOS,
  GENERADOR_NOMBRES_DESTINOS,
  GENERADOR_ALT_FOTO_RUTA,
  GENERADOR_ALT_FOTO_RUTA_TODOS,
  GENERADOR_ALT_EXISTENTE_RUTA
};
