// ★ "Could not reach the machine at all" as its own error (2026-09-26 / user decision).
//
// ★ A machine that is off or asleep is a **state, not an error**: the list shows it as a quiet grey line, not a red banner.
//   Errors after actually reaching the machine (broken config, unregistered device, refused handshake) stay red.
// ⚠️ Decided by the type, never by the message text (messages are translated and change).
// ⚠️ The browser hides why a relay refused before the upgrade, so "PC needs nyan login" and "phone limit" also land here;
//    the quiet line's details list those checks (`ui/offline.ts`).

export class UnreachableError extends Error {
  readonly unreachable = true as const
}

export function isUnreachable(err: unknown): boolean {
  return err instanceof UnreachableError
}
