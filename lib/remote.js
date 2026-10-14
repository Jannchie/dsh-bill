/**
 * The spend stream: account-wide spend pushed to the browser over the Remote
 * stream socket the client already holds open, instead of polled over HTTP.
 *
 * The per-session figures already arrive this way — `billTurns` is a session
 * projection the framework pushes. The account-wide ones (today / this month /
 * all time, read by the sidebar line and the budget bar) belong to no session,
 * so no projection can carry them, and they were polled every few seconds by
 * every mounted surface of every open window. This stream carries them
 * instead: one logical stream per window, multiplexed on the Gateway's
 * `/api/remote.mux` WebSocket, that yields the current figures on open and
 * again only when the ring changes or the local day turns over.
 *
 * It is an ordinary Typert Remote. The Host half is a Cordis Service carrying
 * a `typertRemote` binding and one `@Remote({ mode: 'stream' })` method, which
 * the Gateway resolves through its source-mode discovery — no generated
 * definition is needed for a method whose only parameter is its cancellation
 * signal. The Client half is the matching descriptor below, mounted with
 * `ctx.remote.$mount()`; with no Client-supplied fields it needs no codec
 * either. Both are written by hand because this package has no build step.
 *
 * @module dsh-bill/remote
 */

/** Cordis service key, and the Remote namespace the browser calls. */
export const SPEND_REMOTE_SERVICE = 'dshBill'

/** The stream method: `dshBill/watch`. */
export const SPEND_REMOTE_METHOD = 'watch'

/**
 * The Client contribution for `ctx.remote.$mount()`: the same shape the Typert
 * generator emits, for one stream method that takes nothing but its signal and
 * yields JSON (`src-json`, which the Gateway passes through unchecked).
 */
export const SPEND_REMOTE_CONTRIBUTION = {
  package: 'dsh-bill',
  descriptors: [{
    id: `dsh-bill#${SPEND_REMOTE_SERVICE}/${SPEND_REMOTE_METHOD}`,
    service: SPEND_REMOTE_SERVICE,
    namespace: SPEND_REMOTE_SERVICE,
    method: SPEND_REMOTE_METHOD,
    mode: 'stream',
    invocation: { kind: 'direct' },
    parameters: [],
    cancellation: { parameter: 'signal' },
    result: { mode: 'src-json' },
  }],
}

/**
 * Build the Host Service class over the harness's own Typert protocol module.
 *
 * The protocol package is the harness's, not a dependency of this one, so it
 * is handed in (see hostkit.js) rather than imported. `Remote` is a standard
 * method decorator; plain JavaScript has no decorator syntax, so it is applied
 * here the way a compiler would — called once with the method and a decorator
 * context, its initializer run by each instance's constructor.
 *
 * @param {{ Remote: Function, TypertRemoteService: Function }} protocol - `@deepseek-ai/dsh-typert-protocol`.
 * @param {(signal: AbortSignal) => AsyncIterable<object>} watch - the stream body.
 * @returns {Function} a Cordis plugin class registering the `dshBill` Service.
 */
export function spendRemoteService(protocol, watch) {
  const { Remote, TypertRemoteService } = protocol
  const initializers = []
  class SpendRemote extends TypertRemoteService {
    constructor(ctx) {
      super(ctx, SPEND_REMOTE_SERVICE)
      for (const init of initializers) init.call(this)
    }

    // The Gateway reads parameter names from this source text: `signal`, last,
    // is the cancellation parameter, and nothing else crosses the wire.
    watch(signal) {
      return watch(signal)
    }
  }
  Remote({ mode: 'stream' })(SpendRemote.prototype.watch, {
    kind: 'method',
    name: SPEND_REMOTE_METHOD,
    static: false,
    private: false,
    addInitializer: (init) => { initializers.push(init) },
  })
  return SpendRemote
}

/** Least time between two items of one spend stream, so a burst of calls is one frame. */
export const SPEND_MIN_GAP_MS = 1000

/**
 * The stream body: an item on open, then one whenever the state's key moves,
 * no more often than `minGapMs`. Each subscriber gets its own iteration; the
 * Gateway aborts `signal` when the browser cancels or the socket goes.
 *
 * @param {object} source
 * @param {() => Promise<unknown>} source.ready - awaited before the first item.
 * @param {(now: Date) => string} source.key - identity of the current state.
 * @param {(key: string) => object} source.snapshot - the item for that state.
 * @param {(wake: () => void) => () => void} source.subscribe - wake on change; returns unsubscribe.
 * @param {number} [source.minGapMs]
 * @returns {(signal: AbortSignal) => AsyncGenerator<object>}
 */
export function spendWatch({ ready, key, snapshot, subscribe, minGapMs = SPEND_MIN_GAP_MS }) {
  return async function* watch(signal) {
    await ready()
    let sent = null
    while (!signal.aborted) {
      const now = new Date()
      const current = key(now)
      if (current !== sent) {
        sent = current
        yield snapshot(current)
        await pause(minGapMs, signal)
        continue
      }
      await nextChange(subscribe, signal, now)
    }
  }
}

/**
 * Resolve when `changed()` reports a change, the local day turns over, or the
 * signal aborts — whichever is first. `subscribe(wake)` must return its own
 * unsubscribe.
 */
export function nextChange(subscribe, signal, now = new Date()) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    // +1 s so the wake lands on the new day rather than on the old one's last tick.
    const timer = setTimeout(done, Math.max(1000, midnight - now + 1000))
    const unsubscribe = subscribe(done)
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      unsubscribe()
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

/** Sleep `ms`, cut short by the signal. */
export function pause(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}
