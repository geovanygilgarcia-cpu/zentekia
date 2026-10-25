// Se carga en el <head> antes que el CSS se pinte: aplica el tema y el tamaño de letra guardados sin parpadeo
;(function () {
  var t = null
  var s = null
  try {
    t = localStorage.getItem('zt-theme')
    s = localStorage.getItem('zt-size')
  } catch (e) {}
  if (t !== 'light' && t !== 'dark') t = window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', t)
  if (s === 'lg' || s === 'xl') document.documentElement.setAttribute('data-size', s)
})()
