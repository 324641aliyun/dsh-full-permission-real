/**
 * The elevated broker host.
 *
 * Started exactly once per DSH Harness process, either directly (when the
 * Harness already holds an administrator token) or through one UAC elevation
 * from `launcher.ps1` (when it does not). It verifies its own token, listens on
 * a random loopback port with a 256-bit bearer token, and spawns real
 * `powershell.exe -EncodedCommand` children on demand. Every child inherits
 * this host's elevated token, so commands run as a real administrator with no
 * further UAC prompt.
 *
 * This file is a self-contained Node script with zero dependencies; it is
 * launched by absolute path and receives its JSON configuration as argv[2].
 *
 * Wire protocol: newline-delimited JSON over TCP (127.0.0.1 only).
 *   client -> host: {t:<token>, op:'status'} | {t:<token>, op:'run', runId,
 *                   code, cwd, timeoutMs, env, shell} | {op:'kill', runId}
 *                   | {t:<token>, op:'shutdown'}
 *   host -> client: {op:'ready', pid} | {op:'stdout', b64} | {op:'stderr', b64}
 *                   | {op:'exit', exitCode, signal} | {op:'error', message}
 *                   | {op:'status-result', elevated, user, psVersion, pid}
 */

import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const configPath = process.argv[2]
if (typeof configPath !== 'string' || configPath.length === 0) {
  process.stderr.write('broker-host: missing config path argument\n')
  process.exit(2)
}

let config
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'))
} catch (error) {
  process.stderr.write(`broker-host: cannot read config: ${error.message}\n`)
  process.exit(2)
}

const PS_PREAMBLE =
  "$ProgressPreference='SilentlyContinue';" +
  '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);' +
  '$OutputEncoding=[Console]::OutputEncoding;'

function log(message) {
  try {
    if (typeof config.logPath === 'string') appendFileSync(config.logPath, `[${new Date().toISOString()}] ${message}\n`)
  } catch {
    /* logging is best-effort */
  }
}

function buildPowerShellArgv(shell, command) {
  return [shell, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${PS_PREAMBLE}${command}`]
}

function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return
  try {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    killer.on('error', () => {})
  } catch {
    /* already gone */
  }
}

/** Probe the running token; the broker refuses to advertise itself otherwise. */
function probeElevation() {
  const script =
    '$id=[Security.Principal.WindowsIdentity]::GetCurrent();' +
    '$p=[Security.Principal.WindowsPrincipal]::new($id);' +
    '[pscustomobject]@{user=$id.Name;' +
    'elevated=$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);' +
    'psVersion=$PSVersionTable.PSVersion.ToString();pid=$PID}|ConvertTo-Json -Compress'
  const probe = spawnSync(config.shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  })
  if (probe.error !== undefined) return { ok: false, error: probe.error.message }
  if (probe.status !== 0) return { ok: false, error: probe.stderr || `probe exited ${probe.status}` }
  try {
    const parsed = JSON.parse(probe.stdout.trim())
    return {
      ok: true,
      elevated: parsed.elevated === true,
      user: String(parsed.user ?? ''),
      psVersion: String(parsed.psVersion ?? ''),
    }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

const probe = probeElevation()
if (!probe.ok) {
  writeErrorFile(`cannot verify the administrator token: ${probe.error}`)
  process.exit(3)
}
if (!probe.elevated) {
  writeErrorFile('this process does not hold an elevated administrator token')
  process.exit(4)
}

const runIdSeq = { value: 0 }
const activeRuns = new Map()
let activeSockets = 0
let lastActivity = Date.now()
let shuttingDown = false

/** Write a discovery/error marker atomically, then remember it for cleanup. */
function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(temp, file)
}

function writeErrorFile(message) {
  try {
    writeJson(`${config.discoveryPath}.error`, { error: message, pid: process.pid })
  } catch {
    /* ignore */
  }
  log(`error: ${message}`)
}

function writeDiscovery(port) {
  writeJson(config.discoveryPath, {
    protocolVersion: config.version,
    pid: process.pid,
    port,
    token: config.token,
    elevated: true,
    user: probe.user,
    psVersion: probe.psVersion,
    shell: config.shell,
    parentPid: config.parentPid,
    startedAt: new Date().toISOString(),
  })
}

function shutdown(reason) {
  if (shuttingDown) return
  shuttingDown = true
  log(`shutting down: ${reason}`)
  for (const run of activeRuns.values()) killTree(run.pid)
  activeRuns.clear()
  try {
    server.close()
  } catch {
    /* ignore */
  }
  try {
    rmSync(config.discoveryPath, { force: true })
  } catch {
    /* ignore */
  }  setTimeout(() => process.exit(0), 100).unref?.()
}

function findRunOfSocket(socket) {
  for (const [runId, run] of activeRuns) if (run.socket === socket) return runId
  return null
}

function settleRun(runId, outcome) {
  const run = activeRuns.get(runId)
  if (run === undefined) return
  activeRuns.delete(runId)
  if (run.timer !== null) clearTimeout(run.timer)
  try {
    run.socket.write(`${JSON.stringify({ op: 'exit', exitCode: outcome.exitCode, signal: outcome.signal, timedOut: outcome.timedOut === true })}\n`)
  } catch {
    /* peer already gone */
  }
}

function startRun(socket, frame) {
  const runId = String(frame.runId ?? `run-${++runIdSeq.value}`)
  if (activeRuns.size >= config.maxConcurrentRuns) {
    socket.write(`${JSON.stringify({ op: 'error', message: `too many concurrent elevated commands (limit ${config.maxConcurrentRuns})` })}\n`)
    return
  }
  const code = String(frame.code ?? '')
  const timeoutMs = Number(frame.timeoutMs) || 0
  const env = { ...process.env, ...(frame.env !== null && typeof frame.env === 'object' ? frame.env : {}) }
  const cwd = typeof frame.cwd === 'string' && frame.cwd.length > 0 ? frame.cwd : process.cwd()
  const shell = typeof frame.shell === 'string' && frame.shell.length > 0 ? frame.shell : config.shell

  let child
  try {
    const argv = buildPowerShellArgv(shell, code)
    child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    socket.write(`${JSON.stringify({ op: 'error', message: `cannot spawn ${shell}: ${error.message}` })}\n`)
    return
  }

  const run = { id: runId, socket, pid: child.pid, timer: null, child, settled: false }
  activeRuns.set(runId, run)
  lastActivity = Date.now()

  child.stdout.on('data', (chunk) => {
    if (run.settled) return
    try {
      socket.write(`${JSON.stringify({ op: 'stdout', b64: chunk.toString('base64') })}\n`)
    } catch {
      /* ignore */
    }
  })
  child.stderr.on('data', (chunk) => {
    if (run.settled) return
    try {
      socket.write(`${JSON.stringify({ op: 'stderr', b64: chunk.toString('base64') })}\n`)
    } catch {
      /* ignore */
    }
  })
  child.on('error', (error) => {
    if (run.settled) return
    run.settled = true
    settleRun(runId, { exitCode: null, signal: null, timedOut: false })
    socket.write(`${JSON.stringify({ op: 'error', message: `cannot spawn ${shell}: ${error.message}` })}\n`)
  })
  child.on('close', (exitCode, signal) => {
    if (run.settled) return
    run.settled = true
    settleRun(runId, { exitCode: Number.isInteger(exitCode) ? exitCode : null, signal: signal ?? null })
  })

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    run.timer = setTimeout(() => {
      if (run.settled) return
      log(`run ${runId} timed out after ${timeoutMs} ms; terminating pid ${child.pid}`)
      killTree(child.pid)
    }, timeoutMs)
  }
  try {
    socket.write(`${JSON.stringify({ op: 'ready', pid: child.pid })}\n`)
  } catch {
    /* ignore */
  }
}

function handleLine(socket, state, line) {
  if (line.trim() === '') return
  let frame
  try {
    frame = JSON.parse(line)
  } catch {
    socket.end(`${JSON.stringify({ op: 'error', message: 'invalid JSON frame' })}\n`)
    return
  }
  lastActivity = Date.now()

  if (state.authenticated === false) {
    const tokenOk = typeof frame.t === 'string' && frame.t.length === config.token.length && frame.t === config.token
    if (!tokenOk) {
      socket.end(`${JSON.stringify({ op: 'error', message: 'unauthorized' })}\n`)
      return
    }
    state.authenticated = true
  }

  switch (frame.op) {
    case 'status': {
      socket.end(
        `${JSON.stringify({ op: 'status-result', elevated: true, user: probe.user, psVersion: probe.psVersion, pid: process.pid, shell: config.shell })}\n`,
      )
      return
    }
    case 'run': {
      if (state.runId !== null) {
        socket.write(`${JSON.stringify({ op: 'error', message: 'this connection already owns a run' })}\n`)
        return
      }
      state.runId = String(frame.runId ?? `run-${++runIdSeq.value}`)
      startRun(socket, { ...frame, runId: state.runId })
      return
    }
    case 'kill': {
      const runId = String(frame.runId ?? state.runId ?? '')
      const run = activeRuns.get(runId)
      if (run !== undefined) {
        log(`kill requested for run ${runId}`)
        killTree(run.pid)
      }
      return
    }
    case 'shutdown': {
      shutdown('requested by the DSH host')
      return
    }
    default: {
      socket.write(`${JSON.stringify({ op: 'error', message: `unknown op: ${String(frame.op)}` })}\n`)
    }
  }
}

const server = net.createServer((socket) => {
  activeSockets += 1
  lastActivity = Date.now()
  socket.setEncoding('utf8')
  const state = { authenticated: false, runId: null }
  let buffer = ''
  socket.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      try {
        handleLine(socket, state, line)
      } catch (error) {
        log(`frame handling failed: ${error.message}`)
      }
    }
  })
  socket.on('error', () => {})
  socket.on('close', () => {
    activeSockets -= 1
    lastActivity = Date.now()
    if (state.runId !== null) {
      const run = activeRuns.get(state.runId)
      if (run !== undefined && !run.settled) {
        log(`client disconnected; terminating run ${state.runId} (pid ${run.pid})`)
        killTree(run.pid)
      }
    }
  })
})

server.on('error', (error) => {
  writeErrorFile(`broker server failed: ${error.message}`)
  process.exit(5)
})

server.listen({ host: '127.0.0.1', port: 0 }, () => {
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  writeDiscovery(port)
  log(`broker ready on 127.0.0.1:${port}; elevated=${probe.elevated}; user=${probe.user}; ps=${probe.psVersion}`)
})

// Watch the DSH host: this broker is useless once the Harness process is gone.
setInterval(() => {
  const parentPid = Number(config.parentPid)
  if (!Number.isInteger(parentPid) || parentPid <= 0) return
  try {
    process.kill(parentPid, 0)
  } catch {
    shutdown('parent DSH process exited')
  }
}, 5_000).unref?.()

// Idle shutdown: a broker that outlives its usefulness only widens the window
// in which a local process could ask it for administrator commands.
setInterval(() => {
  if (activeRuns.size > 0 || activeSockets > 0) return
  if (Date.now() - lastActivity > config.idleTimeoutMs) shutdown('idle timeout')
}, 30_000).unref?.()

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
