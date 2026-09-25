// ★★ Reading a QR with the camera (③ stage 6, ④ / 2026-09-16).
//
// ★ **Zero dependencies**: `getUserMedia` + **`BarcodeDetector` (built into the browser)**, or **our own decoder** if absent
//   (`shared/qrDecode.ts` / 2026-09-24. Adding a decoding library would violate CLAUDE.md §2 "do not add dependencies").
//   ★★ **iOS Safari has no `BarcodeDetector`** ⇒ copy a video frame to a canvas and decode it ourselves (the camera works on iPhone too).
//   ⚠️ **Pasting always remains** (the camera is "an addition", not a replacement).
//
// ⚠️⚠️ **The steps live here (`.ts`)** (`.tsx` has no behavioural tests / 2026-09-08 codex).
//   All `.tsx` does is line up "open, run, close".
//
// ⚠️ Strings from the camera are **hostile input**. ⇒ Here we only check whether it has the `nyan://pair` shape,
//   and leave interpretation to `parsePairUrl` in `shared/pairing.ts` (never throws, never falls back to defaults).
//
// ★★ **This file owns the camera's lifetime** (2026-09-16 / codex round 7, medium #5, #6).
//   ⚠️⚠️ Three holes were fixed, **each either "the light stays on" or "registration starts after closing"**:
//   1. **"Closed" was not checked after `await`** ⇒ a QR arriving after closing started a registration
//   2. **If `detect()` never returned, the whole loop stalled** ⇒ it **never reached** `s.stop()` in `finally` either
//      ⇒ The deadline comes **from outside the loop** (`ScanOptions.expired`). ⚠️ This is **the only way out**
//   3. **It was not tied to the screen's lifetime** (unmount, double tap, failure mid-open)
//      ⇒ `createScanController` owns "only one, stops at once when closed"

import { PAIR_SCHEME } from '../../../shared/pairing.ts'
import { t } from '../../../shared/i18n.ts'
import { decodeQrImage, type RgbaImage } from '../../../shared/qrDecode.ts'

/** ⚠️ Only the port that reads one frame (no dependency on the whole `BarcodeDetector` = can be faked in tests) */
export interface Scanner {
  /** ⚠️ Empty if nothing is read (never throws) */
  detect: () => Promise<readonly string[]>
  /**
   * ⚠️⚠️ **Always called** (otherwise the camera stays on).
   * ⚠️ **May be called any number of times** (comes from both the loop's `finally` and `stop()`).
   */
  stop: () => void
}

export type ScanOutcome =
  | { kind: 'found'; raw: string }
  | { kind: 'timeout' }
  | { kind: 'stopped' }
  | { kind: 'error'; reason: string }
  /** ★ Already open (⚠️⚠️ the reply so that **a second camera is not grabbed** / codex round 7, medium #6) */
  | { kind: 'busy' }

export interface ScanOptions {
  /** ⚠️ Wait until the next frame */
  readonly wait: (ms: number) => Promise<void>
  /**
   * ★★ Deadline. ⚠️⚠️ **Comes from outside the loop** (= works even if `detect()` never returns).
   *
   * ⚠️⚠️ **Do not go back to counting with `wait`.** If `detect()` does not return, the loop cannot get back to its head,
   *    so "check `now()` and give up" **never runs** = the camera stays on (medium #5).
   */
  readonly expired: Promise<void>
  /** ★ Stop when the screen closes (⚠️ checked **every time**; checking once keeps it running after closing) */
  readonly stopped: () => boolean
}

/** ⚠️ Read interval (★ too fast eats CPU, too slow makes people think "it cannot read") */
export const SCAN_INTERVAL_MS = 200

/** ⚠️ Until reading gives up (without it, battery and camera are consumed indefinitely) */
export const SCAN_DEADLINE_MS = 60_000

/** ★ Equivalent of `setTimeout` (⚠️ **injected** = so tests control time). Returns a canceller */
export type ScanTimer = (ms: number, fn: () => void) => () => void

/**
 * ★★ **Hand over "how to stop" the moment it is grabbed** (2026-09-18 / codex round 8, medium #3).
 *
 * ⚠️⚠️ Without it, after `getUserMedia()` returned and while waiting on `video.play()`,
 *    **neither `stop()` nor the deadline reached the track** (measured `stops:0 / active:true`).
 *    = The camera light stays on and cannot be stopped even when the screen goes away.
 * ⇒ **Call it before any `await`**. ⚠️ Until called, `stop()` can stop nothing.
 */
export type Claim = (stop: () => void) => void

/** ★ Is it a pairing QR? ⚠️ **Returns nothing else** (do not start registration from an unrelated QR) */
export function isPairText(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.startsWith(`${PAIR_SCHEME}//pair?`)
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

type Settled =
  | { kind: 'ok'; frame: readonly string[] }
  | { kind: 'fail'; err: unknown }
  | { kind: 'expired' }

/**
 * ⚠️⚠️ **Absorb rejection first** (if it rejects after being abandoned it becomes an "unhandled rejection").
 * ⇒ The promise this function returns **never rejects**.
 */
function settle(p: Promise<readonly string[]>): Promise<Settled> {
  return p.then(
    (frame): Settled => ({ kind: 'ok', frame }),
    (err: unknown): Settled => ({ kind: 'fail', err }),
  )
}

/**
 * ★★ Loop until something is read. **Always stop the camera** (`finally`).
 *
 * ⚠️⚠️ Forgetting to stop leaves **the camera light on** (the scariest failure from the user's point of view).
 * ⚠️⚠️ **Check "closed" and the deadline after every `await`** (codex round 7, medium #5).
 *    Otherwise "closed, yet a late QR starts a registration".
 */
export async function scanForPairing(s: Scanner, o: ScanOptions): Promise<ScanOutcome> {
  // ★ The deadline is **created once** and reused (⚠️ created inside the loop, it would extend on every wait)
  const deadline = o.expired.then((): Settled => ({ kind: 'expired' }))
  try {
    for (;;) {
      if (o.stopped()) return { kind: 'stopped' }
      // ⚠️⚠️ **Wait in an abandonable way** (exits here even if `detect()` never returns = reaches the `finally` below)
      const got = await Promise.race([settle(s.detect()), deadline])
      if (got.kind === 'expired') return { kind: 'timeout' }
      if (got.kind === 'fail') return { kind: 'error', reason: reasonOf(got.err) }
      // ⚠️⚠️ **An `await` intervened, so check again** (do not start registration from a QR that arrived after closing)
      if (o.stopped()) return { kind: 'stopped' }
      // ⚠️ One frame may contain several QRs. Pick **only the pairing one**
      const hit = got.frame.find((t) => isPairText(t))
      if (hit !== undefined) return { kind: 'found', raw: hit }
      const ticked = await Promise.race([
        o.wait(SCAN_INTERVAL_MS).then((): Settled => ({ kind: 'ok', frame: [] })),
        deadline,
      ])
      if (ticked.kind === 'expired') return { kind: 'timeout' }
    }
  } finally {
    s.stop()
  }
}

/**
 * ★★ Owns the camera's lifetime (2026-09-16 / codex round 7, medium #6).
 *
 * ⚠️⚠️ **Not held by the screen (`.tsx`).** `.tsx` has no behavioural tests, so
 *    "stops on unmount" and "a double tap does not open two" would break **with nobody watching**
 *    (measured: removing `track.stop()` left all 7 camera tests green / docs/VERIFY.md).
 *
 * It guards three things:
 * 1. ⚠️⚠️ **Only one at a time** (the flag is set **before** `await`; after, a double tap opens two)
 * 2. ⚠️⚠️ **`stop()` stops the grabbed camera directly** (without waiting for the loop's reply =
 *    even if `detect()` never returns, the light goes off the instant the screen goes away)
 * 3. ⚠️ **If closed mid-open, do not keep running with it grabbed**
 */
export interface ScanController {
  /**
   * ★ Run once. ⚠️⚠️ If already running, **do not grab the camera** (returns `busy`).
   *
   * ★★ **It only receives "the inputs to open the camera"** (2026-09-19 / codex round 9, medium #2).
   *   ⚠️⚠️ It used to take **an arbitrary opener**, making "call `claim` the moment it grabs"
   *      **a convention for the caller**. ⇒ **Forgetting it cannot be prevented by types** (even as a required argument
   *      only "forgetting to pass it" is prevented; an opener that never calls `claim` could be written / codex's advice).
   *   ⇒ **The stream is grabbed inside the controller**. Only the browser ports (`CameraEnv`) are passed in.
   */
  readonly run: (o: { video: VideoLike; env: CameraEnv }) => Promise<ScanOutcome>
  /** ★ Stop (⚠️ callable even when not running, any number of times). ⇒ **Also called on unmount** */
  readonly stop: () => void
  /** Whether it is running (★ used for the screen text and for handling a double press) */
  readonly active: () => boolean
}

export function createScanController(timer: ScanTimer): ScanController {
  /**
   * ★★ **The one run currently in progress** (2026-09-19 / codex round 9, medium #2).
   *
   * ⚠️⚠️ `cancelled` and `release` used to be **shared across runs**, so
   *    **when an old run that ended by deadline grabbed its camera late, it overwrote the next run's stop target**.
   *    Measured: after `stop()` A.stop=1 / B.stop=0; after B's deadline A.stop=2 / **B.stop=0**
   *    = **B's camera never stops** (not even unmount can save it).
   * ⇒ The cancel flag and the stopper are **owned by that run**.
   */
  interface Run {
    cancelled: boolean
    release?: () => void
  }
  let current: Run | undefined

  /** ⚠️ Cancel, and if grabbed, stop at once (★ may be called any number of times) */
  const abort = (r: Run) => {
    r.cancelled = true
    r.release?.()
  }

  const stop = () => {
    if (current) abort(current)
  }

  return {
    active: () => current !== undefined,
    stop,
    run: async ({ video, env }) => {
      // ⚠️⚠️ **The flag is set before `await`** (after, a double tap opens two / ARCHITECTURE §14.1.2.11 ①)
      if (current) return { kind: 'busy' }
      const mine: Run = { cancelled: false }
      current = mine
      let fire!: () => void
      const expired = new Promise<void>((r) => {
        fire = r
      })
      // ⚠️ The deadline counts from **before opening** (even if stuck at the permission dialog, it is not forever)
      //
      // ★ `abort(mine)`, not `stop()` (= **stops only our own run**).
      //   ⚠️ This **cannot be killed by a mutant** (`cancelTimer` acts first, so whenever this flag fires
      //      `current === mine` holds). ⇒ It falls under CLAUDE.md §2 "cannot be killed but kept".
      //   **Why keep it**: this medium #2 was caused by "sharing state across runs".
      //   Unless ownership is explicit **on every line**, a future change removing one `cancelTimer`
      //   would silently bring the same accident back. ⚠️ Do not settle it with "cannot be killed, so remove".
      const cancelTimer = timer(SCAN_DEADLINE_MS, () => {
        abort(mine)
        fire()
      })
      try {
        // ★★ **The stream is grabbed here** (= "hold the stopper the moment it is grabbed" holds structurally).
        //   ⚠️⚠️ Do not go back to receiving `open` from outside (forgetting cannot be prevented by types).
        const opened = await Promise.race([
          openCamera(video, env, (r) => {
            mine.release = r
            // ⚠️⚠️ If it is **already over** at the moment of grabbing, stop it right there
            //    (★ look only at our own flag = do not overwrite the next run's stop target)
            if (mine.cancelled) r()
          }).then(
            (v): { ok: true; s: Scanner } | { ok: false; e: unknown } => ({ ok: true, s: v }),
            (e: unknown): { ok: true; s: Scanner } | { ok: false; e: unknown } => ({ ok: false, e }),
          ),
          expired.then(() => undefined),
        ])
        if (opened === undefined) return { kind: 'timeout' }
        if (!opened.ok) {
          // ⚠️ Also here when permission is denied (never create "silently nothing happens")
          return { kind: 'error', reason: reasonOf(opened.e) }
        }
        // ⚠️ **If closed mid-open**, do not return early here.
        //   The loop head of `scanForPairing` **checks `stopped()`**, so without reading a frame
        //   it reaches `s.stop()` in `finally` (= same result).
        //   ⚠️⚠️ Do not add the early return back: **a guard others back up cannot be killed by tests**.
        return await scanForPairing(opened.s, {
          expired,
          stopped: () => mine.cancelled,
          wait: (ms) => new Promise<void>((r) => void timer(ms, r)),
        })
      } finally {
        cancelTimer()
        // ⚠️ **Step down only while we are current** (a late-finishing old run must not clear the next run).
        //   ⚠️ This also **cannot be killed by a mutant** (`run` excludes via `current`, so no ordering exists where
        //      another run reaches its `finally` while still current). ⇒ Kept for the same reason as above.
        if (current === mine) current = undefined
      }
    },
  }
}

/**
 * ★ Whether camera scanning is available on this device. ⚠️ **If not, do not show the button** (fail-closed).
 *
 * ★ iOS Safari has no `BarcodeDetector` ⇒ read with **our own decoder** (2026-09-24; previously paste only).
 * ⚠️ `getUserMedia` **only exists on https (or localhost)**, so that is checked too.
 */
export function canScan(w: unknown): boolean {
  const g = w as {
    BarcodeDetector?: unknown
    navigator?: { mediaDevices?: { getUserMedia?: unknown } }
    document?: { createElement?: unknown }
  }
  if (typeof g?.navigator?.mediaDevices?.getUserMedia !== 'function') return false
  // ★ How to read: the built-in `BarcodeDetector`, otherwise copy to a canvas and decode ourselves (iOS Safari)
  return typeof g?.BarcodeDetector === 'function' || typeof g?.document?.createElement === 'function'
}

/** Text shown on screen. ★ **One place** (two places diverge / CLAUDE.md §2) */
export function scanText(o: ScanOutcome): string {
  switch (o.kind) {
    case 'found':
      return t('読み取りました', 'Scanned')
    case 'timeout':
      return t('QR を読み取れませんでした（明るさとピントを確かめて、もう一度）', 'Could not read the QR (check the lighting and focus, then try again)')
    case 'stopped':
      return t('カメラを閉じました', 'Camera closed')
    case 'busy':
      // ⚠️ If shown, it means "tried to open twice" (⚠️ the camera is not grabbed)
      return t('カメラはすでに開いています', 'The camera is already open')
    case 'error':
      // ⚠️ Permission denial also lands here (never create "silently nothing happens")
      return t(`カメラを使えませんでした: ${o.reason}`, `Could not use the camera: ${o.reason}`)
  }
}

/** ⚠️ **Only the used parts** of the real `MediaStreamTrack` / `<video>` (can be faked in tests) */
export interface TrackLike {
  stop: () => void
}
export interface StreamLike {
  getTracks: () => readonly TrackLike[]
}
export interface VideoLike {
  srcObject: unknown
  play: () => Promise<unknown>
}

/** ★ Shape of the built-in reader (`BarcodeDetector`) */
export type DetectorCtor = new (o: unknown) => { detect: (s: unknown) => Promise<{ rawValue?: string }[]> }

/**
 * ★ Browser ports needed to open the camera. ⚠️ **Only this touches `globalThis`**
 *   (= `openCamera` itself can be exercised from Node / docs/VERIFY.md "a lenient fake gives a false green").
 */
export interface CameraEnv {
  readonly getUserMedia: (constraints: unknown) => Promise<StreamLike>
  /** ⚠️ Some devices lack it (iOS Safari) ⇒ decode ourselves via `grabFrame` */
  readonly BarcodeDetector?: DetectorCtor
  /** ★ Turn the current video frame into pixels (⚠️ undefined if nothing is showing yet) */
  readonly grabFrame: (video: VideoLike) => RgbaImage | undefined
}

/**
 * ★ Frame size (long side) when decoding ourselves. ⚠️ Larger reads more distant QRs but is slower
 *   (about 25ms at 640×480 on a PC = a size that fits the 200ms interval even on iPhone).
 */
export const FRAME_MAX_SIDE = 960

/** ⚠️ Call only once known to be available (`canScan`). Throws where it is absent */
export function cameraEnv(): CameraEnv {
  const g = globalThis as unknown as { BarcodeDetector?: DetectorCtor }
  let canvas: HTMLCanvasElement | undefined
  return {
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c as MediaStreamConstraints),
    ...(typeof g.BarcodeDetector === 'function' ? { BarcodeDetector: g.BarcodeDetector } : {}),
    grabFrame: (v) => {
      const video = v as unknown as HTMLVideoElement
      const vw = video.videoWidth
      const vh = video.videoHeight
      if (!vw || !vh) return undefined
      const k = Math.min(1, FRAME_MAX_SIDE / Math.max(vw, vh))
      const w = Math.round(vw * k)
      const h = Math.round(vh * k)
      canvas ??= document.createElement('canvas')
      if (canvas.width !== w) canvas.width = w
      if (canvas.height !== h) canvas.height = h
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return undefined
      ctx.drawImage(video, 0, 0, w, h)
      return ctx.getImageData(0, 0, w, h)
    },
  }
}

/**
 * ★★ Open the real camera.
 *
 * ⚠️⚠️ **`stop()` cleans up everything** (stops the video track = the camera light goes off).
 * ⚠️⚠️ **If something fails after grabbing, stop right there** (codex round 7, medium #6).
 *    If `BarcodeDetector` throws after `getUserMedia` succeeded,
 *    **the exception propagates with the camera grabbed** = the light stays on and nobody can stop it.
 * ⚠️ `facingMode: 'environment'` is **a preference** (devices without one get the front camera; not refused).
 * ⚠️ It throws only when it "could not open" (including permission denial). The caller turns it into text.
 */
// ⚠️⚠️ `claim` is **required** (if it could be omitted, "forgetting to pass it" silently opens a window =
//    the same as writing "what the caller must be careful about" in prose / ARCHITECTURE §14.1.2.11 ②).
export async function openCamera(video: VideoLike, env: CameraEnv, claim: Claim): Promise<Scanner> {
  const stream = await env.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
  const stop = () => {
    for (const track of stream.getTracks()) track.stop()
    video.srcObject = null
  }
  // ★★ **Hand it over the moment it is grabbed** (⚠️⚠️ before `await video.play()` / codex round 8, medium #3).
  //   ⚠️ Moved after this, **nobody can stop the camera** while `play()` does not return
  //      (measured `stops:0 / active:true`).
  claim?.(stop)
  try {
    video.srcObject = stream
    // ⚠️ Without playback not a single frame can be taken (⚠️ reading is attempted even if it fails)
    await video.play().catch(() => {})
    if (env.BarcodeDetector) {
      const detector = new env.BarcodeDetector({ formats: ['qr_code'] })
      return {
        detect: async () => (await detector.detect(video)).map((b) => b.rawValue ?? ''),
        stop,
      }
    }
    // ★ No built-in (iOS Safari) ⇒ copy one frame and decode ourselves. ⚠️ Empty if unreadable (no throw = try next frame)
    return {
      detect: async () => {
        const frame = env.grabFrame(video)
        const text = frame ? decodeQrImage(frame) : undefined
        return text === undefined ? [] : [text]
      },
      stop,
    }
  } catch (err) {
    // ⚠️⚠️ Do not keep it grabbed
    stop()
    throw err
  }
}
