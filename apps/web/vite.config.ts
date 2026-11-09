import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function roleFallback(req: { url?: string; method?: string; headers: { accept?: string } }, _res: unknown, next: () => void) {
  const pathname = req.url?.split('?')[0] ?? '/';
  const role = pathname.match(/^\/(c|p|v)(?:\/|$)/)?.[1];
  if (req.method === 'GET' && role && !pathname.includes('.') && req.headers.accept?.includes('text/html')) {
    req.url = `/${role}/index.html`;
  }
  next();
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'deriro-role-fallback',
      configureServer(server) { server.middlewares.use(roleFallback); },
      configurePreviewServer(server) { server.middlewares.use(roleFallback); },
    },
  ],
  build: {
    rollupOptions: {
      input: Object.fromEntries(['', 'c/', 'p/', 'v/'].map((role) => [role || 'root', fileURLToPath(new URL(`${role}index.html`, import.meta.url))])),
    },
  },
});
