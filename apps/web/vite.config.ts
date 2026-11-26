import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发：Vite 固定 5173，/ws 代理到服务端 21004。
// 部署：`pnpm --filter @witcode/web build` 后由服务端在 21004 同端口托管 dist + /ws，
// 内网穿透只映射 21004 一个端口，不再依赖 Vite dev。
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:21004',
        ws: true,
      },
    },
  },
});
