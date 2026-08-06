import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify � file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      // IMPORTANT: ignore build output dirs. On Windows chokidar holds directory
      // handles WITHOUT FILE_SHARE_DELETE, so electron-builder's "extract then
      // rename win-unpacked.tmp -> win-unpacked" step fails with EPERM while the
      // dev server is running. Ignoring release/ and build-out/ fixes that.
      watch:
        process.env.DISABLE_HMR === 'true'
          ? null
          : {
              ignored: [
                '**/node_modules/**',
                '**/release/**',
                '**/build-out/**',
                '**/dist/**',
                '**/.git/**',
              ],
            },
    },
  };
});
