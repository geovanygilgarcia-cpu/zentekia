import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Compilación sin bundlear React (se carga desde CDN): para la vista previa y para el panel admin
const conReactExterno = (entrada, salida) => ({
  esbuild: { jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment' },
  build: {
    outDir: salida,
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: entrada,
      external: ['react', 'react-dom', 'react-dom/client'],
      output: {
        format: 'iife',
        entryFileNames: 'app.js',
        assetFileNames: 'app.[ext]',
        globals: { react: 'React', 'react-dom': 'ReactDOM', 'react-dom/client': 'ReactDOM' },
      },
    },
  },
})

// npm run build          → sitio de demo en /dist
// npm run build:preview  → vista previa publicada (un archivo)
// npm run build:worker   → compila el panel admin y lo mete al Worker
// npm run dev:admin      → panel admin en http://localhost:5173/admin/
export default defineConfig(({ mode }) => {
  if (mode === 'preview') return conReactExterno('src/main.jsx', 'dist-preview')
  if (mode === 'admin') return conReactExterno('admin/main.jsx', 'dist-admin')
  return { plugins: [react()] }
})
