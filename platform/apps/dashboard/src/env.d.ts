// Modules Vite provides at build time (vite.config.ts).
declare module 'virtual:dashboard-catalog' {
  /** The `dashboard.*` messages of `@sdlc/messages` (NFR-08). */
  const catalog: Readonly<Record<string, string>>;
  export default catalog;
}

declare module '*.css';
