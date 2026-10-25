/* Markdown mínimo y seguro (sin HTML crudo): **negritas**, listas "- ", enlaces http(s) y saltos de línea */
const INLINE = /(\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<]+[^\s<.,;:!?)])/g

function inline(text, k) {
  return text.split(INLINE).map((p, i) => {
    if (!p) return null
    if (p.startsWith('**') && p.endsWith('**') && p.length > 4) return <strong key={`${k}-${i}`}>{p.slice(2, -2)}</strong>
    const md = p.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/)
    if (md) return <a key={`${k}-${i}`} href={md[2]} target="_blank" rel="noopener noreferrer nofollow">{md[1]}</a>
    if (/^https?:\/\//.test(p)) return <a key={`${k}-${i}`} href={p} target="_blank" rel="noopener noreferrer nofollow">{p}</a>
    return p
  })
}

export default function Markdown({ text }) {
  const blocks = []
  let list = null
  let para = []
  const closePara = () => {
    if (para.length) {
      const k = blocks.length
      blocks.push(<p key={k}>{para.map((l, i) => [i > 0 && <br key={`br${i}`} />, inline(l, `${k}-${i}`)])}</p>)
      para = []
    }
  }
  const closeList = () => {
    if (list) {
      const k = blocks.length
      blocks.push(<ul key={k}>{list.map((l, i) => <li key={i}>{inline(l, `${k}-${i}`)}</li>)}</ul>)
      list = null
    }
  }
  for (const line of String(text || '').split('\n')) {
    const item = line.match(/^\s*(?:[-•*]|\d+[.)])\s+(.*)$/)
    if (item) {
      closePara()
      ;(list ||= []).push(item[1])
    } else if (!line.trim()) {
      closePara()
      closeList()
    } else {
      closeList()
      para.push(line.replace(/^#{1,6}\s+/, ''))
    }
  }
  closePara()
  closeList()
  return <>{blocks}</>
}
