/*
  En celular las tablas (.tbl) se muestran como tarjetas: cada celda lleva el nombre de su columna
  (data-label) y el CSS de ui.css las apila. Funciona solo con cualquier tabla que tenga <thead>.
*/
function labelTables() {
  for (const t of document.querySelectorAll('table.tbl')) {
    const heads = [...t.querySelectorAll('thead th')].map((th) => th.textContent.trim())
    if (!heads.length) continue
    t.classList.add('tbl-stack')
    for (const tr of t.querySelectorAll('tbody tr')) {
      let col = 0 // columna real (las celdas con colspan ocupan varias)
      for (const td of tr.children) {
        const i = col
        col += td.colSpan || 1
        if (td.colSpan > 1) {
          td.classList.add('td-span')
          continue
        }
        if (heads[i] && td.getAttribute('data-label') !== heads[i]) td.setAttribute('data-label', heads[i])
        if (!heads[i]) td.classList.add('td-actions')
      }
    }
  }
}

export function stackTablesOnMobile(root) {
  let queued = false
  new MutationObserver(() => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      labelTables()
    })
  }).observe(root, { childList: true, subtree: true })
}
