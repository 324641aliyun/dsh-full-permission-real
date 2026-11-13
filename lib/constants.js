/**
 * Shared constants for the `dsh-full-permission-real` bundle.
 *
 * The bundle adds one permission mode, `full-access-real`, whose knobs are
 * `danger-full-access` + `never` and whose shell execution is a REAL elevated
 * Windows administrator token. Everything in this file is version-pinned by
 * the package `engines.dsh` field because the mode's enforcement relies on
 * DSH 0.2.2-rc.1 runtime internals (see README "Compatibility").
 */

/** Machine value of the permission preset this bundle contributes. */
export const PRESET = 'full-access-real'

/** Default user-facing label; overridable with `presetName` in the row config. */
export const DEFAULT_PRESET_NAME = '完全权限（真实）'

/** Default one-line explanation; overridable with `presetDescription`. */
export const DEFAULT_PRESET_DESCRIPTION =
  '真实管理员权限：无文件沙箱、无审批请求；pwsh 命令以本机管理员令牌真实执行，不再逐次弹出 UAC。'

/** Bundle / package name. */
export const PACKAGE_NAME = 'dsh-full-permission-real'

/** Plugin row id inserted by `cordis.patch.yml`. */
export const ROW_ID = 'full-permission-real'

/**
 * PowerShell preamble prepended to every elevated command: silence the
 * first-run progress record (CLIXML noise on stderr) and pin UTF-8 output so
 * Chinese text round-trips through the pipe.
 */
export const PS_PREAMBLE =
  "$ProgressPreference='SilentlyContinue';" +
  '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);' +
  '$OutputEncoding=[Console]::OutputEncoding;'

/** Collector budgets for one elevated command. */
export const DEFAULT_MAX_STDOUT_BYTES = 240_000
export const DEFAULT_MAX_STDERR_BYTES = 64_000

/** Model-facing status tool name. */
export const STATUS_TOOL_NAME = 'full_real_status'

/** Broker process wire version; the host refuses a mismatched protocol. */
export const BROKER_PROTOCOL_VERSION = 1
