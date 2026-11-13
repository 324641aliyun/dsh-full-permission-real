# Changelog

## 1.0.0 — 2026-11-13

First release.

- Adds the **完全权限（真实）** (`full-access-real`) permission mode:
  `sandbox: danger-full-access` + `approval: never`, registered in the live
  permission catalog of DSH 0.2.2-rc.1 and selectable in the composer picker,
  `/permission`, and the new-session default settings.
- Real administrator execution channel: the built-in `pwsh` tool (including
  background jobs) runs every command in an elevated Windows administrator
  PowerShell. `direct` provider when the DSH Host is already elevated, otherwise
  one UAC activation and a persistent elevated broker with no per-command
  prompts.
- Compatibility bridge for the `dsh-powershell` plugin's `psh`, `psh_elevated`,
  `psh_job`, and `psh_status` tools: they are served by the elevated channel
  while the mode is active, removing the per-call UAC prompt.
- `full_real_status` diagnostic tool and a model-facing runtime-context line for
  the mode.
- Effect-owned activation: disabling/removing the bundle restores the shipped
  sandbox executor and removes the mode.
