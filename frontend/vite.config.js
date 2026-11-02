import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Em desenvolvimento, o Vite repassa /api e /socket.io para o backend (porta 3001),
// então o frontend sempre fala com "a mesma origem" e não precisa de configuração.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // acessível pela rede local (teste no celular)
    allowedHosts: ['.trycloudflare.com', '.loca.lt'],
    proxy: {
      '/api': 'http://localhost:3001',
      '/socket.io': { target: 'http://localhost:3001', ws: true },
    },
  },
})
