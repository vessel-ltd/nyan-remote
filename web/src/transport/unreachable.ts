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

/**
 * ★ The relay refused this phone because its free slot is another machine (close 4008), or the slot was just moved away (4011)
 *   (2026-09-27). A kind of "unreachable" for the list (quiet), and its own state on the connections page (with the button that
 *   moves the slot here / `ui/connections.ts`).
 */
export class FreeSlotError extends UnreachableError {
  readonly freeSlot = true as const
}

export function isFreeSlot(err: unknown): boolean {
  return err instanceof FreeSlotError
}

/** ★ How a line went down (the carrier decides; the route and pending requests carry it as the error's type) */
export type DownKind = 'unreachable' | 'free-slot'

export function errorOfKind(reason: string, kind: DownKind | undefined): Error {
  return kind === 'unreachable' ? new UnreachableError(reason) : kind === 'free-slot' ? new FreeSlotError(reason) : new Error(reason)
}
