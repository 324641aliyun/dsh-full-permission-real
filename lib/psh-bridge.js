/**
 * Compatibility bridge for the `dsh-powershell` plugin's tools (`psh`,
 * `psh_elevated`, `psh_job`, `psh_status`).
 *
 * That third-party plugin spawns its own (unelevated) PowerShell and its
 * `psh_elevated` tool asks for a real UAC consent on every call. Inside the
 * `full-access-real` mode that would break the mode's zero-prompt promise, so
 * while the mode is active those four tool calls are transparently served by
 * the elevated channel instead: the model-facing tool contract (arguments and
 * canonical output schema) is unchanged, only the process behind it changes.
 *
 * Tools absent from the composition (the plugin is not installed) never match,
 * so this module is inert on other profiles.
 */

import { randomBytes } from 'node:crypto'

import { STATUS_TOOL_NAME } from './constants.js'

const DEFAULT_PSH_TIMEOUT_MS = 120_000
const DEFAULT_ELEVATED_TIMEOUT_MS = 300_000
const MAX_OUTPUT_CHARS = 200_000

/** Tools served by this bridge, mapped to their execution flavor. */
const BRIDGED_TOOLS = new Set(['psh', 'psh_elevated', 'psh_job', 'psh_status'])

/** Short one-line preview of the command. */
function previewOf(command) {
  const oneLine = String(command).replace(/\s+/g, ' ').trim()
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}…` : oneLine
}

function clip(text, max = MAX_OUTPUT_CHARS) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  const head = value.slice(0, max - Math.floor(max * 0.2))
  const tail = value.slice(value.length - Math.floor(max * 0.2))
  return `${head}\n… [${value.length - head.length - tail.length} chars omitted] …\n${tail}`
}

/** Render one finished command the way the psh plugin renders it. */
function renderResult(mode, result) {
  const lines = []
  const status = result.timedOut ? 'timed out' : result.exitCode === 0 ? 'ok' : `exit ${result.exitCode}`
  lines.push(`[${mode}] ${status} · ${result.durationMs} ms${result.truncated ? ' · output truncated' : ''}`)
  lines.push('real administrator channel · no UAC · no approval request')
  const stdout = clip(result.stdout)
  const stderr = clip(result.stderr)
  if (stdout) lines.push('', '--- stdout ---', stdout.replace(/\s+$/, ''))
  if (stderr) lines.push('', '--- stderr ---', stderr.replace(/\s+$/, ''))
  if (!stdout && !stderr) lines.push('', '(no output — a filter matching nothing, or a command that prints nothing)')
  return lines.join('\n')
}

/** Status of one run, as the psh tool's canonical value expects it. */
function baseValue(result, preview) {
  return {
    exitCode: Number.isInteger(result.exitCode) ? result.exitCode : -1,
    timedOut: result.timedOut === true,
    durationMs: result.durationMs,
    status: result.timedOut ? 'timeout' : result.exitCode === 0 ? 'ok' : 'error',
    preview,
  }
}

/**
 * Create the bridge for one plugin activation.
 * @param options.runner - the elevated runner.
 * @param options.ctx - the Cordis plugin context.
 * @param options.config - normalized plugin config.
 * @param options.logger - DSH logger.
 */
export function createPshBridge({ runner, ctx, config, logger }) {
  const jobs = new Map()
  let disposed = false

  const effectiveCwd = async (exec, requested) => {
    if (typeof requested === 'string' && requested.length > 0) return requested
    const sessionCwd = exec?.agent?.session?.header?.cwd
    if (typeof sessionCwd === 'string' && sessionCwd.length > 0) return sessionCwd
    try {
      if (typeof ctx.workingDirectory?.ensure === 'function' && exec?.agent !== undefined) {
        const ensured = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
        if (typeof ensured === 'string' && ensured.length > 0) return ensured
      }
    } catch {
      /* fall through to process.cwd() */
    }
    return process.cwd()
  }

  const effectiveTimeout = (requested, fallback) => {
    if (requested === 0) return 0
    return Number(requested) > 0 ? Number(requested) : fallback
  }

  async function runCommand(exec, args, { mode, timeoutFallback }) {
    const code = String(args?.code ?? '')
    if (code.trim().length === 0) {
      return { kind: 'empty', mode, code }
    }
    const cwd = await effectiveCwd(exec, args?.cwd)
    const timeoutMs = effectiveTimeout(args?.timeoutMs, timeoutFallback)
    const finished = await runner.runToCompletion({
      command: code,
      workdir: cwd,
      timeoutMs,
      signal: exec?.signal,
      stdoutMaxBytes: config.buffers.stdoutMaxBytes,
    })
    const preview = renderResult(mode, {
      exitCode: finished.exitCode,
      durationMs: finished.durationMs,
      timedOut: finished.timedOut,
      stdout: finished.stdout.text,
      stderr: finished.stderr.text,
      truncated: finished.stdout.truncated || finished.stderr.truncated,
    })
    return { kind: 'done', finished, preview, cwd }
  }

  async function runPlain(exec, args, { label, elevatedFields, timeoutFallback }) {
    const prepared = await runCommand(exec, args, { mode: label, timeoutFallback })
    if (prepared.kind === 'empty') {
      const text = `[${elevatedFields ? 'psh_elevated' : 'psh'}] nothing to run: \`code\` is empty.`
      return {
        isError: false,
        value: {
          exitCode: -1,
          stdout: '',
          stderr: '',
          timedOut: false,
          durationMs: 0,
          status: 'empty',
          preview: text,
          ...(elevatedFields ? { elevated: false, pid: 0, runDir: '' } : {}),
        },
      }
    }
    const { finished, preview } = prepared
    return {
      isError: false,
      value: {
        ...baseValue(finished, preview),
        stdout: clip(finished.stdout.text),
        stderr: clip(finished.stderr.text),
        preview,
        commandPreview: previewOf(args?.code),
        ...(elevatedFields ? { elevated: true, pid: 0, runDir: '' } : {}),
      },
    }
  }

  async function runJob(exec, args) {
    const action = String(args?.action ?? '').toLowerCase()

    if (action === 'start') {
      const code = String(args?.code ?? '')
      if (code.trim().length === 0) {
        const message = '[psh_job] nothing to run: `code` is empty.'
        return { isError: false, value: { ok: false, message, preview: message, id: '', offset: 0 } }
      }
      const cwd = await effectiveCwd(exec, args?.cwd)
      const timeoutMs = effectiveTimeout(args?.timeoutMs, 0)
      const id = `real-${randomBytes(4).toString('hex')}`
      const handle = await runner.startRun({
        command: code,
        workdir: cwd,
        timeoutMs,
        onExpiry: timeoutMs > 0 ? 'kill' : 'none',
        stdoutMaxBytes: config.buffers.stdoutMaxBytes,
      })
      const job = {
        id,
        handle,
        label: typeof args?.label === 'string' && args.label.length > 0 ? args.label : previewOf(code),
        startedAt: Date.now(),
      }
      jobs.set(id, job)
      void handle.done.then(() => {
        /* kept until disposed so poll can still report the exit code */
      })
      const preview = [
        `started ${id} on the real administrator channel (no UAC)`,
        'poll with psh_job action=poll id=... offset=0 to read output as it appears',
      ].join('\n')
      return {
        isError: false,
        value: {
          ok: true,
          id,
          pid: 0,
          done: false,
          exitCode: -1,
          offset: 0,
          total: 0,
          output: '',
          preview,
          message: preview,
        },
      }
    }

    if (action === 'list') {
      const rows = [...jobs.values()].map((job) => {
        const durationMs = Date.now() - job.startedAt
        return `${job.id}  ${job.handle.status === 'running' ? 'running' : `done exit=${job.handle.exitCode ?? -1}`}  ${(durationMs / 1000).toFixed(1)}s  out=${job.handle.stdout.total}B  ${job.label}`
      })
      const text = rows.length > 0 ? rows.join('\n') : '(no jobs)'
      return { isError: false, value: { ok: true, jobs: text, preview: text, message: text } }
    }

    if (action === 'stop') {
      const id = String(args?.id ?? '')
      const job = jobs.get(id)
      if (job === undefined) {
        const message = `[psh_job] unknown job "${id}".`
        return { isError: false, value: { ok: false, message, preview: message, id, offset: 0 } }
      }
      const stopped = job.handle.kill()
      const message = stopped ? `stopped ${id}` : `${id}: already finished`
      return { isError: false, value: { ok: stopped, message, preview: message, id, offset: 0 } }
    }

    if (action === 'poll') {
      const id = String(args?.id ?? '')
      const job = jobs.get(id)
      if (job === undefined) {
        const message = `[psh_job] unknown or evicted job "${id}".`
        return { isError: false, value: { ok: false, message, preview: message, id: '', offset: 0 } }
      }
      const stream = args?.stream === 'stderr' ? 'stderr' : 'stdout'
      const from = Number.isFinite(Number(args?.offset)) ? Math.max(0, Number(args.offset)) : 0
      const read = job.handle.observed[stream].readFrom(from)
      let stderrText = ''
      if (args?.stream === undefined) {
        const stderrRead = job.handle.observed.stderr.readFrom(from)
        stderrText = stderrRead.text
      }
      const streamTotal = job.handle[stream].total
      const done = job.handle.status !== 'running'
      const durationMs = Date.now() - job.startedAt
      const timedOut = job.handle.timedOut
      const exitCode = done ? (job.handle.exitCode ?? -1) : -1
      const head = done
        ? `${id} finished · exit ${exitCode}${timedOut ? ' · TIMEOUT' : ''} · ${(durationMs / 1000).toFixed(1)}s`
        : `${id} running · ${(durationMs / 1000).toFixed(1)}s · ${job.handle.stdout.total} bytes so far`
      const preview = [
        head,
        read.text ? `--- ${stream} ---\n${clip(read.text)}` : '',
        stderrText ? `--- stderr ---\n${clip(stderrText)}` : '',
        !done ? `next: action=poll id=${id} offset=${read.nextOffset}` : '',
      ]
        .filter(Boolean)
        .join('\n')
      return {
        isError: false,
        value: {
          ok: true,
          message: head,
          id,
          pid: 0,
          done,
          exitCode,
          timedOut,
          limitExceeded: false,
          durationMs,
          output: clip(read.text),
          offset: read.nextOffset,
          more: read.nextOffset < streamTotal,
          total: job.handle.stdout.total,
          stderr: clip(stderrText),
          preview,
        },
      }
    }

    const message = `[psh_job] unknown action "${action}" (start | poll | list | stop).`
    return { isError: false, value: { ok: false, message, preview: message, id: '', offset: 0 } }
  }

  async function runStatus() {
    const probe =
      '$id=[Security.Principal.WindowsIdentity]::GetCurrent();' +
      '$p=[Security.Principal.WindowsPrincipal]::new($id);' +
      '[pscustomobject]@{' +
      'user=$id.Name;' +
      'elevated=$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);' +
      'psVersion=$PSVersionTable.PSVersion.ToString();' +
      'pwsh7=[bool](Get-Command pwsh.exe -ErrorAction SilentlyContinue);' +
      'scriptBlockLogging=[bool](Get-ItemProperty -Path `"HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\PowerShell\\ScriptBlockLogging`" -ErrorAction SilentlyContinue).EnableScriptBlockLogging' +
      '}|ConvertTo-Json -Compress'
    const finished = await runner.runToCompletion({ command: probe, workdir: process.cwd(), timeoutMs: 60_000 })
    let parsed = {}
    const jsonLine = finished.stdout.text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith('{'))
    try {
      parsed = jsonLine === undefined ? {} : JSON.parse(jsonLine)
    } catch {
      parsed = {}
    }
    return {
      isError: false,
      value: {
        platform: process.platform,
        shell: runner.state.shell ?? config.shell,
        plugin: 'dsh-full-permission-real (elevated channel)',
        elevatable: true,
        reason: 'real elevated channel: direct administrator token or persistent one-time-UAC broker',
        user: String(parsed.user ?? runner.state.user ?? ''),
        elevated: Boolean(parsed.elevated ?? runner.state.hostElevated ?? true),
        psVersion: String(parsed.psVersion ?? runner.state.psVersion ?? ''),
        pwsh7: Boolean(parsed.pwsh7),
        scriptBlockLogging: Boolean(parsed.scriptBlockLogging),
      },
    }
  }

  return {
    /** Whether this tool name belongs to the bridged family. */
    matches(name) {
      return BRIDGED_TOOLS.has(name)
    },

    /**
     * Serve one bridged tool call. Returns `null` when the tool is not part of
     * the family (the caller then continues its normal dispatch).
     */
    async handle(exec) {
      if (disposed) return null
      const name = String(exec?.name ?? '')
      if (!BRIDGED_TOOLS.has(name)) return null
      const args = exec?.arguments ?? {}
      try {
        if (name === 'psh') return await runPlain(exec, args, { label: 'elevated', elevatedFields: false, timeoutFallback: DEFAULT_PSH_TIMEOUT_MS })
        if (name === 'psh_elevated') return await runPlain(exec, args, { label: 'elevated', elevatedFields: true, timeoutFallback: DEFAULT_ELEVATED_TIMEOUT_MS })
        if (name === 'psh_job') return await runJob(exec, args)
        if (name === 'psh_status') return await runStatus()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger?.warn?.(`[full-permission-real] bridged tool "${name}" failed: ${message}`)
        throw new Error(`elevated channel unavailable for "${name}": ${message}`)
      }
      return null
    },

    /** Kill bridged background jobs and forget them. */
    dispose() {
      disposed = true
      for (const job of jobs.values()) {
        try {
          job.handle.kill()
        } catch {
          /* ignore */
        }
      }
      jobs.clear()
    },

    get jobCount() {
      return jobs.size
    },
  }
}

export { STATUS_TOOL_NAME }
