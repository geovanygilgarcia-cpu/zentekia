// Mete los archivos compilados dentro del Worker (worker/src/assets.ts) para servirlos sin otro hosting
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
const TYPES = { js: 'application/javascript; charset=utf-8', css: 'text/css; charset=utf-8' }
const files = readdirSync('dist-apps').filter((f) => /\.(js|css)$/.test(f))
const entries = files.map((f) => {
  const body = readFileSync(`dist-apps/${f}`, 'utf8')
  const ext = f.split('.').pop()
  console.log(`  ${f.padEnd(12)} ${(body.length / 1024).toFixed(1)} kB (${(gzipSync(body).length / 1024).toFixed(1)} kB gzip)`)
  return `  ${JSON.stringify(f)}: { type: ${JSON.stringify(TYPES[ext])}, body: ${JSON.stringify(body)} },`
})
writeFileSync(
  'worker/src/assets.ts',
  `// Archivo generado por scripts/assets-to-worker.mjs (no lo edites a mano: edita apps/ y corre npm run build)\nconst A: Record<string, { type: string; body: string }> = {\n${entries.join('\n')}\n}\nexport const asset = (name: string) => A[name] ?? null\n`,
)
console.log('✓ worker/src/assets.ts')
