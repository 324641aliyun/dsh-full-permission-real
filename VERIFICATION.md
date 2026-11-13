# Acceptance verification — 2026-11-13

Environment: Windows, DSH **0.2.2-rc.1**, Web profile `web`.
The Harness process itself runs with an elevated administrator token on this
machine, so the plugin's `direct` provider was the one exercised; the
one-time-UAC `broker` provider is covered by the automated tests in
`test/elevation-smoke.mjs` (both providers run there, plus a medium-integrity
UAC path in `research/elevation/test/07-medium-integrity-e2e.mjs`).

## 1. Install and activation

`plugin_manager install_bundle(target: <project dir>)` → `application: applied`, no
warnings; the bundle row `full-permission-real` activated through HMR.
`full_real_status` then reported:

```
permission mode full-access-real: registered and selectable
current session preset: full-access-real
execution channel: direct · host elevated: true
shell: powershell.exe · user: DESKTOP-A6A6TCB\324641 · PowerShell 5.1.26100.9843
```

## 2. Selectable mode and per-session scope

The mode was selected for this session with `/permission full-access-real` (the
composer picker and `/permission` share the same write path). Immediately after
the switch the runtime-context snapshot delivered to the model contained:

> Current DSH permission mode: 完全权限（真实） (machine value "full-access-real").
> … Shell commands issued through the `pwsh` tool execute in a REAL Windows
> administrator PowerShell … administator-only operations are expected to succeed.

The mode is not offered as a persisted new-session default (boot-safety
measure); other sessions stay on their own preset.

## 3. Real administrator token through the built-in `pwsh` tool

```
channel-marker=1                         <- our elevated channel stamped the call
user=DESKTOP-A6A6TCB\324641
elevated=True
integrity=High-Mandatory-Level
中文输出正常 · 完全权限（真实）
powershell=5.1.26100.9843
```

`$env:DSH_FULL_PERMISSION_REAL` is set only by the elevated channel, so `1`
proves the command ran through the plugin rather than the shipped executor.

## 4. HKLM registry write (administrator-only) and cleanup

```
hklm-write=ok value=full-real-admin-ok
hklm-cleanup=True
```

The probe wrote `HKLM:\SOFTWARE\DshFullPermissionRealProbe`, read the value back,
and deleted the key. On this host a non-elevated process cannot perform that
write; the call succeeded and the registry was left clean.

## 5. Background jobs keep elevation and job semantics

`pwsh` with `run_in_background: true` running `Start-Sleep 4; Write-Output ...`:

1. immediately returned `started background job pwsh-6d937f243b3149e0`;
2. `job_output` while running: `(no new output) [status: running]`;
3. after completion: `bg-done marker=1`, `后台任务完成`, `[status: completed, exit code: 0]`.

`marker=1` proves the background process also used the elevated channel. The
plugin does not replace the `pwsh` tool body, so `ctx.jobs` registration, timeout
promotion, and `job_output`/`job_kill` keep their shipped behavior.

## 6. `dsh-powershell` compatibility bridge (no per-call UAC)

While the mode was active, the third-party tools were served by the elevated
channel instead of spawning their own processes:

- `psh`: `[elevated] ok … real administrator channel · no UAC · no approval request`,
  `psh-ok marker=1`, `elevated=True`
- `psh_elevated`: `[elevated] ok … real administrator channel · no UAC`,
  `psh-elevated-ok (no UAC expected)`, `marker=1` — no UAC dialog appeared
- `psh_job start/poll`: `started real-555276ab on the real administrator channel (no UAC)`,
  then `pshjob-line-1`, `pshjob-line-2`, `finished · exit 0`
- `psh_job stop/list`: `stopped real-02a940ec`, then `done exit=1` (Windows
  force-kill), the other job still listed
- `psh_status`: `dsh-full-permission-real (elevated channel) · win32 … UAC elevation available: yes`

## 7. Stream fidelity (Write-Host / stderr / UTF-8)

```
write-host-line
write-output-line
marker=1
elevated=True
[stderr]
explicit-stderr-line
```

The elevated channel uses the same `powershell.exe -Command <preamble><command>`
shape as the shipped executor, so `Write-Host` stays on stdout, only genuine
stderr is marked, and Chinese text round-trips (an earlier `-EncodedCommand`
prototype produced CLIXML noise and was replaced).

## 8. Automated tests

```
node test/elevation-smoke.mjs   -> ALL ELEVATION SMOKE TESTS PASSED
node test/host-logic.mjs        -> ALL HOST-WIRING TESTS PASSED
node test/run-broker-medium.mjs -> MEDIUM-INTEGRITY BROKER E2E PASSED
node market/validate.mjs        -> ALL MARKET ARTIFACT CHECKS PASSED
```

- `elevation-smoke`: direct + broker providers, elevation proof, UTF-8, exit
  codes, stderr separation, streaming (first chunk at ~310 ms of a ~2.1 s
  command), kill without breaking the runner, timeout classification.
- `host-logic`: preset registration, persisted-default filtering, status tool,
  context text, real-mode routing, non-real passthrough, psh/psh_job bridging,
  and full restoration on disposal.
- `run-broker-medium`: launches the **integrated** code from a genuinely
  non-elevated (medium-integrity) process through the explorer.exe
  de-elevation route. The child detects its filtered token, the launcher asks
  for ONE elevation, an elevated broker starts, and commands then run with an
  elevated token and the plugin marker while HKLM writes succeed and are cleaned
  up. This is the "DSH was not started as administrator" production path; on
  this machine `ConsentPromptBehaviorAdmin=0` means that one elevation request
  itself is also silent (no UAC dialog). A machine with the default UAC policy
  shows exactly one consent dialog at this point and never again.
- `market/validate`: real DSH index validator, install targets, engines
  compatibility, win32 gate, patch/locales/icon, malformed-index rejection, and a
  loopback Discover fetch (no redirect, strict UTF-8, relative icon served).

## 9. Mode off = shipped behavior restored

Disabling the bundle removed the mode from the selector and the context
contribution, and `full_real_status` disappeared; re-enabling restored both.
`ctx.shell.resolve/execute` is patched at runtime and restored on unload (the
shipped sandbox executor row is never replaced), so the fallback is the stock
DSH behavior rather than a broken shell.

## 10. Plugin-market publishing

The plugin is published through a public Git source plus a format-1 index, the
two things "published to the plugin market" means for DSH:

- repository: `https://github.com/324641aliyun/dsh-full-permission-real`
  (public, topics include `dsh-plugin`);
- live index: `https://raw.githubusercontent.com/324641aliyun/dsh-full-permission-real/main/market/index.json`
  (fetched with no redirects, strict UTF-8 — checked `200`);
- install target: a commit-pinned
  `git+https://github.com/324641aliyun/dsh-full-permission-real.git#<commit>`,
  which `plugin_manager`/Discover install into a profile directly.

`market/validate.mjs` (15 checks including the Discover simulation) passes for
the live index and for the npm variant kept in `market/index.npm-sample.json`.
The commit pin is verified by installing that exact spec into the Web profile:
the profile dependency is now
`github:324641aliyun/dsh-full-permission-real#84d608865edc61de860cc4c540abb620776c983d`
(the same `git+https://…#<commit>` target `marketInstallTarget` produces), the
bundle is selected, and `full_real_status` plus an elevated `pwsh` command were
re-verified after the switch. The temporary local link install and the local
`127.0.0.1:8791` index server were removed; Discover now points at the public
index URL.

npm publishing is prepared but blocked by account-side 2FA: the npm account is
`auth-and-writes` with a passkey, and npm CLI requires an OTP or a granular
token with **Bypass 2FA**. `market/index.npm-sample.json` and
`tools/publish.ps1` are ready for that path; the Git path above does not depend
on it.
