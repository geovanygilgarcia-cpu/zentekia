// Compila admin, portal, iframe del widget y loader con esbuild (Preact)
import { build } from 'esbuild'
const watch = process.argv.includes('--watch')
const common = { bundle: true, minify: true, target: 'es2020', jsx: 'automatic', jsxImportSource: 'preact', legalComments: 'none', logLevel: 'info', loader: { '.js': 'jsx' } }
await build({ ...common, entryPoints: { admin: 'apps/admin/main.jsx', portal: 'apps/portal/main.jsx', frame: 'apps/frame/main.jsx' }, outdir: 'dist-apps', format: 'iife' })
await build({ ...common, entryPoints: { loader: 'apps/loader/loader.js', theme: 'apps/theme/theme.js', voice: 'apps/voice/voice.js' }, outdir: 'dist-apps', format: 'iife', jsx: undefined, jsxImportSource: undefined, loader: {} })
