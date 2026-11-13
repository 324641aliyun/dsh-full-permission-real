/**
 * Row-config normalization.
 *
 * The bundle deliberately declares no `Config` schema: a profile-installed
 * plugin cannot reliably resolve `@deepseek-ai/schemastery`, and the shipped
 * DSH plugin reference shows that falling back to a plain object for `Config`
 * breaks the loader. Instead every value is normalized defensively here, so
 * the same code accepts a raw YAML mapping, an injected resolved config, or an
 * empty object (all fields have safe defaults).
 */

import {
  DEFAULT_MAX_STDERR_BYTES,
  DEFAULT_MAX_STDOUT_BYTES,
  DEFAULT_PRESET_DESCRIPTION,
  DEFAULT_PRESET_NAME,
} from './constants.js'

/** Read one field from a raw config or a schemastery-resolved config object. */
function pick(source, key, fallback) {
  if (source === null || typeof source !== 'object') return fallback
  const raw = source[key]
  if (raw === undefined || raw === null) return fallback
  if (typeof raw === 'object' && typeof raw.get === 'function') {
    const resolved = raw.get()
    return resolved === undefined ? fallback : resolved
  }
  return raw
}

function pickBool(source, key, fallback) {
  const value = pick(source, key, fallback)
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return !/^(false|0|no|off)$/i.test(value.trim())
  return Boolean(value)
}

function pickNumber(source, key, fallback) {
  const value = Number(pick(source, key, fallback))
  return Number.isFinite(value) ? value : fallback
}

/**
 * Normalize a plugin row config into the internal shape.
 * @param raw - the row `config` the Loader passed to `apply`, or undefined.
 * @returns the normalized configuration.
 */
export function normalizeConfig(raw) {
  const source = raw ?? {}
  const broker = pick(source, 'broker', {})
  const elevation = String(pick(source, 'elevation', 'auto')).toLowerCase()
  const shell = String(pick(source, 'shell', 'auto')).toLowerCase()

  return {
    enabled: pickBool(source, 'enabled', true),
    // The contributed permission mode.
    presetEnabled: pickBool(source, 'presetEnabled', true),
    presetName: String(pick(source, 'presetName', DEFAULT_PRESET_NAME)),
    presetDescription: String(pick(source, 'presetDescription', DEFAULT_PRESET_DESCRIPTION)),
    // Execution channel.
    elevation: ['auto', 'never'].includes(elevation) ? elevation : 'auto',
    shell: ['auto', 'powershell', 'pwsh'].includes(shell) ? shell : 'auto',
    shellPath: String(pick(source, 'powershellPath', '')),
    pshBridge: pickBool(source, 'pshBridge', true),
    contextEnabled: pickBool(source, 'contextEnabled', true),
    shellExecutePatch: pickBool(source, 'shellExecutePatch', true),
    broker: {
      startTimeoutMs: Math.max(5_000, pickNumber(broker, 'startTimeoutMs', 180_000)),
      idleTimeoutMs: Math.max(60_000, pickNumber(broker, 'idleTimeoutMs', 30 * 60_000)),
      maxConcurrentRuns: Math.max(1, Math.min(64, pickNumber(broker, 'maxConcurrentRuns', 16))),
      statusPingTimeoutMs: Math.max(500, pickNumber(broker, 'statusPingTimeoutMs', 3_000)),
    },
    buffers: {
      stdoutMaxBytes: Math.max(8_192, pickNumber(source, 'maxOutputBytes', DEFAULT_MAX_STDOUT_BYTES)),
      stderrMaxBytes: Math.max(4_096, pickNumber(source, 'maxErrorBytes', DEFAULT_MAX_STDERR_BYTES)),
    },
  }
}
