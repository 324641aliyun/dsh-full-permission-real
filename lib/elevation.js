/**
 * Elevated execution channel for the `full-access-real` permission mode.
 *
 * Two providers implement the same contract:
 *
 * - `direct`: this DSH process already holds an elevated administrator token
 *   (the normal case when the Harness itself was started as administrator), so
 *   every command is spawned as a real `powershell.exe -EncodedCommand` child
 *   that inherits that token. There is no UAC prompt and no broker process.
 * - `broker`: the Harness runs with a filtered token. One real UAC elevation
 *   launches a small elevated Node host (`broker-host.js`) that stays alive
 *   for this Harness process and spawns real administrator PowerShell children
 *   on demand. Every later command is silent: no UAC, no approval request.
 *
 * Both providers return an {@link ElevatedHandle}, so `dsh-tool-pwsh`,
 * `ctx.jobs`, and the psh bridge consume them exactly like the shipped local
 * executor's process handles.
 */

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BROKER_PROTOCOL_VERSION, PS_PREAMBLE } from './constants.js'
import { ElevatedHandle, wireCancellation } from './handle.js'

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const BROKER_HOST_PATH = path.join(MODULE_DIR, 'broker-host.js')
const LAUNCHER_PATH = path.join(MODULE_DIR, 'launcher.ps1')
const TEMP_ROOT = path.join(os.tmpdir(), 'dsh-full-permission-real')

/** Errors that explain why elevation is unavailable, with a stable code. */
export class ElevationError extends Error {
  constructor(message, code = 'ELEVATION_UNAVAILABLE') {
    super(message)
    this.name = 'ElevationError'
    this.code = code
  }
}

/**
 * Build the PowerShell argv for one command.
 *
 * This mirrors the shipped `dsh-pwsh-local` executor: the command travels as
 * one `-Command` argument behind the UTF-8 preamble. `-EncodedCommand` was
 * tried first, but it makes Windows PowerShell 5.1 serialize the information
 * stream (Write-Host) as CLIXML noise on stderr; the plain `-Command` shape is
 * byte-compatible with the shipped executor.
 */
export function buildPowerShellArgv(shell, command) {
  return [shell, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${PS_PREAMBLE}${command}`]
}

/** Kill a process tree; tolerates an already-dead process. */
export function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return
  try {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    killer.on('error', () => {})
  } catch {
    /* already gone */
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Whether a pid is alive.
 *
 * `EPERM`/`EACCES` means the process exists but this token may not signal it —
 * exactly the normal case for a medium-integrity DSH host probing the elevated
 * broker. Treating that as "dead" would delete the discovery file and poll
 * forever.
 */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM' || error?.code === 'EACCES'
  }
}

/** Run a short blocking probe through `spawnSync`. */
function probeSync(shell, script, timeout = 20_000) {
  const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  })
  if (result.error !== undefined) return { ok: false, error: result.error }
  return { ok: result.status === 0, status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * The elevated runner shared by the patched `ctx.shell.execute` path and the
 * psh compatibility bridge.
 */
export class ElevatedRunner {
  /**
   * @param options.config - normalized plugin config ({@link import('./config.js').normalizeConfig}).
   * @param options.logger - optional DSH logger (`info`/`warn`/`debug`).
   * @param options.forceBroker - test hook: use the broker even when elevated.
   */
  constructor({ config, logger, forceBroker = false }) {
    this.config = config
    this.logger = logger ?? null
    this.forceBroker = forceBroker
    this.disposed = false

    this._probe = null
    this._shell = null
    this.broker = null
    this._brokerStarting = null
    this._brokerChild = null
    this.active = new Set()

    this.baseDir = path.join(TEMP_ROOT, `host-${process.pid}`)
    /** Last observed provider state, for the status tool. */
    this.state = { mode: 'unknown', reason: null, shell: null, hostElevated: null, user: null, psVersion: null }
  }

  log(level, message) {
    try {
      this.logger?.[level]?.(`[full-permission-real] ${message}`)
    } catch {
      /* logging must never break a command */
    }
  }

  /** Resolve the PowerShell executable to use, probing candidates once. */
  async resolveShell() {
    if (this._shell !== null) return this._shell
    const configured = this.config.shellPath.trim()
    const candidates = []
    if (configured.length > 0) candidates.push(configured)
    if (this.config.shell === 'powershell') candidates.push('powershell.exe')
    else if (this.config.shell === 'pwsh') candidates.push('pwsh.exe')
    else candidates.push('powershell.exe', 'pwsh.exe')

    for (const candidate of candidates) {
      const probe = probeSync(candidate, '$PSVersionTable.PSVersion.ToString()', 15_000)
      if (probe.ok) {
        this._shell = candidate
        this.state.shell = candidate
        return candidate
      }
      this.log('debug', `shell candidate unavailable: ${candidate}: ${probe.error?.message ?? probe.stderr?.split('\n')[0] ?? ''}`)
    }
    throw new ElevationError(
      `no PowerShell executable available (tried ${candidates.join(', ')}); configure powershellPath`,
      'POWERSHELL_UNAVAILABLE',
    )
  }

  /** Probe whether this Harness process already holds an elevated token. */
  async probeHost() {
    if (this._probe !== null) return this._probe
    this._probe = (async () => {
      const shell = await this.resolveShell()
      const script =
        '$id=[Security.Principal.WindowsIdentity]::GetCurrent();' +
        '$p=[Security.Principal.WindowsPrincipal]::new($id);' +
        '[pscustomobject]@{' +
        'user=$id.Name;' +
        'elevated=$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);' +
        'psVersion=$PSVersionTable.PSVersion.ToString();' +
        'pid=$PID' +
        '}|ConvertTo-Json -Compress'
      const probe = probeSync(shell, script)
      if (!probe.ok) {
        throw new ElevationError(`cannot probe the administrator token: ${probe.stderr.trim() || probe.error?.message || 'unknown error'}`, 'PROBE_FAILED')
      }
      let parsed
      try {
        parsed = JSON.parse(probe.stdout.trim())
      } catch {
        throw new ElevationError(`cannot parse the administrator-token probe: ${probe.stdout.slice(0, 200)}`, 'PROBE_FAILED')
      }
      const info = {
        elevated: parsed.elevated === true,
        user: String(parsed.user ?? ''),
        psVersion: String(parsed.psVersion ?? ''),
        pid: Number(parsed.pid) || null,
        shell,
      }
      this.state.hostElevated = info.elevated
      this.state.user = info.user
      this.state.psVersion = info.psVersion
      return info
    })()
    try {
      return await this._probe
    } catch (error) {
      this._probe = null
      throw error
    }
  }

  /** Decide and prepare the provider for the next run. */
  async ensureReady() {
    if (this.disposed) throw new ElevationError('the plugin is disposed', 'DISPOSED')
    const host = await this.probeHost()
    if (host.elevated && !this.forceBroker) {
      this.state.mode = 'direct'
      this.state.reason = null
      return { mode: 'direct', host }
    }
    if (this.config.elevation === 'never') {
      this.state.mode = 'broker'
      this.state.reason = 'elevation-required'
      throw new ElevationError(
        'this DSH process is not running as administrator and the row config sets elevation: never; ' +
          'start DSH as administrator or set elevation: auto to allow one UAC prompt',
        'ELEVATION_REQUIRED',
      )
    }
    const broker = await this.ensureBroker()
    this.state.mode = 'broker'
    this.state.reason = null
    return { mode: 'broker', broker }
  }

  // ------------------------------------------------------------------
  // Direct provider
  // ------------------------------------------------------------------

  /** Spawn one real administrator PowerShell child (the process is already elevated). */
  async startDirect(spec, host) {
    if (spec.signal?.aborted === true) throw spec.signal.reason ?? new Error('command aborted')
    const shell = host.shell
    const argv = buildPowerShellArgv(shell, spec.command)
    const env = { ...process.env, ...(spec.env ?? {}), ...(spec.dshEnv ?? {}) }
    env.DSH_FULL_PERMISSION_REAL = '1'
    const handle = new ElevatedHandle(spec, this.config.buffers)
    this.track(handle)

    let child
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: spec.workdir,
        env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      handle.fail(new Error(`failed to spawn ${shell}: ${error instanceof Error ? error.message : String(error)}`))
      return handle
    }
    handle.markStarted(child.pid)
    handle.setKiller(() => killTree(child.pid))
    child.stdout.on('data', (chunk) => handle.pushStdout(chunk))
    child.stderr.on('data', (chunk) => handle.pushStderr(chunk))
    child.on('error', (error) => handle.fail(new Error(`failed to spawn ${shell}: ${error.message}`)))
    child.on('close', (code, signal) => {
      handle.settle({ exitCode: code, signal: signal ?? null })
    })
    try {
      if (spec.stdin !== undefined) child.stdin.write(spec.stdin)
      child.stdin.end()
    } catch {
      /* stdin already closed */
    }
    wireCancellation(handle, spec)
    return handle
  }

  // ------------------------------------------------------------------
  // Broker provider
  // ------------------------------------------------------------------

  /** Ensure the one elevated broker for this Harness process, launching it on demand. */
  async ensureBroker() {
    if (this.broker !== null && (await this.pingBroker(this.broker))) return this.broker
    if (this.broker !== null) {
      this.log('warn', 'elevated broker is gone; launching a new one')
      this.broker = null
    }
    if (this._brokerStarting !== null) return this._brokerStarting
    this._brokerStarting = this.startBroker().finally(() => {
      this._brokerStarting = null
    })
    return this._brokerStarting
  }

  async startBroker() {
    await mkdir(this.baseDir, { recursive: true })
    const discoveryPath = path.join(this.baseDir, 'broker.json')
    const configPath = path.join(this.baseDir, `broker-config-${Date.now()}-${randomBytes(4).toString('hex')}.json`)
    const launchedPidPath = `${configPath}.pid`
    const cancelledPath = `${configPath}.cancelled`
    await rm(discoveryPath, { force: true })
    await rm(cancelledPath, { force: true })

    const token = randomBytes(32).toString('hex')
    const host = await this.probeHost()
    const brokerConfig = {
      version: BROKER_PROTOCOL_VERSION,
      token,
      discoveryPath,
      nodePath: process.execPath,
      hostPath: BROKER_HOST_PATH,
      parentPid: process.pid,
      idleTimeoutMs: this.config.broker.idleTimeoutMs,
      maxConcurrentRuns: this.config.broker.maxConcurrentRuns,
      shell: await this.resolveShell(),
      logPath: path.join(this.baseDir, 'broker.log'),
      launchedPidPath,
      cancelledPath,
    }
    await writeFile(configPath, JSON.stringify(brokerConfig, null, 2), 'utf8')

    if (host.elevated) {
      // Already elevated: spawning a child needs no UAC at all.
      this.log('info', 'starting the elevated broker with the inherited administrator token')
      const child = spawn(process.execPath, [BROKER_HOST_PATH, configPath], {
        windowsHide: true,
        stdio: 'ignore',
      })
      child.on('error', (error) => this.log('warn', `broker spawn failed: ${error.message}`))
      this._brokerChild = child
    } else {
      this.log('info', 'requesting one UAC elevation for the persistent administrator broker')
      const launcher = spawnSync(
        await this.resolveShell(),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', LAUNCHER_PATH, '-ConfigPath', configPath],
        { encoding: 'utf8', timeout: 60_000, windowsHide: true },
      )
      if (launcher.error !== undefined) {
        throw new ElevationError(`cannot start the UAC launcher: ${launcher.error.message}`, 'LAUNCH_FAILED')
      }
    }

    const started = await this.waitForBroker(discoveryPath, cancelledPath, configPath)
    const broker = { ...started, token, discoveryPath }
    this.broker = broker
    if (!(await this.pingBroker(broker))) {
      this.broker = null
      throw new ElevationError('the elevated broker started but its status handshake failed', 'BROKER_HANDSHAKE')
    }
    this.log('info', `elevated broker ready: pid ${broker.pid}, port ${broker.port}`)
    return broker
  }

  async waitForBroker(discoveryPath, cancelledPath, configPath) {
    const errorPath = `${discoveryPath}.error`
    const deadline = Date.now() + this.config.broker.startTimeoutMs
    while (Date.now() < deadline) {
      if (existsSync(errorPath)) {
        let detail = ''
        try {
          detail = (await readFile(errorPath, 'utf8')).trim()
        } catch {
          /* ignore */
        }
        await rm(errorPath, { force: true })
        await rm(configPath, { force: true })
        throw new ElevationError(`the elevated broker refused to start: ${detail}`, 'BROKER_REFUSED')
      }
      if (existsSync(cancelledPath)) {
        let detail = ''
        try {
          detail = (await readFile(cancelledPath, 'utf8')).trim()
        } catch {
          /* ignore */
        }
        await rm(configPath, { force: true })
        throw new ElevationError(
          `user cancelled the UAC elevation${detail.length > 0 ? ` (${detail})` : ''}; nothing was retried`,
          'ELEVATION_CANCELLED',
        )
      }
      if (existsSync(discoveryPath)) {
        try {
          const parsed = JSON.parse(await readFile(discoveryPath, 'utf8'))
          if (parsed?.protocolVersion !== BROKER_PROTOCOL_VERSION) {
            throw new ElevationError(`elevated broker protocol mismatch (${parsed?.protocolVersion})`, 'BROKER_PROTOCOL')
          }
          if (!isAlive(Number(parsed.pid))) {
            // Stale discovery from a crashed broker: only clear it once it has
            // had a moment to become visible/connectable, never on the first
            // failed liveness probe.
            let ageMs = 0
            try {
              ageMs = Date.now() - statSync(discoveryPath).mtimeMs
            } catch {
              ageMs = 0
            }
            if (ageMs > 5_000) await rm(discoveryPath, { force: true })
            await delay(200)
            continue
          }
          await rm(configPath, { force: true })
          return parsed
        } catch (error) {
          if (error instanceof ElevationError) throw error
          /* partially written discovery: retry */
        }
      }
      await delay(200)
    }
    throw new ElevationError(
      `the elevated broker did not become ready within ${this.config.broker.startTimeoutMs} ms ` +
        '(if a UAC dialog is still open, click Yes; if it was closed, elevation is unavailable)',
      'BROKER_TIMEOUT',
    )
  }

  /** One request/response status round-trip with the broker. */
  async pingBroker(broker) {
    const socket = await this.connectBroker(broker)
    if (socket === null) return false
    try {
      socket.write(`${JSON.stringify({ t: broker.token, op: 'status' })}\n`)
      const frame = await readFirstFrame(socket, this.config.broker.statusPingTimeoutMs)
      return frame !== null && frame.op === 'status-result' && frame.elevated === true
    } catch {
      return false
    } finally {
      socket.destroy()
    }
  }

  connectBroker(broker) {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: broker.port })
      const timer = setTimeout(() => {
        socket.destroy()
        resolve(null)
      }, 3_000)
      socket.once('connect', () => {
        clearTimeout(timer)
        resolve(socket)
      })
      socket.once('error', () => {
        clearTimeout(timer)
        resolve(null)
      })
    })
  }

  /** Start one command through the persistent elevated broker. */
  async startBrokerRun(spec, broker) {
    if (spec.signal?.aborted === true) throw spec.signal.reason ?? new Error('command aborted')
    const socket = await this.connectBroker(broker)
    if (socket === null) {
      this.broker = null
      throw new ElevationError('cannot reach the elevated broker; it will be restarted on the next command', 'BROKER_UNREACHABLE')
    }
    const handle = new ElevatedHandle(spec, this.config.buffers)
    this.track(handle)
    const runId = randomBytes(8).toString('hex')
    let settled = false
    let buffer = ''

    const cleanup = () => {
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
    }

    socket.setEncoding('utf8')
    socket.write(
      `${JSON.stringify({
        t: broker.token,
        op: 'run',
        runId,
        code: spec.command,
        cwd: spec.workdir,
        timeoutMs: spec.onExpiry === 'kill' ? spec.timeoutMs : 0,
        env: { ...(spec.env ?? {}), ...(spec.dshEnv ?? {}), DSH_FULL_PERMISSION_REAL: '1' },
        shell: broker.shell,
      })}\n`,
    )
    socket.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim() === '') continue
        let frame
        try {
          frame = JSON.parse(line)
        } catch {
          continue
        }
        this.handleBrokerFrame(frame, handle, () => {
          settled = true
        })
      }
    })
    socket.on('error', (error) => {
      if (settled) return
      settled = true
      handle.fail(new Error(`elevated broker connection failed: ${error.message}`))
    })
    socket.on('close', () => {
      if (settled) return
      settled = true
      handle.settle({ exitCode: null, signal: null })
    })

    handle.setKiller(() => {
      try {
        socket.write(`${JSON.stringify({ op: 'kill', runId })}\n`)
      } catch {
        /* ignore */
      }
      // The broker replies with an exit frame; destroy the socket shortly after
      // so a dead broker cannot keep the kill waiting.
      const timer = setTimeout(cleanup, 1_500)
      timer.unref?.()
    })
    wireCancellation(handle, spec)
    return handle
  }

  handleBrokerFrame(frame, handle, markSettled) {
    if (frame.op === 'ready') {
      handle.markStarted(Number(frame.pid))
      return
    }
    if (frame.op === 'stdout') {
      handle.pushStdout(Buffer.from(String(frame.b64 ?? ''), 'base64'))
      return
    }
    if (frame.op === 'stderr') {
      handle.pushStderr(Buffer.from(String(frame.b64 ?? ''), 'base64'))
      return
    }
    if (frame.op === 'exit') {
      markSettled()
      handle.settle({ exitCode: Number.isInteger(frame.exitCode) ? frame.exitCode : null, signal: frame.signal ?? null })
      return
    }
    if (frame.op === 'error') {
      markSettled()
      handle.fail(new Error(String(frame.message ?? 'elevated broker error')))
    }
  }

  // ------------------------------------------------------------------
  // Shared API
  // ------------------------------------------------------------------

  track(handle) {
    this.active.add(handle)
    void handle.done.then(() => this.active.delete(handle))
  }

  /**
   * Start one run on the best available provider.
   * @param spec - a `ShellExecSpec`-shaped object.
   * @returns the elevated handle.
   */
  async startRun(spec) {
    const ready = await this.ensureReady()
    if (ready.mode === 'direct') return this.startDirect(spec, ready.host)
    return this.startBrokerRun(spec, ready.broker)
  }

  /**
   * Run one command to completion (psh bridge convenience).
   * @returns `{handle, exitCode, signal, timedOut, aborted, stdout, stderr, durationMs}`.
   */
  async runToCompletion({ command, workdir, timeoutMs = 0, signal, stdoutMaxBytes, env }) {
    const spec = {
      command,
      workdir,
      timeoutMs: Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0,
      onExpiry: timeoutMs > 0 ? 'kill' : 'none',
      stdoutMaxBytes: stdoutMaxBytes ?? this.config.buffers.stdoutMaxBytes,
      ...(signal !== undefined ? { signal } : {}),
      ...(env !== undefined ? { env } : {}),
    }
    const startedAt = Date.now()
    const handle = await this.startRun(spec)
    const result = await handle.result()
    return { handle, ...result, durationMs: Date.now() - startedAt }
  }

  /** Snapshot for the model-facing status tool. */
  async statusSnapshot() {
    const snapshot = { ...this.state, brokerRunning: false, brokerPid: null, error: null }
    try {
      const host = await this.probeHost()
      snapshot.hostElevated = host.elevated
      snapshot.user = host.user
      snapshot.psVersion = host.psVersion
      snapshot.shell = host.shell
      if (host.elevated && !this.forceBroker) snapshot.mode = 'direct'
      else if (this.broker !== null) {
        snapshot.mode = 'broker'
        snapshot.brokerRunning = await this.pingBroker(this.broker)
        snapshot.brokerPid = this.broker.pid
      } else snapshot.mode = 'broker'
    } catch (error) {
      snapshot.error = error instanceof Error ? error.message : String(error)
    }
    return snapshot
  }

  /** Shut the broker down and kill anything still running. */
  async dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const handle of this.active) {
      try {
        handle.kill()
      } catch {
        /* ignore */
      }
    }
    this.active.clear()
    if (this.broker !== null) {
      const broker = this.broker
      this.broker = null
      const socket = await this.connectBroker(broker)
      if (socket !== null) {
        try {
          socket.write(`${JSON.stringify({ t: broker.token, op: 'shutdown' })}\n`)
        } catch {
          /* ignore */
        }
        socket.destroy()
      }
      await rm(broker.discoveryPath, { force: true }).catch(() => {})
    }
    if (this._brokerChild !== null) {
      try {
        this._brokerChild.kill()
      } catch {
        /* ignore */
      }
      this._brokerChild = null
    }
    await rm(this.baseDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Read one newline-framed JSON message, or null on timeout/close. */
function readFirstFrame(socket, timeoutMs) {
  return new Promise((resolve) => {
    let buffer = ''
    const timer = setTimeout(() => resolve(null), timeoutMs)
    const onData = (chunk) => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index < 0) return
      clearTimeout(timer)
      socket.off('data', onData)
      try {
        resolve(JSON.parse(buffer.slice(0, index)))
      } catch {
        resolve(null)
      }
    }
    socket.on('data', onData)
    socket.once('close', () => {
      clearTimeout(timer)
      resolve(null)
    })
  })
}
