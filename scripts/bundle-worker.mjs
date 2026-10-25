// Junta todo el Worker en UN archivo para pegarlo en el editor de Cloudflare (Worker → Editar código)
import { build } from 'esbuild'
await build({
  entryPoints: ['worker/src/index.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  outfile: 'worker/worker-un-archivo.js',
  legalComments: 'none',
  banner: { js: '// Zentekia Chat · ARCHIVO ÚNICO para pegar en el editor de Cloudflare.\n// Generado con: npm run build (no lo edites a mano: edita worker/src y apps/)\n' },
})
console.log('✓ worker/worker-un-archivo.js')
