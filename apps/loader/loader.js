/*
  Zentekia · loader (widget.js): una sola línea para chat, voz o ambos
  <script src="https://chat.zentekia.com/widget.js" data-key="pk_live_xxx" async></script>
  Crea la burbuja (en Shadow DOM, sin chocar con los estilos del sitio) y el iframe solo cuando se abre.
*/
;(function () {
  var script = document.currentScript || document.querySelector('script[src*="widget.js"],script[src*="snippet.js"]')
  if (!script || window.__zentekiaChat) return
  window.__zentekiaChat = true
  var src = new URL(script.src, location.href)
  var ORIGIN = src.origin
  var KEY = script.getAttribute('data-key') || src.searchParams.get('key')
  if (!KEY) return

  function start(cfg) {
    if (!cfg || cfg.suspended) return
    // Canales: chat (texto), voz o ambos. Si el asistente es solo de voz, la burbuja es un teléfono.
    if (cfg.chat === false && !cfg.voice) return
    var VOICE_ONLY = cfg.chat === false && !!cfg.voice
    var t = cfg.theme || {}
    var size = t.button_size || 56
    var side = t.position === 'left' ? 'left' : 'right'
    var mx = (t.margin_x == null ? 20 : t.margin_x) + 'px'
    var my = (t.margin_y == null ? 20 : t.margin_y) + 'px'

    var host = document.createElement('div')
    host.setAttribute('data-zentekia-chat', '')
    host.style.cssText = 'position:fixed;z-index:2147483000;' + side + ':' + mx + ';bottom:' + my + ';'
    var root = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : host
    var P = t.primary || '#2F6BFF'
    var dark = t.appearance !== 'claro'
    function shade(hex, f) {
      var n = parseInt(hex.slice(1), 16)
      var c = function (x) { return ('0' + Math.round(((n >> x) & 255) * f).toString(16)).slice(-2) }
      return '#' + c(16) + c(8) + c(0)
    }
    var css =
      ':host{all:initial}' +
      '.btn{position:relative;width:' + size + 'px;height:' + size + 'px;border-radius:' + Math.round(size * 0.32) + 'px;border:0;cursor:pointer;' +
      'background:linear-gradient(135deg,' + P + ',' + shade(P, 0.62) + ');color:#fff;display:flex;align-items:center;justify-content:center;' +
      'box-shadow:0 10px 30px -8px ' + P + ',inset 0 1px 0 rgba(255,255,255,.25);transition:transform .2s cubic-bezier(.2,.8,.2,1)}' +
      '.btn::before{content:"";position:absolute;inset:-1px;border-radius:inherit;border:1px solid ' + P + ';opacity:.6;animation:zt-ring 2.6s infinite}' +
      '.btn:hover{transform:translateY(-2px) scale(1.03)}.btn:focus-visible{outline:3px solid ' + P + ';outline-offset:3px}' +
      '.btn svg{transition:transform .25s}.btn[aria-expanded=true] svg{transform:rotate(90deg)}' +
      '@keyframes zt-ring{0%{transform:scale(1);opacity:.6}80%,100%{transform:scale(1.35);opacity:0}}' +
      '.badge{position:absolute;top:-4px;' + (side === 'left' ? 'left' : 'right') + ':-4px;min-width:18px;height:18px;border-radius:9px;background:#ef4444;color:#fff;font:600 11px/18px system-ui,sans-serif;text-align:center;padding:0 5px;display:none;box-shadow:0 0 0 2px ' + (dark ? '#0b0d12' : '#fff') + '}' +
      '.panel{position:absolute;bottom:' + (size + 16) + 'px;' + side + ':0;width:' + (VOICE_ONLY ? 360 : 390) + 'px;height:min(' + (VOICE_ONLY ? 560 : 640) + 'px,calc(100vh - ' + (size + 60) + 'px));border-radius:18px;overflow:hidden;' +
      'border:1px solid ' + (dark ? 'rgba(255,255,255,.12)' : '#d2d8e3') + ';box-shadow:0 30px 70px -20px rgba(5,7,12,.55),0 0 0 1px rgba(0,0,0,.04);background:' + (dark ? '#0b0d12' : '#f6f7fb') + ';' +
      'display:none;opacity:0;transform:translateY(12px) scale(.98);transform-origin:bottom ' + side + ';transition:opacity .22s,transform .25s cubic-bezier(.2,.8,.2,1)}' +
      '.panel.open{display:block}.panel.show{opacity:1;transform:none}iframe{border:0;width:100%;height:100%;display:block;background:transparent}' +
      '@media (prefers-reduced-motion:reduce){.btn::before{animation:none}.panel{transition:none}}' +
      '@media (max-width:480px){.panel{position:fixed;inset:0;width:auto;height:auto;border-radius:0;border:0;bottom:0}.panel.open~.btn,.panel.open~.badge{display:none}}'
    var style = document.createElement('style')
    style.textContent = css
    root.appendChild(style)

    var btn = document.createElement('button')
    btn.className = 'btn'
    btn.type = 'button'
    var LABEL_OPEN = (VOICE_ONLY ? 'Llamar a ' : 'Abrir chat con ') + (t.assistant_name || 'el asistente')
    btn.setAttribute('aria-label', LABEL_OPEN)
    btn.setAttribute('aria-expanded', 'false')
    var ICON_CHAT = '<svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2z"/></svg>'
    var ICON_X = '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6.7 5.3 12 10.6l5.3-5.3a1 1 0 1 1 1.4 1.4L13.4 12l5.3 5.3a1 1 0 0 1-1.4 1.4L12 13.4l-5.3 5.3a1 1 0 0 1-1.4-1.4l5.3-5.3-5.3-5.3a1 1 0 0 1 1.4-1.4z"/></svg>'
    var ICON_PHONE = '<svg width="25" height="25" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>'
    var ICON_MAIN = VOICE_ONLY ? ICON_PHONE : ICON_CHAT
    btn.innerHTML = ICON_MAIN
    var badge = document.createElement('span')
    badge.className = 'badge'
    var panel = document.createElement('div')
    panel.className = 'panel'
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-label', t.header_title || t.assistant_name || 'Chat')
    root.appendChild(panel)
    root.appendChild(btn)
    root.appendChild(badge)

    var frame = null
    var ready = false
    var open = false
    var unread = 0

    function notify() {
      if (ready && frame && frame.contentWindow) frame.contentWindow.postMessage({ source: 'zentekia-host', type: 'zt:visibility', visible: open }, ORIGIN)
    }
    function setOpen(v) {
      open = v
      if (v && !frame) {
        frame = document.createElement('iframe')
        frame.src = ORIGIN + '/w/frame?key=' + encodeURIComponent(KEY)
        frame.title = t.header_title || t.assistant_name || 'Chat'
        frame.allow = 'clipboard-write; microphone; autoplay'
        frame.setAttribute('referrerpolicy', 'origin')
        panel.appendChild(frame)
      }
      panel.classList.toggle('open', v)
      if (v) requestAnimationFrame(function () { requestAnimationFrame(function () { panel.classList.add('show') }) })
      else panel.classList.remove('show')
      btn.innerHTML = v ? ICON_X : ICON_MAIN
      btn.setAttribute('aria-expanded', String(v))
      btn.setAttribute('aria-label', v ? (VOICE_ONLY ? 'Cerrar' : 'Cerrar chat') : LABEL_OPEN)
      if (v) {
        unread = 0
        badge.style.display = 'none'
      }
      notify()
    }
    btn.addEventListener('click', function () {
      setOpen(!open)
    })
    window.addEventListener('message', function (e) {
      if (e.origin !== ORIGIN || !e.data || e.data.source !== 'zentekia-chat') return
      if (e.data.type === 'zt:close') {
        setOpen(false)
        btn.focus()
      } else if (e.data.type === 'zt:ready') {
        ready = true
        notify()
      }
      else if (e.data.type === 'zt:message' && !open) {
        unread++
        badge.textContent = String(unread)
        badge.style.display = 'block'
      }
    })
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && open) setOpen(false)
    })
    ;(document.body || document.documentElement).appendChild(host)

    var delay = Number(t.auto_open_delay || 0)
    var seen = false
    try {
      seen = sessionStorage.getItem('zt-auto-' + KEY) === '1'
    } catch (e) {}
    if (delay > 0 && !seen && !VOICE_ONLY)
      setTimeout(function () {
        if (!open) setOpen(true)
        try {
          sessionStorage.setItem('zt-auto-' + KEY, '1')
        } catch (e) {}
      }, delay * 1000)
  }

  fetch(ORIGIN + '/v1/widget/config?key=' + encodeURIComponent(KEY), { credentials: 'omit' })
    .then(function (r) {
      return r.ok ? r.json() : null
    })
    .then(start)
    .catch(function () {})
})()
