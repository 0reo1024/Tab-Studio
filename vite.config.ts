import { defineConfig } from 'vite';
export default defineConfig({ base: './', build: { target: 'es2022',rolldownOptions:{input:{main:'index.html',print:'print.html'}} }, server: { host: '127.0.0.1', port: 5173 } });
