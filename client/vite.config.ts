import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig, loadEnv } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig(({ mode }) => {
  // Read server configuration here; only VITE_* variables are exposed to the browser.
  const env = loadEnv(mode, repositoryRoot, '');
  const host = process.env.HOST ?? env.HOST ?? '127.0.0.1';
  const port = process.env.PORT ?? env.PORT ?? '8003';
  const proxyHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  const authority = proxyHost.includes(':') ? `[${proxyHost}]` : proxyHost;
  const proxy = {
    '/api': { target: `http://${authority}:${port}` },
  };

  return {
    plugins: [vue()],
    envDir: repositoryRoot,
    build: { outDir: 'dist' },
    server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy },
    preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy },
  };
});
