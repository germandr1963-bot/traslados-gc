// (17/11/2026) N86 — Ventana de los textos legales.
// Los enlaces legales de la web (pie, casilla de la reserva, información de datos, «Solicitar precio»,
// Alta choferes, portal…) llevan data-legal="aviso-legal | privacidad | cookies | condiciones".
// Al pulsarlos, el texto se abre en una ventana encima de la página: el cliente no sale de donde está
// ni pierde lo escrito. (18/11/2026) Los del pie de página abren su página normal, salvo en la página de Reserva,
// donde, con los 3 pasos en pantalla, también «Contacto» se abre en esta ventana (data-legal="contacto"). Si algo falla, el enlace funciona como siempre (abre la página legal).
// Los textos salen de Idiomas → Textos de interfaz → «Páginas legales»; el botón, de «Cerrar» (home_modal_cerrar).
(function () {
  var CSS =
    '#legal-ventana{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:100000;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;}' +
    '#legal-ventana .lv-caja{background:#fff;border-radius:12px;width:100%;max-width:720px;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,0.3);font-family:"Public Sans",sans-serif;color:var(--texto-oscuro,#2A211B);}' +
    '#legal-ventana .lv-cabecera{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:18px 22px 10px;border-bottom:1px solid var(--gris-borde,#E1DCD0);}' +
    '#legal-ventana .lv-titulo{font-family:"Big Shoulders Display",sans-serif;font-size:26px;font-weight:bold;margin:0;line-height:1.2;}' +
    '#legal-ventana .lv-x{background:none;border:none;font-size:1.5rem;cursor:pointer;color:#888;padding:0 4px;line-height:1;}' +
    '#legal-ventana .lv-cuerpo{overflow-y:auto;padding:14px 22px 6px;-webkit-overflow-scrolling:touch;}' +
    '#legal-ventana .lv-aviso{color:var(--texto-muted,#5b5347);font-style:italic;font-size:15px;margin:0 0 14px;}' +
    '#legal-ventana .lv-texto{text-align:left;font-size:15px;line-height:1.75;}' +
    '#legal-ventana .lv-texto p{margin:0 0 14px;}' +
    '#legal-ventana .lv-texto h2{font-family:"Big Shoulders Display",sans-serif;font-size:22px;font-weight:bold;margin:22px 0 8px;}' +
    '#legal-ventana .lv-texto h3{font-family:"Big Shoulders Display",sans-serif;font-size:19px;font-weight:bold;margin:18px 0 6px;}' +
    '#legal-ventana .lv-texto ul,#legal-ventana .lv-texto ol{padding-left:20px;margin:0 0 14px;}' +
    '#legal-ventana .lv-texto li{margin-bottom:6px;}' +
    '#legal-ventana .lv-texto a{color:var(--terracota,#C1502E);font-weight:600;text-decoration:none;}' +
    '#legal-ventana .lv-pie{padding:12px 22px 18px;border-top:1px solid var(--gris-borde,#E1DCD0);}' +
    '#legal-ventana .lv-cerrar{width:100%;background:#f5f0ea;border:1px solid #ddd;border-radius:6px;cursor:pointer;font-size:0.95rem;padding:0.7rem;color:var(--texto-oscuro,#2A211B);font-family:inherit;}' +
    '@media (max-width:600px){#legal-ventana{padding:0;align-items:flex-end;}#legal-ventana .lv-caja{max-height:92vh;border-radius:12px 12px 0 0;}#legal-ventana .lv-titulo{font-size:22px;}}';

  var abierta = null, scrollAntes = '';

  function cerrar() {
    if (!abierta) return;
    abierta.parentNode.removeChild(abierta);
    abierta = null;
    document.body.style.overflow = scrollAntes;
    document.removeEventListener('keydown', teclaEsc);
  }
  function teclaEsc(e) { if (e.key === 'Escape') cerrar(); }

  function mostrar(d) {
    if (!document.getElementById('legal-ventana-css')) {
      var st = document.createElement('style');
      st.id = 'legal-ventana-css';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    cerrar();
    var v = document.createElement('div');
    v.id = 'legal-ventana';
    v.setAttribute('role', 'dialog');
    v.setAttribute('aria-modal', 'true');
    var caja = document.createElement('div');
    caja.className = 'lv-caja';
    var cab = document.createElement('div');
    cab.className = 'lv-cabecera';
    var h = document.createElement('h2');
    h.className = 'lv-titulo';
    h.textContent = d.titulo || '';
    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'lv-x';
    x.setAttribute('aria-label', d.cerrar || '');
    x.textContent = '✕';
    x.onclick = cerrar;
    cab.appendChild(h);
    cab.appendChild(x);
    var cuerpo = document.createElement('div');
    cuerpo.className = 'lv-cuerpo';
    if (d.aviso) {
      var av = document.createElement('p');
      av.className = 'lv-aviso';
      av.textContent = d.aviso;
      cuerpo.appendChild(av);
    }
    var tx = document.createElement('div');
    tx.className = 'lv-texto';
    tx.innerHTML = d.html || ''; // el servidor solo deja títulos, negritas, párrafos y listas
    cuerpo.appendChild(tx);
    var pie = document.createElement('div');
    pie.className = 'lv-pie';
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'lv-cerrar';
    b.textContent = d.cerrar || '✕';
    b.onclick = cerrar;
    pie.appendChild(b);
    caja.appendChild(cab);
    caja.appendChild(cuerpo);
    caja.appendChild(pie);
    v.appendChild(caja);
    v.addEventListener('click', function (e) { if (e.target === v) cerrar(); });
    document.body.appendChild(v);
    abierta = v;
    scrollAntes = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', teclaEsc);
    b.focus();
  }

  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[data-legal]') : null;
    if (!a) return;
    // (18/11/2026) Los enlaces legales del PIE abren su página normal, salvo en la página que pida la ventana
    // (la de Reserva: <body data-legal-ventana-pie>). Los de dentro de los formularios, siempre en ventana.
    if (a.closest('footer') && !document.body.hasAttribute('data-legal-ventana-pie')) return;
    // Ctrl / Cmd / clic con la rueda: que abra la página como siempre
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
    e.preventDefault();
    var lang = (document.documentElement.getAttribute('lang') || 'es').slice(0, 2);
    var href = a.getAttribute('href');
    fetch('/api/legal/' + encodeURIComponent(a.getAttribute('data-legal')) + '?lang=' + encodeURIComponent(lang))
      .then(function (r) { if (!r.ok) throw new Error('legal'); return r.json(); })
      .then(mostrar)
      .catch(function () { window.open(href, '_blank', 'noopener'); });
  });
})();

// (18/11/2026) N86 — Aviso de cookies. Solo sale si en el Admin → 🏢 Modelo de negocio está marcado
// «Enseñar el aviso de cookies en la web». Tres botones con el mismo peso («Aceptar», «Rechazar», «Configurar»),
// como pide la AEPD. La elección se guarda 12 meses en la cookie «tgc_cookies» (a1 = acepta análisis, a0 = no).
// En la página Política de cookies sale el botón para cambiar la elección. Textos: Idiomas → Textos de interfaz
// → «Páginas legales». Para el futuro (Analytics): window.tgcCookies.analisis dice si se puede cargar
// y el evento «tgc-cookies» avisa cuando el cliente elige.
(function () {
  var NOMBRE = 'tgc_cookies';
  function leer() {
    var m = document.cookie.match(/(?:^|;\s*)tgc_cookies=(a[01])/);
    return m ? m[1] === 'a1' : null;
  }
  function guardar(analisis) {
    var d = new Date(); d.setTime(d.getTime() + 365 * 24 * 3600 * 1000);
    document.cookie = NOMBRE + '=' + (analisis ? 'a1' : 'a0') + ';expires=' + d.toUTCString() + ';path=/;SameSite=Lax';
    window.tgcCookies.analisis = analisis;
    try { document.dispatchEvent(new CustomEvent('tgc-cookies', { detail: { analisis: analisis } })); } catch (e) {}
  }
  window.tgcCookies = { analisis: leer(), abrir: function () {} };

  var CSS =
    '#tgc-cookies{position:fixed;left:0;right:0;bottom:0;z-index:99990;padding:12px;box-sizing:border-box;display:flex;justify-content:center;pointer-events:none;}' +
    '#tgc-cookies .ck-caja{pointer-events:auto;background:#fff;border:1px solid var(--gris-borde,#E1DCD0);border-radius:12px;box-shadow:0 6px 28px rgba(0,0,0,0.18);max-width:760px;width:100%;padding:18px 22px;font-family:"Public Sans",sans-serif;color:var(--texto-oscuro,#2A211B);text-align:left;}' +
    '#tgc-cookies .ck-titulo{font-family:"Big Shoulders Display",sans-serif;font-size:22px;font-weight:bold;margin:0 0 6px;}' +
    '#tgc-cookies .ck-texto{font-size:14px;line-height:1.6;color:var(--texto-muted,#5b5347);margin:0 0 14px;}' +
    '#tgc-cookies .ck-texto a{color:var(--terracota,#C1502E);font-weight:600;text-decoration:none;}' +
    '#tgc-cookies .ck-botones{display:flex;gap:10px;flex-wrap:wrap;}' +
    '#tgc-cookies .ck-botones button{flex:1 1 140px;background:var(--terracota,#C1502E);color:var(--texto-claro,#F2EDE4);border:none;border-radius:6px;padding:11px 18px;font-size:14px;font-weight:500;cursor:pointer;font-family:inherit;}' +
    '#tgc-cookies .ck-botones button:hover{background:var(--terracota-oscuro,#8a3a20);}' +
    '#tgc-cookies .ck-tipo{border:1px solid var(--gris-borde,#E1DCD0);border-radius:8px;padding:10px 14px;margin:0 0 10px;}' +
    '#tgc-cookies .ck-tipo label{display:flex;justify-content:space-between;align-items:center;gap:12px;font-weight:600;font-size:14px;cursor:pointer;}' +
    '#tgc-cookies .ck-tipo input{width:18px;height:18px;flex-shrink:0;}' +
    '#tgc-cookies .ck-tipo p{font-size:13px;line-height:1.5;color:var(--texto-muted,#5b5347);margin:6px 0 0;}' +
    '#tgc-cookies .ck-siempre{font-size:12px;font-weight:600;color:var(--verde-ok,#085041);white-space:nowrap;}' +
    '.tgc-cookies-cambiar{display:inline-block;margin-top:18px;background:var(--terracota,#C1502E);color:var(--texto-claro,#F2EDE4);border:none;border-radius:6px;padding:11px 18px;font-size:14px;font-weight:500;cursor:pointer;font-family:inherit;}' +
    '@media (max-width:600px){#tgc-cookies{padding:0;}#tgc-cookies .ck-caja{border-radius:12px 12px 0 0;padding:16px;}#tgc-cookies .ck-botones button{flex:1 1 100%;}}';

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  function iniciar(d) {
    if (!d || !d.activo) return;
    var t = d.textos || {};
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    var caja = null;
    function cerrar() { if (caja) { caja.parentNode.removeChild(caja); caja = null; } }
    function textoConEnlace(s) {
      return esc(s).replace(/\[\[([^\]]+)\]\]/, '<a href="' + esc(d.politica_url) + '">$1</a>');
    }
    function abrir(configurar) {
      cerrar();
      caja = document.createElement('div');
      caja.id = 'tgc-cookies';
      caja.setAttribute('role', 'dialog');
      var html = '<div class="ck-caja"><p class="ck-titulo">' + esc(t.titulo) + '</p>';
      if (!configurar) {
        html += '<p class="ck-texto">' + textoConEnlace(t.texto) + '</p>' +
          '<div class="ck-botones"><button type="button" data-ck="si">' + esc(t.aceptar) + '</button>' +
          '<button type="button" data-ck="no">' + esc(t.rechazar) + '</button>' +
          '<button type="button" data-ck="conf">' + esc(t.configurar) + '</button></div>';
      } else {
        var marcado = window.tgcCookies.analisis === true ? ' checked' : '';
        html += '<div class="ck-tipo"><label>' + esc(t.necesarias_titulo) + ' <span class="ck-siempre">' + esc(t.siempre_activas) + '</span></label>' +
          '<p>' + esc(t.necesarias_texto) + '</p></div>' +
          '<div class="ck-tipo"><label for="ck-analisis">' + esc(t.analisis_titulo) + ' <input type="checkbox" id="ck-analisis"' + marcado + '></label>' +
          '<p>' + esc(t.analisis_texto) + '</p></div>' +
          '<div class="ck-botones"><button type="button" data-ck="guardar">' + esc(t.guardar) + '</button></div>';
      }
      caja.innerHTML = html + '</div>';
      caja.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('button[data-ck]') : null;
        if (!b) return;
        var q = b.getAttribute('data-ck');
        if (q === 'si') { guardar(true); cerrar(); }
        else if (q === 'no') { guardar(false); cerrar(); }
        else if (q === 'conf') { abrir(true); }
        else if (q === 'guardar') { guardar(!!document.getElementById('ck-analisis').checked); cerrar(); }
      });
      document.body.appendChild(caja);
    }
    window.tgcCookies.abrir = abrir;
    if (window.tgcCookies.analisis === null) abrir(false);
    // Página Política de cookies: botón para cambiar la elección
    if (d.politica_url && decodeURI(location.pathname) === d.politica_url) {
      var dest = document.querySelector('.texto-legal');
      if (dest) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'tgc-cookies-cambiar'; b.textContent = t.cambiar || '';
        b.onclick = function () { abrir(true); };
        dest.parentNode.insertBefore(b, dest.nextSibling);
      }
    }
  }

  var lang = (document.documentElement.getAttribute('lang') || 'es').slice(0, 2);
  fetch('/api/cookies-aviso?lang=' + encodeURIComponent(lang))
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(iniciar)
    .catch(function () {});
})();
