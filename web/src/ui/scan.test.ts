// ★★ Reading a QR with the camera (`web/src/ui/scan.ts` / 2026-09-16).
//
//   ★★ **Mutants killed by name** here:
//     ① not stopping the camera (⚠️⚠️ **the light stays on** = the scariest failure)
//     ② no timeout (loops forever and drains the battery)
//     ③ picking up anything besides `nyan://pair` (starts registration from an unrelated QR)
//     ④ checking "closed?" only once (keeps running after closing)
//     ⑤ swallowing read exceptions (silently nothing happens)
//     ⑥ `canScan` failing open (the button appears on unsupported devices)
//   ★★ **Mutants added in codex round 7 (medium #5, #6) on 2026-09-16**:
//     ⑦ **not checking "closed" after `await s.detect()`** (a late QR starts registration after closing)
//     ⑧ **counting the deadline inside the loop** (if `detect()` never returns it **never runs** = camera stays on)
//     ⑨ **opening twice** (flag set after `await` = a double tap grabs two)
//     ⑩ **`stop()` waiting for the loop's reply** (the light stays on after the screen goes away)
//     ⑪ **starting to run although closed mid-open**
//     ⑫ **`openCamera` not stopping tracks on a failure after grabbing** (the camera remains along with the exception)
//
//   ⚠️⚠️ **Build fakes around "what would happen for real", not "was it called"** (docs/VERIFY.md).
//     The previous version only counted **calls to `stop()`**, so **removing `track.stop()` left all 7 green**.
//     ⇒ Here we fake **a `MediaStream` of the same shape as the real one** (`getTracks()` returns tracks)
//        and check **whether the tracks stopped**.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildPairUrl } from '../../../shared/pairing.ts'
import { PUBKEY_BYTES, toBase64Url } from '../../../shared/crypto.ts'
import {
  canScan,
  cameraEnv,
  createScanController,
  isPairText,
  openCamera,
  scanForPairing,
  scanText,
  SCAN_DEADLINE_MS,
  SCAN_INTERVAL_MS,
  type CameraEnv,
  type StreamLike,
  type VideoLike,
  type ScanOptions,
  type Scanner,
  type ScanTimer,
} from './scan.ts'

const PAIR = buildPairUrl({
  agentPublicKey: toBase64Url(new Uint8Array(PUBKEY_BYTES).fill(3)),
  token: 'Xk2qP9vLzA-_0123456789abcdefghij',
  machine: 'PC-A',
})

/** ★ A fake camera returning frames in order (★ also counts stops) */
function camera(frames: readonly (readonly string[])[], fail?: string) {
  let at = 0
  const state = { stops: 0, reads: 0 }
  const s: Scanner = {
    detect: async () => {
      state.reads++
      if (fail) throw new Error(fail)
      return frames[at++] ?? []
    },
    stop: () => void state.stops++,
  }
  return { s, state }
}

/** ⚠️ The deadline **never fires by default** (only tests that want it fire it) */
function opts(over: Partial<ScanOptions> = {}): ScanOptions {
  return {
    wait: async () => {},
    expired: new Promise<void>(() => {}),
    stopped: () => false,
    ...over,
  }
}

/** ★ A deadline that can be fired by hand */
function deadline() {
  let fire!: () => void
  const expired = new Promise<void>((r) => {
    fire = r
  })
  return { expired, fire: () => fire() }
}

// ── scanForPairing ───────────────────────────────────────────────────────────

test('★★ returns what was read. ⚠️ Always stops the camera (①)', { timeout: 5000 }, async () => {
  const c = camera([[], ['https://example.com'], [PAIR]])
  const out = await scanForPairing(c.s, opts())
  assert.deepEqual(out, { kind: 'found', raw: PAIR })
  assert.equal(c.state.stops, 1, '⚠️⚠️ the camera was not stopped (light stays on)')
})

test('★★ picks up only pairing QRs (③)', { timeout: 5000 }, async () => {
  const c = camera([['https://example.com', 'WIFI:S:x;;'], ['nyan://other?x=1']])
  const d = deadline()
  // ⚠️ Deadline after reading two frames (= ends without picking anything up)
  const s: Scanner = {
    detect: async () => {
      const f = await c.s.detect()
      if (c.state.reads >= 2) d.fire()
      return f
    },
    stop: c.s.stop,
  }
  const out = await scanForPairing(s, opts({ expired: d.expired }))
  assert.equal(out.kind, 'timeout', '⚠️⚠️ tried to start registration from an unrelated QR')
  assert.equal(c.state.stops, 1)
})

test('★★ there is a timeout (② never loops forever)', { timeout: 5000 }, async () => {
  const c = camera([])
  const d = deadline()
  const s: Scanner = {
    detect: async () => {
      const f = await c.s.detect()
      if (c.state.reads >= 3) d.fire()
      return f
    },
    stop: c.s.stop,
  }
  // ⚠️⚠️ **The deadline is the only way out** (an implementation ignoring `expired` **never returns** here = fails by timeout)
  const out = await scanForPairing(s, opts({ expired: d.expired }))
  assert.equal(out.kind, 'timeout')
  assert.ok(c.state.reads <= 4, `read too many: ${c.state.reads}`)
  assert.equal(c.state.stops, 1)
})

test('★★ stops when closed (④ checked every time)', { timeout: 5000 }, async () => {
  const c = camera([[], [], [], [PAIR]])
  let closed = false
  const out = await scanForPairing(
    c.s,
    opts({
      // ⚠️ Close after the second frame (an implementation checking once would proceed to the QR)
      stopped: () => {
        if (c.state.reads >= 2) closed = true
        return closed
      },
    }),
  )
  assert.equal(out.kind, 'stopped', '⚠️⚠️ kept running after closing')
  assert.equal(c.state.stops, 1)
})

test('★★ a read failure returns a reason (⑤ never "silently nothing happens")', { timeout: 5000 }, async () => {
  const c = camera([], 'NotAllowedError')
  const out = await scanForPairing(c.s, opts())
  assert.equal(out.kind, 'error')
  assert.match(scanText(out), /NotAllowedError/)
  assert.equal(c.state.stops, 1, '⚠️ stops even on failure')
})

test('★★ closed **after** `await detect()`: no registration even if read (⑦ / codex round 7, medium #5)', { timeout: 5000 }, async () => {
  // ⚠️⚠️ What really happens: right after pressing "close", **a frame already in flight before the press** returns a QR.
  //    Without checking afterwards it becomes `found`, and **registration starts after closing**.
  let closed = false
  const state = { stops: 0 }
  const s: Scanner = {
    detect: async () => {
      closed = true // ⚠️ closed **during** this frame
      return [PAIR]
    },
    stop: () => void state.stops++,
  }
  const out = await scanForPairing(s, opts({ stopped: () => closed }))
  assert.equal(out.kind, 'stopped', '⚠️⚠️ started registration from a QR that arrived after closing')
  assert.equal(state.stops, 1)
})

test('★★ even if `detect()` never returns, the deadline gets out and stops the camera (⑧ / codex round 7, medium #5)', { timeout: 5000 }, async () => {
  // ⚠️⚠️ With "count the deadline inside the loop" this **never returns** (= never reaches `finally` = light stays on).
  const state = { stops: 0 }
  const s: Scanner = {
    detect: () => new Promise<readonly string[]>(() => {}),
    stop: () => void state.stops++,
  }
  const d = deadline()
  const p = scanForPairing(s, opts({ expired: d.expired }))
  d.fire()
  const out = await p
  assert.equal(out.kind, 'timeout')
  assert.equal(state.stops, 1, '⚠️⚠️ camera stays grabbed by a read that never returns')
})

test('★★ if the deadline fires "while waiting for the interval", no further frame is read (⑧b / no camera use past the deadline)', { timeout: 5000 }, async () => {
  // ⚠️⚠️ Checking only at the loop head **calls `detect()` once more after the deadline**
  //    (= uses the camera past the deadline). Counting calls is the only way to tell.
  const d = deadline()
  const state = { reads: 0, stops: 0 }
  const s: Scanner = {
    detect: async () => {
      state.reads++
      return []
    },
    stop: () => void state.stops++,
  }
  const out = await scanForPairing(
    s,
    opts({
      expired: d.expired,
      // ⚠️ The deadline fired **while** waiting
      wait: async () => void d.fire(),
    }),
  )
  assert.equal(out.kind, 'timeout')
  assert.equal(state.reads, 1, '⚠️⚠️ read another frame after the deadline')
  assert.equal(state.stops, 1)
})

test('★★ an abandoned read failing later does not become an unhandled rejection', { timeout: 5000 }, async () => {
  let reject!: (e: unknown) => void
  const s: Scanner = {
    detect: () => new Promise<readonly string[]>((_, r) => void (reject = r)),
    stop: () => {},
  }
  const d = deadline()
  const p = scanForPairing(s, opts({ expired: d.expired }))
  d.fire()
  assert.equal((await p).kind, 'timeout')
  // ⚠️ Fails after being abandoned (unless `settle` absorbed it first, it becomes an unhandledRejection)
  reject(new Error('late'))
  await new Promise((r) => setTimeout(r, 10))
})

// ── ScanController (camera lifetime) ───────────────────────────────────────────

/** ★ A fake `setTimeout` that controls time. ⚠️ **Intervals fire immediately / the deadline is fired by hand** */
function fakeTimer() {
  const registered: { ms: number; fn: () => void; cancelled: boolean }[] = []
  const timer: ScanTimer = (ms, fn) => {
    const e = { ms, fn, cancelled: false }
    registered.push(e)
    if (ms <= SCAN_INTERVAL_MS) {
      queueMicrotask(() => {
        if (!e.cancelled) e.fn()
      })
    }
    return () => void (e.cancelled = true)
  }
  const long = () => registered.find((e) => e.ms > SCAN_INTERVAL_MS)
  return {
    timer,
    registered,
    deadlineMs: () => long()?.ms,
    fire: () => {
      const d = long()
      if (d && !d.cancelled) d.fn()
    },
    deadlineCancelled: () => long()?.cancelled === true,
  }
}

/**
 * ★ Inputs fed to the real `openCamera` (⚠️ **the controller tests go through here too**).
 *
 * ⚠️⚠️ The controller used to receive **an arbitrary opener**, so none of the controller tests
 *    looked at how `openCamera` itself behaves (whether it calls `claim`)
 *    (codex round 9: removing `if (cancelled) r()` inside `claim` left all 26 green).
 */
function cam(
  frames: readonly (readonly string[])[] = [],
  o: { grab?: Promise<void>; play?: Promise<void>; failOpen?: string } = {},
) {
  const state = { stops: 0, reads: 0 }
  const stream: StreamLike = {
    getTracks: () => [{ stop: () => void state.stops++ }],
  }
  let at = 0
  const video: VideoLike = {
    srcObject: null,
    play: async () => {
      if (o.play) await o.play
    },
  }
  const env: CameraEnv = {
    getUserMedia: async () => {
      if (o.failOpen) throw new Error(o.failOpen)
      if (o.grab) await o.grab
      return stream
    },
    BarcodeDetector: class {
      async detect() {
        state.reads++
        return (frames[at++] ?? []).map((rawValue) => ({ rawValue }))
      }
    } as unknown as CameraEnv['BarcodeDetector'],
    grabFrame: () => undefined,
  }
  return { video, env, state }
}

test('★★ does not open twice (⑨ flag before `await` / codex round 7, medium #6)', { timeout: 5000 }, async () => {
  const t = fakeTimer()
  const ctl = createScanController(t.timer)
  let opened = 0
  const c = cam([], { grab: new Promise<void>(() => {}) })
  const env: CameraEnv = {
    ...c.env,
    getUserMedia: async (x) => {
      opened++
      return c.env.getUserMedia(x)
    },
  }
  const first = ctl.run({ video: c.video, env })
  // ⚠️⚠️ Call a second time **without an intervening `await`** (= a double tap)
  const second = await ctl.run({ video: c.video, env })
  assert.deepEqual(second, { kind: 'busy' }, '⚠️⚠️ tried to open a second camera')
  assert.equal(opened, 1, '⚠️⚠️ tried to grab two cameras')
  t.fire()
  assert.equal((await first).kind, 'timeout')
})

test('★★ `stop()` stops the camera without waiting for the loop\'s reply (⑩ unmount / codex round 7, medium #6)', { timeout: 5000 }, async () => {
  const t = fakeTimer()
  const ctl = createScanController(t.timer)
  // ⚠️ **Playback never returns** (grabbed but the `Scanner` is never built = the round 8 medium #3 shape)
  const c = cam([], { play: new Promise<void>(() => {}) })
  const run = ctl.run({ video: c.video, env: c.env })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(ctl.active(), true)

  ctl.stop() // ⚠️⚠️ the screen went away (unmount)
  assert.equal(c.state.stops, 1, '⚠️⚠️ the camera stays on after the screen went away')

  t.fire()
  assert.equal((await run).kind, 'timeout')
  assert.equal(ctl.active(), false)
})

test('★★ the deadline alone stops the camera (⚠️ when nobody closed it / codex round 8, medium #3)', { timeout: 5000 }, async () => {
  const t = fakeTimer()
  const ctl = createScanController(t.timer)
  const c = cam([], { play: new Promise<void>(() => {}) })
  const run = ctl.run({ video: c.video, env: c.env })
  await new Promise((r) => setTimeout(r, 0))
  t.fire()
  assert.equal((await run).kind, 'timeout')
  assert.equal(c.state.stops, 1, '⚠️⚠️ the camera stays on after the deadline')
})

test('★★ an old run ended by deadline does not overwrite the next camera\'s stop target (codex round 9, medium #2)', { timeout: 5000 }, async () => {
  // ⚠️⚠️ **Exactly codex's repro**: A's deadline expires before it grabs → B runs → **A grabs late**.
  //    Back when the flag and stopper were shared across runs, A's `claim` overwrote B's stop target,
  //    and since B had reset `cancelled=false`, **A did not stop either**.
  //    Measured: after stop() A.stop=1 / B.stop=0; after B's deadline A.stop=2 / **B.stop=0**
  const t = fakeTimer()
  const ctl = createScanController(t.timer)
  let letA: (() => void) | undefined
  const a = cam([], { grab: new Promise<void>((r) => void (letA = r)) })
  const runA = ctl.run({ video: a.video, env: a.env })
  await new Promise((r) => setTimeout(r, 0))

  // ① A expires before grabbing
  t.fire()
  assert.equal((await runA).kind, 'timeout')
  assert.equal(ctl.active(), false)

  // ② B runs (★ this one grabs and waits for playback)
  const t2 = fakeTimer()
  const ctl2 = ctl // ⚠️ same controller (only the run differs)
  void t2
  const b = cam([], { play: new Promise<void>(() => {}) })
  const runB = ctl2.run({ video: b.video, env: b.env })
  await new Promise((r) => setTimeout(r, 0))

  // ③ A's grab succeeds late (⚠️ it must not steal B's stop target here)
  letA?.()
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(a.state.stops, 1, '⚠️ a camera grabbed by a finished run must stop on the spot')

  // ④ Close B = **B's camera must stop**
  ctl2.stop()
  assert.equal(b.state.stops, 1, '⚠️⚠️ the next run\'s camera does not stop (its stop target was overwritten)')
})

test('★★ the deadline is `SCAN_DEADLINE_MS`. ⚠️ Cancelled when done (no leftover timer)', { timeout: 5000 }, async () => {
  const t = fakeTimer()
  const ctl = createScanController(t.timer)
  const c = cam([[PAIR]])
  const out = await ctl.run({ video: c.video, env: c.env })
  assert.equal(out.kind, 'found')
  assert.equal(t.deadlineMs(), SCAN_DEADLINE_MS, '⚠️ the deadline was not passed')
  assert.equal(t.deadlineCancelled(), true, '⚠️ the deadline timer remains after reading')
  assert.equal(ctl.active(), false)
  assert.equal(c.state.stops, 1, '⚠️ the camera stops once read')
})

test('★★ failure to open returns a reason (⚠️ no exception / permission denied)', { timeout: 5000 }, async () => {
  const t = fakeTimer()
  const ctl = createScanController(t.timer)
  const c = cam([], { failOpen: 'NotAllowedError' })
  const out = await ctl.run({ video: c.video, env: c.env })
  assert.equal(out.kind, 'error')
  assert.match(scanText(out), /NotAllowedError/)
  assert.equal(ctl.active(), false, '⚠️ still "running" after the failure')
})

test('★★ can open again after stopping (⚠️ `stop()` does not block the next one)', { timeout: 5000 }, async () => {
  const t = fakeTimer()
  const ctl = createScanController(t.timer)
  ctl.stop() // ⚠️ pressed while not running
  const c = cam([[PAIR]])
  assert.equal((await ctl.run({ video: c.video, env: c.env })).kind, 'found')
})

// ── openCamera (★ exercised with a fake shaped like the real thing) ────────────────────────────────

/** ★ Same shape as the real `MediaStream` (⚠️ `getTracks()` returns **a new array every time**) */
function fakeStream(n = 2) {
  const stopped = new Array<number>(n).fill(0)
  return {
    stopped,
    stream: { getTracks: () => stopped.map((_, i) => ({ stop: () => void (stopped[i] = (stopped[i] ?? 0) + 1) })) },
  }
}

function fakeVideo() {
  return { srcObject: null as unknown, play: async () => {}, plays: 0 }
}

function env(over: Partial<CameraEnv> = {}, st = fakeStream()): CameraEnv {
  return {
    getUserMedia: async () => st.stream,
    BarcodeDetector: class {
      async detect() {
        return [{ rawValue: PAIR }, {}]
      }
    } as unknown as CameraEnv['BarcodeDetector'],
    grabFrame: () => undefined,
    ...over,
  }
}

test('★★ `stop()` stops **every track** (① the core / ⚠️ removing it fails here)', { timeout: 5000 }, async () => {
  const st = fakeStream(3)
  const v = fakeVideo()
  const s = await openCamera(v, env({}, st), () => {})
  assert.equal(v.srcObject, st.stream, 'the video is not attached')
  assert.deepEqual(await s.detect(), [PAIR, ''], '⚠️ unreadable values become empty strings')
  s.stop()
  assert.deepEqual(st.stopped, [1, 1, 1], '⚠️⚠️ tracks were not stopped (camera light stays on)')
  assert.equal(v.srcObject, null, '⚠️ the video was not detached')
})

test('★★ a failure after grabbing stops right there, then throws (⑫ / codex round 7, medium #6)', { timeout: 5000 }, async () => {
  const st = fakeStream(2)
  const v = fakeVideo()
  await assert.rejects(
    () =>
      openCamera(
        v,
        env(
          {
            BarcodeDetector: class {
              constructor() {
                throw new Error('unsupported')
              }
            } as unknown as CameraEnv['BarcodeDetector'],
          },
          st,
        ),
        () => {},
      ),
    /unsupported/,
  )
  assert.deepEqual(st.stopped, [1, 1], '⚠️⚠️ left the camera grabbed along with the exception')
  assert.equal(v.srcObject, null)
})

test('★★ if `getUserMedia` is refused, there is nothing grabbed, so it just throws', { timeout: 5000 }, async () => {
  const v = fakeVideo()
  await assert.rejects(
    () =>
      openCamera(
        v,
        env({
          getUserMedia: async () => {
            throw new Error('NotAllowedError')
          },
        }),
        () => {},
      ),
    /NotAllowedError/,
  )
  assert.equal(v.srcObject, null)
})

test('★★ reading is attempted even if playback does not start (⚠️ do not give up on a `play()` failure)', { timeout: 5000 }, async () => {
  const st = fakeStream(1)
  const v = { srcObject: null as unknown, play: async () => void (() => { throw new Error('x') })() }
  const s = await openCamera(v, env({}, st), () => {})
  assert.deepEqual(await s.detect(), [PAIR, ''])
  s.stop()
  assert.deepEqual(st.stopped, [1])
})

test('★★ `cameraEnv()` takes from `globalThis` (⚠️ only this touches the browser)', () => {
  const before = (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector
  class Fake {}
  ;(globalThis as { BarcodeDetector?: unknown }).BarcodeDetector = Fake
  try {
    assert.equal(cameraEnv().BarcodeDetector, Fake as unknown)
  } finally {
    if (before === undefined) delete (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector
    else (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector = before
  }
})

// ── Device detection and strings ─────────────────────────────────────────────────────

test('★★ no button on devices that cannot use it (⑥ fail-closed)', () => {
  const ok = { BarcodeDetector: class {}, navigator: { mediaDevices: { getUserMedia: () => {} } } }
  assert.equal(canScan(ok), true)
  // ★ iOS Safari (no `BarcodeDetector`) ⇒ copy to a canvas and decode ourselves (2026-09-24)
  assert.equal(canScan({ navigator: { mediaDevices: { getUserMedia: () => {} } }, document: { createElement: () => {} } }), true)
  // ⚠️ Neither built-in nor canvas ⇒ no way to read
  assert.equal(canScan({ navigator: { mediaDevices: { getUserMedia: () => {} } } }), false)
  // ⚠️ Opened over http (`getUserMedia` does not exist)
  assert.equal(canScan({ BarcodeDetector: class {}, navigator: {} }), false)
  assert.equal(canScan(undefined), false)
  assert.equal(canScan({}), false)
})

test('★★ recognising pairing strings (⚠️ prefix matching must not let `nyan://pairx` through)', () => {
  assert.equal(isPairText(PAIR), true)
  assert.equal(isPairText('nyan://pairx?v=1'), false)
  assert.equal(isPairText('nyan://pair'), false, 'strings without a query are not read')
  assert.equal(isPairText('https://nyan://pair?x'), false)
  assert.equal(isPairText(undefined), false)
})

test('★★ text in one place (⚠️ adding a kind always yields text = never silent)', () => {
  const kinds = ['found', 'timeout', 'stopped', 'error', 'busy'] as const
  for (const kind of kinds) {
    const text = scanText(kind === 'error' ? { kind, reason: 'x' } : kind === 'found' ? { kind, raw: PAIR } : { kind })
    assert.ok(text.length > 0, `no text for ${kind}`)
  }
})

test('★★ `openCamera` hands over the stopper **before `play()`** (the core of codex round 8, medium #3)', { timeout: 5000 }, async () => {
  // ⚠️⚠️ If this comes after `play()`, **a window opens where it is grabbed but nobody can stop it**.
  //    ⇒ The controller tests above use their own opener, so **only this check
  //      looks at `openCamera`'s own order** (= removing it slipped through / measured).
  const st = fakeStream(2)
  let released: (() => void) | undefined
  let playing = false
  const video = {
    srcObject: null as unknown,
    play: async () => {
      playing = true
      // ⚠️ Playback does not start (happens routinely on real devices)
      await new Promise<void>(() => {})
    },
  }
  const opening = openCamera(video, env({}, st), (stop) => void (released = stop))
  // ⚠️ Still inside `play()` without returning (= this moment is the problematic window)
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(playing, true, 'did not reach play() (the precondition broke)')

  assert.ok(released, '⚠️⚠️ the stopper was not handed over while waiting on `play()`')
  released()
  assert.deepEqual(st.stopped, [1, 1], '⚠️⚠️ the handed-over stopper does not stop the tracks')
  assert.equal(video.srcObject, null)
  void opening
})

test('★★ on devices without `BarcodeDetector` (iPhone), copy one frame and decode ourselves', { timeout: 10000 }, async () => {
  const { makeQr } = await import('../../../shared/qr.ts')
  const q = makeQr(PAIR)!
  // ★ A straight-on frame (5 pixels per module, margin 4)
  const scale = 5
  const side = (q.size + 8) * scale
  const data = new Uint8ClampedArray(side * side * 4)
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const mx = Math.floor(x / scale) - 4
      const my = Math.floor(y / scale) - 4
      const v = mx >= 0 && my >= 0 && mx < q.size && my < q.size && q.modules[my]![mx] ? 10 : 240
      data.set([v, v, v, 255], (y * side + x) * 4)
    }
  }
  let grabs = 0
  const frames = [undefined, { data, width: side, height: side }]
  const { BarcodeDetector: _unused, ...noDetector } = env()
  const s = await openCamera(fakeVideo(), { ...noDetector, grabFrame: () => frames[grabs++] }, () => {})
  // ⚠️ Nothing showing yet ⇒ empty (no throw). Readable on the next frame
  assert.deepEqual(await s.detect(), [])
  assert.deepEqual(await s.detect(), [PAIR])
  s.stop()
})
