/**
 * Build-time variables electron-vite inlines into the main process (MAIN_VITE_* prefix). Declared here so
 * plain `tsc` type-checks `import.meta.env` without pulling in vite/client.
 */
interface ImportMetaEnv {
  /** "1" = enforce the license gate (PHASE3_PLAN.md §8). Unset/anything else = preview (shadow mode). */
  readonly MAIN_VITE_AIRBRIDGE_ENFORCE_LICENSE?: string;
  /** JSON map kid -> SPKI PEM of trusted license-signing keys (see license/publicKeys.ts). */
  readonly MAIN_VITE_AIRBRIDGE_LICENSE_PUBKEYS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
