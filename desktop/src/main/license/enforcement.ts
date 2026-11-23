/**
 * License enforcement switch (PHASE3_PLAN.md §8 "Preview mode").
 *
 * Compile-time only: electron-vite statically inlines `import.meta.env.MAIN_VITE_*` into the main bundle, so a
 * packaged build cannot be flipped at runtime by setting an environment variable. Set
 * MAIN_VITE_AIRBRIDGE_ENFORCE_LICENSE=1 in the build environment (or desktop/.env) to enforce; anything else —
 * including unset — builds a preview app where the license gate runs in shadow mode and never blocks.
 */
export function licenseEnforced(): boolean {
  try {
    // Literal `import.meta.env.MAIN_VITE_...` so electron-vite/vite can statically replace it.
    return import.meta.env.MAIN_VITE_AIRBRIDGE_ENFORCE_LICENSE === '1';
  } catch {
    return false;
  }
}
