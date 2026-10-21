/**
 * Detects "the page is older than the code the server now serves" — a dev
 * server restart or a new production deploy invalidates lazy module URLs
 * (Vite ?t= transforms, hashed chunks), so dynamic import() rejects with
 * a module-load error. The right response is a reload, not an error card.
 */
export function isStaleModuleError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (
    /error loading dynamically imported module/i.test(msg) ||
    /failed to fetch dynamically imported module/i.test(msg) ||
    /importing a module script failed/i.test(msg) ||
    /unable to preload css/i.test(msg)
  );
}
