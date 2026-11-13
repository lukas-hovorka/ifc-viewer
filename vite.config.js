// IFC Viewer – build: relativní cesty (GitHub Pages v podsložce i samostatné nasazení), worker jako ES modul.
import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

/** Manifest aplikace (ikona a barvy při připnutí / instalaci) z barev EBC_UI_vibe. Ikony vyrábí scripts/make-icons.py. */
function manifestPlugin() {
  const tokens = JSON.parse(fs.readFileSync(path.join(root, 'src', 'ebc', 'ebc-tokens.dark.json'), 'utf-8'));
  const manifest = JSON.stringify({
    name: 'IFC Viewer',
    short_name: 'IFC Viewer',
    description: 'Prohlížeč modelů IFC v prohlížeči',
    lang: 'cs',
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: tokens['color.bg.window'],
    theme_color: tokens['color.bg.chrome'],
    icons: [
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: 'icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }, null, 2);
  return {
    name: 'manifest',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if ((req.url || '').split('?')[0].endsWith('/manifest.webmanifest')) {
          res.setHeader('Content-Type', 'application/manifest+json');
          res.end(manifest);
        } else next();
      });
    },
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'manifest.webmanifest', source: manifest }); },
  };
}

export default defineConfig({
  base: './',
  plugins: [manifestPlugin()],
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  server: { port: 5180 },
  preview: { port: 4180 },
});
