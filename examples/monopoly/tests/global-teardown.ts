/**
 * Playwright globalTeardown. The backend + bots run inside the Next dev webServer
 * (auto-started by instrumentation), which Playwright tears down itself, so there are
 * no separate processes to kill. Kept as a no-op hook for symmetry.
 */
export default async function globalTeardown() {
  /* nothing to clean up — the app's webServer owns the backend + bots */
}
