// IFC Viewer – build: relativní cesty (GitHub Pages v podsložce i samostatné nasazení), worker jako ES modul.
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  server: { port: 5180 },
  preview: { port: 4180 },
});
