import { useEffect, useState } from 'preact/hooks'

let push = () => {}
export const toast = (msg, err = false) => push({ msg, err, id: Math.random() })
export const toastError = (e) => toast(e?.message || String(e), true)

export function Toasts() {
  const [items, setItems] = useState([])
  useEffect(() => {
    push = (t) => {
      setItems((x) => [...x, t])
      setTimeout(() => setItems((x) => x.filter((y) => y.id !== t.id)), t.err ? 6000 : 3200)
    }
  }, [])
  return (
    <div class="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} class={'toast' + (t.err ? ' err' : '')}>{t.msg}</div>
      ))}
    </div>
  )
}
