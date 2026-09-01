import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Em dev o front roda no Vite (5175) e a API no `wrangler dev` (8787).
// Em produção o próprio Worker serve o dist/ — o caminho /api é o mesmo.
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE_PATH || '/',
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  server: {
    port: 5175,
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        // sem isto, o Worker fora do ar vira um "Erro 500" mudo na tela
        configure: (proxy) => {
          proxy.on('error', (err, _req, res) => {
            const detail =
              err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET'
                ? 'A API não está rodando na porta 8787. Abra outro terminal e rode: npm run dev:api'
                : `Não consegui falar com o Worker na porta 8787 (${err.code || err.message}).`
            try {
              if (res && !res.headersSent && res.writeHead) {
                res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ detail }))
              } else if (res && res.end) {
                res.end()
              }
            } catch { /* socket já fechado */ }
          })
        },
      },
    },
  },
})
