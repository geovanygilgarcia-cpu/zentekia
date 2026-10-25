// Toma el panel compilado (dist-admin) y lo guarda dentro del Worker como texto,
// para que el Worker lo sirva en /admin sin necesitar otro hosting.
import { readFileSync, writeFileSync } from 'node:fs'

const css = readFileSync('dist-admin/app.css', 'utf8')
const js = readFileSync('dist-admin/app.js', 'utf8')
const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>Panel del agente</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&family=Instrument+Serif:ital@0;1&display=swap">
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js"></script>
<script>${js.replace(/<\/script/gi, '<\\/script')}</script>
</body>
</html>`
writeFileSync(
  'worker/src/admin-page.js',
  '// Archivo generado por scripts/admin-to-worker.mjs: no lo edites a mano (edita admin/ y corre npm run build:worker)\n' +
    `export const ADMIN_HTML = ${JSON.stringify(html)}\n`
)
console.log(`✓ Panel admin metido al Worker (${(html.length / 1024).toFixed(1)} kB)`)
