import qrcode from 'qrcode-generator'

/* QR del código TOTP dibujado con rectángulos SVG (sin HTML crudo) */
export default function Qr({ text }) {
  const q = qrcode(0, 'M')
  q.addData(text)
  q.make()
  const n = q.getModuleCount()
  const cells = []
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) cells.push(<rect key={`${r}-${c}`} x={c + 2} y={r + 2} width="1.02" height="1.02" />)
  return (
    <svg class="qr" viewBox={`0 0 ${n + 4} ${n + 4}`} role="img" aria-label="Código QR para tu app de autenticación">
      <rect width={n + 4} height={n + 4} fill="#fff" />
      <g fill="#0f172a">{cells}</g>
    </svg>
  )
}
