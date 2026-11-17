// (17/11/2026) N86 — Ventana de los textos legales.
// Los enlaces legales de la web (pie, casilla de la reserva, información de datos, «Solicitar precio»,
// Alta choferes, portal…) llevan data-legal="aviso-legal | privacidad | cookies | condiciones".
// Al pulsarlos, el texto se abre en una ventana encima de la página: el cliente no sale de donde está
// ni pierde lo escrito. Si algo falla, el enlace funciona como siempre (abre la página legal).
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
