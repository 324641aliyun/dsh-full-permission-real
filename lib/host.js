/**
 * `dsh-full-permission-real` — the Host half of the bundle.
 *
 * What this plugin does (single activation, all of it reversible):
 *
 * 1. Registers a new selectable permission mode, machine value
 *    `full-access-real`, display name 完全权限（真实）, bundling
 *    `sandbox: danger-full-access` with `approval: never`. It edits the live
 *    `permissionPresets` table (the only runtime-registration path DSH
 *    0.2.2-rc.1 offers a plugin) and announces the catalog change, so the
 *    composer selector, `/permission full-access-real`, and the settings
 *    default picker all see it immediately.
 * 2. For a session currently in that mode, patches the mounted `ctx.shell`
 *    provider's `execute` so DSH's own `pwsh` tool (including
 *    `run_in_background`/`job_output`) runs through a REAL elevated Windows
 *    administrator channel instead of the filtered sandbox executor. Other
 *    sessions keep the shipped behavior byte-for-byte.
 * 3. Bridges the third-party `dsh-powershell` tools (`psh`, `psh_elevated`,
 *    `psh_job`, `psh_status`) through the same channel while the mode is
 *    active, so those tools stop prompting for per-call UAC.
 * 4. Contributes one runtime-context line telling the model that administrator
 *    operations are expected to work in this mode, and a `full_real_status`
 *    diagnostic tool.
 *
 * The mode changes NO global policy and does not modify any profile file; with
 * the bundle disabled/removed, the previous composition is restored.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

import { normalizeConfig } from './config.js'
import { PACKAGE_NAME, PRESET, ROW_ID, STATUS_TOOL_NAME } from './constants.js'
import { ElevatedRunner } from './elevation.js'
import { createPshBridge } from './psh-bridge.js'

/** Marks the tool-dispatch async context whose shell calls must be elevated. */
const realModeContext = new AsyncLocalStorage()

/**
 * Own enumerable symbol stamped onto a resolved spec by the patched `resolve`.
 * `dsh-tool-pwsh` forwards a spec to a background job with object spread, which
 * copies enumerable own symbols, so a command admitted in real mode still
 * routes to the elevated channel when the job runner executes it later.
 */
const REAL_SPEC = Symbol.for('dsh-full-permission-real/spec')

/** A neutral logger so a missing `ctx.logger` never breaks activation. */
const fallbackLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

/** Required DSH services. `permissionPresets` and `shell` gate the whole plugin. */
export const inject = ['shell', 'permissionPresets', 'systemPrompt', 'tools']

function loggerOf(ctx) {
  try {
    const logger = ctx.logger
    if (logger !== undefined && logger !== null) {
      return {
        debug: (message) => logger.debug?.(message),
        info: (message) => logger.info?.(message),
        warn: (message) => logger.warn?.(message),
        error: (message) => logger.error?.(message),
      }
    }
  } catch {
    /* fall through */
  }
  return fallbackLogger
}

/** The one model-visible fact of this mode, appended after the approval policy. */
function modeContextText(config) {
  return (
    'Current DSH permission mode: 完全权限（真实） (machine value "full-access-real"). ' +
    'This session runs without the DSH file sandbox and without approval prompts; DSH policy blocks no operation. ' +
    'Shell commands issued through the `pwsh` tool execute in a REAL Windows administrator PowerShell with an ' +
    'elevated administrator token, one fresh process per call, with no UAC prompt per call: HKLM registry writes, ' +
    'services, drivers, system directories, user accounts, and other administrator-only operations are expected to succeed. ' +
    'Use `pwsh` for every shell task and `run_in_background` for long commands. ' +
    'While this mode is active, `psh`, `psh_elevated`, `psh_job`, and `psh_status` are transparently served by the same ' +
    'elevated channel and are equally elevated. ' +
    'Never pass `sandbox_permissions`: there is no sandbox to escalate. ' +
    `Call \`${STATUS_TOOL_NAME}\` if you need the execution-channel details. ` +
    `(Mode label: ${config.presetName})`
  )
}

/** Render the status tool's canonical value for the model. */
function formatStatus(value) {
  const lines = [
    `permission mode ${PRESET}: ${value.modeRegistered ? 'registered and selectable' : 'NOT registered (degraded)'}`,
    `current session preset: ${value.currentPreset || '(unknown)'}`,
    `execution channel: ${value.elevationMode || '(unknown)'} · host elevated: ${value.hostElevated}`,
    `shell: ${value.shell || '(unknown)'} · user: ${value.user || '(unknown)'} · PowerShell ${value.psVersion || '(unknown)'}`,
  ]
  if (value.elevationMode === 'broker') {
    lines.push(`persistent elevated broker: ${value.brokerRunning ? `running (pid ${value.brokerPid})` : 'not running yet (starts on the next elevated command)'}`)
  }
  if (value.degraded) lines.push(`degraded: ${value.degraded}`)
  lines.push(
    'proof: in this mode a pwsh command that echoes $env:DSH_FULL_PERMISSION_REAL prints 1, and administrator-only operations (e.g. an HKLM write) succeed.',
  )
  return lines.join('\n')
}

/** Build the tool definition for `full_real_status`. */
function statusToolDefinition(ctx, runner, runtime, config) {
  return {
    name: STATUS_TOOL_NAME,
    description:
      'Report the state of the 完全权限（真实） (full-access-real) permission mode in this session: whether the mode is ' +
      'selectable, the current session preset, whether commands really run with an elevated administrator token, and ' +
      'whether the persistent one-time-UAC broker is running. Use it before claiming a command did or did not have ' +
      'administrator rights.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          modeRegistered: { type: 'boolean', description: 'Whether the full-access-real preset is registered in this process.' },
          preset: { type: 'string', description: 'Machine value of this mode.' },
          presetName: { type: 'string', description: 'User-facing label of this mode.' },
          currentPreset: { type: 'string', description: 'Preset effective in the calling session, or an empty string without a session.' },
          hostElevated: { type: 'boolean', description: 'Whether the DSH host itself holds an elevated administrator token.' },
          user: { type: 'string', description: 'Windows identity name resolved by the probe.' },
          psVersion: { type: 'string', description: 'PowerShell version of the elevated channel.' },
          shell: { type: 'string', description: 'PowerShell executable used by the elevated channel.' },
          elevationMode: { type: 'string', description: 'direct (host is administrator) or broker (persistent one-time-UAC broker).' },
          brokerRunning: { type: 'boolean', description: 'Whether the persistent elevated broker is alive.' },
          brokerPid: { type: 'number', description: 'Process id of the persistent elevated broker, or 0.' },
          degraded: { type: 'string', description: 'Why the mode is degraded, or an empty string.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatStatus(value) }],
    },
    async execute(_args, exec) {
      let currentPreset = ''
      try {
        if (exec?.agent?.session !== undefined) currentPreset = ctx.permissionPresets.current(exec.agent.session)
      } catch {
        currentPreset = ''
      }
      const snapshot = await runner.statusSnapshot()
      return {
        modeRegistered: runtime.presetRegistered,
        preset: PRESET,
        presetName: config.presetName,
        currentPreset,
        hostElevated: snapshot.hostElevated === true,
        user: String(snapshot.user ?? ''),
        psVersion: String(snapshot.psVersion ?? ''),
        shell: String(snapshot.shell ?? ''),
        elevationMode: String(snapshot.mode ?? ''),
        brokerRunning: snapshot.brokerRunning === true,
        brokerPid: Number.isInteger(snapshot.brokerPid) ? snapshot.brokerPid : 0,
        degraded: runtime.degraded ?? '',
      }
    },
  }
}

/**
 * Plugin entry point. Every registration below is effect-owned, so disabling
 * or removing the bundle restores the previous composition.
 * @param ctx - the plugin context (Host side).
 * @param rawConfig - the row `config` from `cordis.patch.yml`.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const logger = loggerOf(ctx)
  if (!config.enabled) {
    logger.info(`[${PACKAGE_NAME}] disabled by config; the permission mode is not registered`)
    return
  }

  const runtime = { presetRegistered: false, shellPatched: false, degraded: null }
  const runner = new ElevatedRunner({ config, logger })

  // Always shut the elevated broker down with the plugin.
  ctx.effect(
    () => () => {
      void runner.dispose().catch(() => {})
    },
    `${ROW_ID}:dispose`,
  )

  // ---- 1. Route real-mode commands through the elevated channel ----------
  if (config.shellExecutePatch) {
    ctx.effect(() => {
      const shell = ctx.shell
      if (shell === null || shell === undefined) {
        runtime.degraded = 'ctx.shell is not mounted; cannot route elevated commands'
        logger.warn(`[${PACKAGE_NAME}] ${runtime.degraded}`)
        return () => {}
      }
      // `ctx.shell` is a Cordis traceable proxy: each property read may return a
      // fresh wrapper, so identity comparison is meaningless. Property
      // descriptors are forwarded to the raw service instance, which is the
      // reliable way to observe our own assignment and to restore it.
      const executeDescriptor = Object.getOwnPropertyDescriptor(shell, 'execute')
      const resolveDescriptor = Object.getOwnPropertyDescriptor(shell, 'resolve')
      const originalExecute = typeof executeDescriptor?.value === 'function' ? executeDescriptor.value : shell.execute
      const originalResolve = typeof resolveDescriptor?.value === 'function' ? resolveDescriptor.value : shell.resolve
      if (typeof originalExecute !== 'function' || typeof originalResolve !== 'function') {
        runtime.degraded = 'ctx.shell does not expose resolve/execute; cannot route elevated commands'
        logger.warn(`[${PACKAGE_NAME}] ${runtime.degraded}`)
        return () => {}
      }
      const restoreMethod = (name, descriptor, original) => {
        try {
          if (descriptor !== undefined) shell[name] = original
          else delete shell[name]
        } catch {
          /* the service is already gone */
        }
      }
      const restore = () => {
        restoreMethod('execute', executeDescriptor, originalExecute)
        restoreMethod('resolve', resolveDescriptor, originalResolve)
      }
      // `resolve` runs synchronously inside the tool body, i.e. inside the
      // AsyncLocalStorage scope of the dispatch listener. Stamping the resolved
      // spec makes the decision survive job hand-over.
      const patchedResolve = function fullPermissionRealResolve(request) {
        const spec = originalResolve.call(this, request)
        if (realModeContext.getStore()?.real === true && spec !== null && typeof spec === 'object') {
          try {
            spec[REAL_SPEC] = true
          } catch {
            /* a non-extensible spec still elevates through the ALS check below */
          }
        }
        return spec
      }
      const patchedExecute = async function fullPermissionRealExecute(spec) {
        const real = realModeContext.getStore()?.real === true || spec?.[REAL_SPEC] === true
        if (!real) return originalExecute.call(this, spec)
        // Never bypass a narrower explicitly-resolved policy: the mode must
        // only replace the `danger-full-access` execution path.
        const mode = spec?.sandboxPolicy?.mode
        if (mode !== undefined && mode !== 'danger-full-access') return originalExecute.call(this, spec)
        return runner.startRun(spec)
      }
      try {
        shell.resolve = patchedResolve
        shell.execute = patchedExecute
      } catch (error) {
        runtime.degraded = `cannot patch ctx.shell: ${error instanceof Error ? error.message : String(error)}`
        logger.warn(`[${PACKAGE_NAME}] ${runtime.degraded}`)
        restore()
        return () => {}
      }
      const patchedResolveDescriptor = Object.getOwnPropertyDescriptor(shell, 'resolve')
      const patchedExecuteDescriptor = Object.getOwnPropertyDescriptor(shell, 'execute')
      if (patchedResolveDescriptor?.value !== patchedResolve || patchedExecuteDescriptor?.value !== patchedExecute) {
        runtime.degraded = 'ctx.shell rejected the elevation patch; elevated routing is unavailable'
        logger.warn(`[${PACKAGE_NAME}] ${runtime.degraded}`)
        restore()
        return () => {}
      }
      runtime.shellPatched = true
      logger.info(`[${PACKAGE_NAME}] ctx.shell.resolve/execute patched for permission mode "${PRESET}"`)
      return restore
    }, `${ROW_ID}:shell-execute`)
  }

  // ---- 2. Register the selectable permission mode -----------------------
  if (config.presetEnabled && runtime.shellPatched) {
    ctx.effect(() => {
      const service = ctx.permissionPresets
      // Work on the raw service instance behind the Cordis traceable proxy.
      const raw = service?.[Symbol.for('cordis.original')] ?? service
      const presets = raw?.presets
      if (presets === null || typeof presets !== 'object' || Array.isArray(presets)) {
        runtime.degraded = 'permissionPresets internals are not the 0.2.2-rc.1 shape; the mode cannot be registered'
        logger.warn(`[${PACKAGE_NAME}] ${runtime.degraded}`)
        return () => {}
      }

      // Boot-safety: this preset is injected at runtime, so it must never
      // become the persisted "default for new sessions". That value is read by
      // the permission service constructor on the NEXT boot, before this
      // plugin can re-inject the preset, and an unknown default aborts the
      // whole DSH startup. Hide it from `defaultOptions` only.
      const fallbackDefault = Object.hasOwn(presets, 'danger-full-access')
        ? 'danger-full-access'
        : Object.keys(presets).find((name) => name !== PRESET) ?? ''
      let storedDefault = ''
      try {
        storedDefault = typeof raw.defaultPreset === 'string' ? raw.defaultPreset : ''
      } catch {
        storedDefault = ''
      }
      if (storedDefault === PRESET) {
        logger.warn(
          `[${PACKAGE_NAME}] WARNING: the persisted default permission preset is "${PRESET}", which only exists while this plugin is loaded. ` +
            'Reset the default to another preset in Settings → Permissions; DSH cannot boot with that persisted default.',
        )
      }

      const catalogDescriptor = Object.getOwnPropertyDescriptor(raw, 'catalog')
      const originalCatalog = typeof catalogDescriptor?.value === 'function' ? catalogDescriptor.value : raw.catalog
      const patchedCatalog = function permissionCatalogWithoutDefaultableReal(...args) {
        const catalog = originalCatalog.apply(raw, args)
        if (catalog === null || typeof catalog !== 'object') return catalog
        const filtered = Array.isArray(catalog.defaultOptions)
          ? catalog.defaultOptions.filter((option) => option?.value !== PRESET)
          : catalog.defaultOptions
        const defaultPreset = catalog.defaultPreset === PRESET ? fallbackDefault : catalog.defaultPreset
        return { ...catalog, defaultOptions: filtered, defaultPreset }
      }

      const hadPreset = Object.hasOwn(presets, PRESET)
      const previous = hadPreset ? presets[PRESET] : undefined
      presets[PRESET] = {
        sandbox: 'danger-full-access',
        approval: 'never',
        name: config.presetName,
        description: config.presetDescription,
      }
      runtime.presetRegistered = true
      const announce = () => {
        try {
          if (typeof raw.emitCatalogChanged === 'function') raw.emitCatalogChanged()
          else ctx.emit('permission-presets/catalog-changed')
        } catch (error) {
          logger.warn(`[${PACKAGE_NAME}] could not announce the permission catalog change: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      let catalogPatched = false
      try {
        raw.catalog = patchedCatalog
        catalogPatched = Object.getOwnPropertyDescriptor(raw, 'catalog')?.value === patchedCatalog
      } catch {
        catalogPatched = false
      }
      if (!catalogPatched) {
        logger.warn(`[${PACKAGE_NAME}] could not hide "${PRESET}" from the default-preset list; do not select it as the new-session default`)
      }
      announce()
      logger.info(`[${PACKAGE_NAME}] permission mode "${PRESET}" registered as "${config.presetName}"`)

      return () => {
        runtime.presetRegistered = false
        try {
          if (hadPreset) presets[PRESET] = previous
          else delete presets[PRESET]
          if (catalogPatched) {
            try {
              if (catalogDescriptor !== undefined) raw.catalog = originalCatalog
              else delete raw.catalog
            } catch {
              /* the service is already gone */
            }
          }
          if (typeof raw.emitCatalogChanged === 'function') raw.emitCatalogChanged()
          else ctx.emit('permission-presets/catalog-changed')
        } catch {
          /* the service is already gone */
        }
      }
    }, `${ROW_ID}:permission-preset`)
  } else if (config.presetEnabled && !runtime.shellPatched) {
    runtime.degraded = runtime.degraded ?? 'elevated routing is unavailable; the mode is not registered'
    logger.warn(`[${PACKAGE_NAME}] not registering the permission mode: ${runtime.degraded}`)
  }

  // ---- 3. psh compatibility bridge --------------------------------------
  const bridge = config.pshBridge ? createPshBridge({ runner, ctx, config, logger }) : null
  if (bridge !== null) {
    ctx.effect(
      () => () => {
        bridge.dispose()
      },
      `${ROW_ID}:psh-bridge`,
    )
  }

  // ---- 4. Per-call real-mode marker + bridged tools ---------------------
  ctx.effect(() => {
    const disposer = ctx.on(
      'tools/execute',
      async (exec, next) => {
        if (!runtime.presetRegistered) return next()
        const session = exec?.agent?.session
        if (session === undefined) return next()
        let current
        try {
          current = ctx.permissionPresets.current(session)
        } catch {
          return next()
        }
        if (current !== PRESET) return next()
        if (bridge !== null) {
          const served = await bridge.handle(exec)
          if (served !== null) return served
        }
        return realModeContext.run({ real: true, agent: exec.agent }, () => next())
      },
      { prepend: true },
    )
    return () => {
      try {
        disposer?.()
      } catch {
        /* already disposed */
      }
    }
  }, `${ROW_ID}:tools-execute`)

  // ---- 5. Model-visible mode context ------------------------------------
  if (config.contextEnabled) {
    ctx.effect(() => {
      const policyOrder = typeof ctx.systemPrompt.getContextOrder === 'function'
        ? ctx.systemPrompt.getContextOrder('APPROVAL_POLICY')
        : 115
      return ctx.systemPrompt.context({
        name: `${ROW_ID}:mode`,
        order: policyOrder + 1,
        text: (assemblyContext) => {
          if (!runtime.presetRegistered) return ''
          const session = assemblyContext?.agent?.session
          if (session === undefined) return ''
          try {
            if (ctx.permissionPresets.current(session) !== PRESET) return ''
          } catch {
            return ''
          }
          return modeContextText(config)
        },
      })
    }, `${ROW_ID}:context`)
  }

  // ---- 6. Diagnostic tool ------------------------------------------------
  ctx.effect(
    () => ctx.tools.register(statusToolDefinition(ctx, runner, runtime, config)),
    `${ROW_ID}:status-tool`,
  )

  logger.info(
    `[${PACKAGE_NAME}] active: mode=${runtime.presetRegistered ? PRESET : '(not registered)'}, ` +
      `shellPatched=${runtime.shellPatched}, pshBridge=${bridge !== null}${runtime.degraded !== null ? `, degraded=${runtime.degraded}` : ''}`,
  )
}

/** The plugin's stable export name (the Loader row id is separate). */
export const name = PACKAGE_NAME
