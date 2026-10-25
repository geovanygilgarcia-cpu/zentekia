import React from 'react'

/*
  Markdown mínimo y seguro (sin innerHTML): **negritas**, listas con "- ",
  enlaces [texto](https://...) y URLs sueltas, saltos de línea y párrafos.
*/
const INLINE = /(\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<]+[^\s<.,;:!?)])/g

function enLinea(texto, k) {
  return texto.split(INLINE).map((p, i) => {
    if (!p) return null
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={`${k}-${i}`}>{p.slice(2, -2)}</strong>
    const md = p.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/)
    if (md) return <a key={`${k}-${i}`} href={md[2]} target="_blank" rel="noopener noreferrer">{md[1]}</a>
    if (/^https?:\/\//.test(p)) return <a key={`${k}-${i}`} href={p} target="_blank" rel="noopener noreferrer">{p}</a>
    return <React.Fragment key={`${k}-${i}`}>{p}</React.Fragment>
  })
}

export default function Markdown({ text }) {
  const bloques = []
  let lista = null
  let parrafo = []
  const cerrarParrafo = () => {
    if (parrafo.length) {
      const k = bloques.length
      bloques.push(
        <p key={k}>
          {parrafo.map((l, i) => (
            <React.Fragment key={i}>
              {i > 0 && <br />}
              {enLinea(l, `${k}-${i}`)}
            </React.Fragment>
          ))}
        </p>
      )
      parrafo = []
    }
  }
  const cerrarLista = () => {
    if (lista) {
      const k = bloques.length
      bloques.push(<ul key={k}>{lista.map((l, i) => <li key={i}>{enLinea(l, `${k}-${i}`)}</li>)}</ul>)
      lista = null
    }
  }
  for (const linea of text.split('\n')) {
    const item = linea.match(/^\s*[-•*]\s+(.*)$/)
    if (item) {
      cerrarParrafo()
      ;(lista ||= []).push(item[1])
    } else if (!linea.trim()) {
      cerrarParrafo()
      cerrarLista()
    } else {
      cerrarLista()
      parrafo.push(linea)
    }
  }
  cerrarParrafo()
  cerrarLista()
  return <>{bloques}</>
}
