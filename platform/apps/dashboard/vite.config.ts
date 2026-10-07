// Build of the read-only dashboard (task U01, design/ADR-M54 §2.5). `sdlc-api` serves the output
// under /dashboard/ with a strict Content-Security-Policy, so the build must hold no inline script,
// no inline asset (data: URIs) and no third-party URL.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { defineConfig, type Plugin } from 'vite';

const root = import.meta.dirname;
const CATALOG_ID = 'virtual:dashboard-catalog';

/**
 * The `dashboard.*` and `intent.waiting*` (U02) messages of the catalog (`@sdlc/messages`, NFR-08), bundled at build time. The
 * whole catalog is ~100 kB; the dashboard needs only its own keys.
 */
export function dashboardCatalog(): Plugin {
  const file = path.resolve(root, '../../packages/messages/src/locales/en.json');
  return {
    name: 'sdlc-dashboard-catalog',
    resolveId: (id) => (id === CATALOG_ID ? `\0${CATALOG_ID}` : null),
    load(id) {
      if (id !== `\0${CATALOG_ID}`) return null;
      this.addWatchFile(file);
      const all = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
      const own = Object.fromEntries(
        Object.entries(all).filter(
          ([key]) => key.startsWith('dashboard.') || key.startsWith('intent.waiting'),
        ),
      );
      return `export default ${JSON.stringify(own)};`;
    },
  };
}

export default defineConfig({
  root,
  base: '/dashboard/',
  plugins: [dashboardCatalog()],
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  resolve: {
    // The shared schemas from source: one ES module graph, tree-shaken.
    alias: {
      '@sdlc/api-schemas': path.resolve(root, '../../packages/api-schemas/src/index.ts'),
    },
  },
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
    // CSP `font-src 'self'`, `img-src 'self'`: never a data: URI.
    assetsInlineLimit: 0,
    // No inline polyfill script.
    modulePreload: { polyfill: false },
    sourcemap: false,
    target: 'es2022',
    reportCompressedSize: true,
  },
});
