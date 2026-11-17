// ★ Where files from the phone are kept, and which names there are ours (2026-11-17 / `agent/src/uploads.ts`).
//   In `shared/` so the uninstaller reads the same rules without the agent's code. ⚠️ No Node imports (pure).

/** Finished files: `<yyyymmdd>-<hhmmss>-<32 hex>.<ext>`; parts of unfinished ones: `.part-<32 hex>` */
export const UPLOAD_FINAL_NAME = /^\d{8}-\d{6}-[0-9a-f]{32}\.[a-z]{1,8}$/
export const UPLOAD_PART_NAME = /^\.part-[0-9a-f]{32}$/

/** Whether a name in the uploads folder is one the agent writes (only those are ever removed) */
export function isUploadName(name: string): boolean {
  return UPLOAD_FINAL_NAME.test(name) || UPLOAD_PART_NAME.test(name)
}

/**
 * ★ The folder: `$NYAN_REMOTE_UPLOADS_DIR`, else `${XDG_DATA_HOME:-<home>/.local/share}/nyan-remote/uploads`.
 * ⚠️ Never inside the state directory (it holds the keys; an "allow reading this folder" answer must not cover them).
 * ⚠️ A relative `XDG_DATA_HOME` is ignored (the XDG rule).
 */
export function uploadsDirFor(env: Record<string, string | undefined>, home: string): string {
  if (env['NYAN_REMOTE_UPLOADS_DIR']) return env['NYAN_REMOTE_UPLOADS_DIR']
  const xdg = env['XDG_DATA_HOME']
  const data = xdg && xdg.startsWith('/') ? xdg.replace(/\/+$/, '') : `${home.replace(/\/+$/, '')}/.local/share`
  return `${data}/nyan-remote/uploads`
}
