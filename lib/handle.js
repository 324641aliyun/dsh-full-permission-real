/**
 * A `ShellExecution`-compatible handle for one elevated command.
 *
 * DSH's `ctx.shell` seam is duck-typed from the consumer side: `dsh-tool-pwsh`
 * and `ctx.jobs` only call `status`/`exitCode`/`signal`/`done`/`readOutput()`
 * /`observed.*.readFrom()`/`kill()`/`result()`. Implementing that surface
 * locally keeps this bundle free of `@deepseek-ai/*` imports, which a
 * profile-installed plugin cannot resolve (the shipped packages are not in the
 * profile's `node_modules`).
 *
 * Offsets are whole-stream byte coordinates. Chunks are kept as decoded text
 * with their byte range; callers always read at a previously returned
 * `nextOffset`, so chunk-aligned reads are exact.
 */

import { StringDecoder } from 'node:string_decoder'

import { DEFAULT_MAX_STDERR_BYTES, DEFAULT_MAX_STDOUT_BYTES } from './constants.js'

/** One captured stream with a bounded in-memory tail. */
class CapturedStream {
  constructor(limit) {
    this.limit = Math.max(1_024, limit)
    this.decoder = new StringDecoder('utf8')
    this.chunks = []
    /** Whole-stream offset of the oldest byte still retained. */
    this.base = 0
    /** Whole-stream byte count received so far. */
    this.total = 0
  }

  push(buffer) {
    const start = this.total
    this.total += buffer.length
    const text = this.decoder.write(buffer)
    if (text.length > 0) this.chunks.push({ start, end: this.total, text })
    this.trim()
  }

  end() {
    const text = this.decoder.end()
    if (text.length > 0) this.chunks.push({ start: this.total, end: this.total, text })
  }

  trim() {
    while (this.chunks.length > 0 && this.total - this.chunks[0].start > this.limit) {
      const dropped = this.chunks.shift()
      this.base = dropped.end
    }
    if (this.chunks.length === 0) this.base = this.total
  }

  /** @returns {{text: string, nextOffset: number, lossy: boolean}} */
  readFrom(fromByte) {
    const offset = Number.isFinite(fromByte) ? Math.max(0, fromByte) : 0
    if (offset >= this.total) return { text: '', nextOffset: this.total, lossy: false }
    const lossy = offset < this.base
    const text = this.chunks
      .filter((chunk) => chunk.end > offset)
      .map((chunk) => chunk.text)
      .join('')
    return { text, nextOffset: this.total, lossy }
  }

  /** All retained text (the tail when truncated). */
  tailText() {
    return this.chunks.map((chunk) => chunk.text).join('')
  }

  get truncated() {
    return this.base > 0
  }
}

/**
 * The handle returned from the patched `ctx.shell.execute` for an elevated
 * command. One instance per command; settlement is exactly once.
 */
export class ElevatedHandle {
  /**
   * @param spec - the resolved `ShellExecSpec`.
   * @param options - collector budgets.
   */
  constructor(spec, options = {}) {
    this.spec = spec
    this.stdout = new CapturedStream(options.stdoutMaxBytes ?? spec.stdoutMaxBytes ?? DEFAULT_MAX_STDOUT_BYTES)
    this.stderr = new CapturedStream(options.stderrMaxBytes ?? DEFAULT_MAX_STDERR_BYTES)

    this.status = 'running'
    this.exitCode = null
    this.signal = null
    this.timedOut = false
    this.aborted = false
    this.started = false
    this.pid = null
    /** The dead code reported by DSH's sandbox vocabulary; elevated commands are unconfined. */
    this.sandbox = { mode: 'danger-full-access', denied: false }

    this.failure = null
    this._killer = null
    this._result = null
    this._streamsEnded = false
    this.cursors = { stdout: 0, stderr: 0 }

    this.done = new Promise((resolve) => {
      this._resolveDone = resolve
    })
    this.observed = {
      stdout: { readFrom: (offset) => this.stdout.readFrom(offset) },
      stderr: { readFrom: (offset) => this.stderr.readFrom(offset) },
    }
  }

  /** Install the provider's termination routine (kills the process tree). */
  setKiller(kill) {
    this._killer = typeof kill === 'function' ? kill : null
  }

  pushStdout(buffer) {
    if (this.status !== 'running' || this._streamsEnded) return
    this.stdout.push(buffer)
  }

  pushStderr(buffer) {
    if (this.status !== 'running' || this._streamsEnded) return
    this.stderr.push(buffer)
  }

  markStarted(pid) {
    this.started = true
    if (Number.isFinite(pid)) this.pid = pid
  }

  markTimedOut() {
    this.timedOut = true
  }

  markAborted() {
    this.aborted = true
  }

  /** The process closed on its own (or through kill()). */
  settle(outcome = {}) {
    if (this.status !== 'running') return
    this._finishStreams()
    this.status = this.killed ? 'killed' : 'completed'
    this.exitCode = Number.isInteger(outcome.exitCode) ? outcome.exitCode : null
    this.signal = outcome.signal ?? null
    this._resolveDone()
  }

  /** The provider could not start or the channel failed. `result()` rejects. */
  fail(error) {
    if (this.status !== 'running') return
    this._finishStreams()
    this.status = 'killed'
    this.failure = error instanceof Error ? error : new Error(String(error))
    this._resolveDone()
  }

  _finishStreams() {
    if (this._streamsEnded) return
    this._streamsEnded = true
    this.stdout.end()
    this.stderr.end()
  }

  /** Consuming read: new stdout followed by a marked stderr section. */
  readOutput() {
    const stdout = this.stdout.readFrom(this.cursors.stdout)
    const stderr = this.stderr.readFrom(this.cursors.stderr)
    this.cursors.stdout = stdout.nextOffset
    this.cursors.stderr = stderr.nextOffset
    let delta = stdout.text
    if (stderr.text.length > 0) {
      const separator = delta.length > 0 && !delta.endsWith('\n') ? '\n' : ''
      delta += `${separator}[stderr]\n${stderr.text}`
    }
    return { delta, lossy: stdout.lossy || stderr.lossy }
  }

  /** Terminate the command. Returns false once it already finished. */
  kill() {
    if (this.status !== 'running') return false
    this.killed = true
    try {
      this._killer?.()
    } catch {
      /* termination is best-effort; settlement still arrives through close/exit */
    }
    return true
  }

  /** Foreground projection; rejects only for infrastructure failures. */
  result() {
    if (this._result !== null) return this._result
    this._result = (async () => {
      await this.done
      if (this.failure !== null) throw this.failure
      return {
        exitCode: this.exitCode,
        signal: this.signal,
        timedOut: this.timedOut,
        aborted: this.aborted,
        timeoutMs: this.spec.timeoutMs,
        stdout: { text: this.stdout.tailText(), truncated: this.stdout.truncated },
        stderr: { text: this.stderr.tailText(), truncated: this.stderr.truncated },
        sandbox: { ...this.sandbox },
      }
    })()
    return this._result
  }
}

/**
 * Wire the spec's deadline and cancellation onto a handle.
 * @param handle - the elevated handle to settle.
 * @param spec - the resolved spec whose signal and deadline apply.
 * @returns a disposer clearing timers/listeners.
 */
export function wireCancellation(handle, spec) {
  const cleanups = []
  if (spec.onExpiry === 'kill' && Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0) {
    const timer = setTimeout(() => {
      if (handle.status !== 'running') return
      handle.markTimedOut()
      handle.kill()
    }, spec.timeoutMs)
    timer.unref?.()
    cleanups.push(() => clearTimeout(timer))
  }
  if (spec.signal !== undefined && spec.signal !== null) {
    const signal = spec.signal
    const onAbort = () => {
      if (handle.status !== 'running') return
      handle.markAborted()
      handle.kill()
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    cleanups.push(() => signal.removeEventListener('abort', onAbort))
  }
  void handle.done.then(() => {
    for (const cleanup of cleanups) {
      try {
        cleanup()
      } catch {
        /* ignore */
      }
    }
  })
  return () => {
    for (const cleanup of cleanups) {
      try {
        cleanup()
      } catch {
        /* ignore */
      }
    }
  }
}
