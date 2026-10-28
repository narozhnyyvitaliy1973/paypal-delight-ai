import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig, loadEnv, type ProxyOptions } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig(({ mode }) => {
  // Read server configuration here; only VITE_* variables are exposed to the browser.
  const env = loadEnv(mode, repositoryRoot, '');
  const host = process.env.HOST ?? env.HOST ?? '127.0.0.1';
  const port = process.env.PORT ?? env.PORT ?? '8003';
  const proxyHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  const authority = proxyHost.includes(':') ? `[${proxyHost}]` : proxyHost;
  const labEnabled = (process.env.AI_LAB_ENABLED ?? env.AI_LAB_ENABLED) === 'true';
  const labToken = process.env.AI_LAB_PROXY_TOKEN ?? env.AI_LAB_PROXY_TOKEN ?? '';
  const loopbackAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  const proxy: Record<string, ProxyOptions> = {
    '/api': {
      target: `http://${authority}:${port}`,
      configure(proxyServer) {
        proxyServer.on('proxyReq', (proxyRequest, request) => {
          // The local proxy authenticates the lab; never send this token to the browser.
          proxyRequest.removeHeader('X-Delight-Lab-Token');
          if (labEnabled && /^[a-f0-9]{64}$/.test(labToken) &&
              (proxyHost === 'localhost' || loopbackAddresses.has(proxyHost)) &&
              loopbackAddresses.has(request.socket.remoteAddress ?? '')) {
            proxyRequest.setHeader('X-Delight-Lab-Token', labToken);
          }
        });
      },
    },
  };
  const appOrigin = new URL(
    process.env.APP_ORIGIN ?? env.APP_ORIGIN ?? 'http://127.0.0.1:5173',
  );
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

  return {
    plugins: [vue(), {
      name: 'local-checkout-origin',
      configureServer(server) {
        // Vite advertises its bind address, which can differ from APP_ORIGIN.
        // Navigate to the configured store before cookies/orders are created.
        if (appOrigin.protocol !== 'http:' || !loopbackHosts.has(appOrigin.hostname)) return;
        const localHosts = new Set([...loopbackHosts].map(hostname =>
          `${hostname}${appOrigin.port ? `:${appOrigin.port}` : ''}`,
        ));
        server.middlewares.use((request, response, next) => {
          if (!['GET', 'HEAD'].includes(request.method ?? '') ||
              !request.headers.accept?.includes('text/html') ||
              !request.headers.host || !request.url?.startsWith('/')) return next();
          const requestedHost = request.headers.host.toLowerCase();
          if (!localHosts.has(requestedHost) || requestedHost === appOrigin.host) return next();
          response.writeHead(302, {
            Location: `${appOrigin.origin}${request.url}`,
            'Cache-Control': 'no-store',
          });
          response.end();
        });
      },
    }],
    envDir: repositoryRoot,
    build: { outDir: 'dist' },
    server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy },
    preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy },
  };
});
