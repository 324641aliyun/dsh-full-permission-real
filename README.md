# dsh-full-permission-real

**完全权限（真实） / Full permission (real)** — a permission mode for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that is
*actually* full: no file sandbox, no approval requests, and a **real elevated
Windows administrator PowerShell** behind every shell command.

This is not "auto approval". Automatic review/delegated approval asks a model or
a human before acting; this mode removes the sandbox and the approval gate and
then really runs the command with an administrator token. The mode is a
distinct, separately selectable entry in the Permissions selector, so the two
can never be confused.

| | read-only | workspace-write | danger-full-access | auto review (`auto`) | **完全权限（真实）** |
|---|---|---|---|---|---|
| File sandbox | yes | yes | none | none | **none** |
| Approval requests | ask | ask | never | reviewed by the same model | **never** |
| Shell process token | user | user | user | user | **real administrator (elevated)** |
| Per-command UAC | – | – | – | – | **never** (one-time broker activation at most) |
| Blocks sensitive operations | yes | partly | DSH does not | reviewer may deny | **nothing** |

## What you get

- A new permission mode named **完全权限（真实）** (machine value
  `full-access-real`) bundling `sandbox: danger-full-access` with
  `approval: never`. Select it per session in the composer Permissions picker,
  with `/permission full-access-real`, or as the new-session default in
  Settings → Permissions.
- While that mode is active, the built-in `pwsh` tool (including
  `run_in_background` and `job_output`) executes through the elevated channel:
  every command is a fresh `powershell.exe -EncodedCommand` process with a real
  elevated administrator token. HKLM registry writes, services, drivers, system
  directories, user accounts, and other administrator-only work succeed.
- If the third-party [`dsh-powershell`](https://github.com/a5899/dsh-powershell)
  plugin is installed, its `psh`, `psh_elevated`, `psh_job`, and `psh_status`
  tools are transparently served by the same channel while the mode is active.
  `psh_elevated` stops showing a UAC prompt: it is already elevated.
- A runtime-context line tells the model that administrator operations are
  expected to work in this mode, and a `full_real_status` tool reports the
  channel state (direct token vs. persistent broker, host elevation, shell
  version) so the model never has to guess whether a command had admin rights.

Everything is effect-owned: disabling or removing the bundle restores the
previous composition exactly (the shipped sandbox executor is patched at
runtime, never replaced as a row).

## How the real administrator token is obtained

Windows cannot silently create an elevated token from a filtered one. The
plugin therefore picks the strongest available provider at first use:

1. **direct** — the DSH Host itself already runs as administrator (the Desktop
   app or a terminal started with "Run as administrator"). Each command is a
   child process inheriting that token. **Zero UAC prompts, ever.**
2. **broker** — the DSH Host runs with a filtered token. The first elevated
   command asks **one** UAC consent, then starts a small persistent elevated
   Node broker (`lib/broker-host.js`) for the lifetime of this Harness process.
   Every later command is silent: the broker spawns real administrator
   PowerShell children. The broker exits on plugin unload, when the Harness
   process exits, or after `idleTimeoutMs` of inactivity.

With `elevation: never` the plugin never initiates UAC; the mode then requires
a DSH started as administrator, otherwise commands fail with a clear
`ELEVATION_REQUIRED` error.

## Install

### From the plugin market (Discover)

Add this index source under **Plugins → Discover → Add index source**:

```
https://raw.githubusercontent.com/324641aliyun/dsh-full-permission-real/main/market/index.json
```

Then install **Full permission (real)**. The index pins a public Git commit, so
installation needs no npm account:

```
git+https://github.com/324641aliyun/dsh-full-permission-real.git#<commit>
```

See `PUBLISHING.md` for the publishing and version-bump workflow.

### From a local checkout

```powershell
# From this directory (the package must contain dsh.bundle.patch):
dsh plugin --profile web add "C:\path\to\dsh-full-permission-real"
# or let the agent do it with plugin_manager install_bundle(target: <abs path>)
```

The bundle patch `cordis.patch.yml` inserts one Host row
`full-permission-real`. No profile file edits are required.

### Verify

1. Start (or keep) DSH running. Open the Permissions picker: **完全权限（真实）**
   appears as a selectable entry (it is never selected automatically; the
   default preset is unchanged).
2. Switch a session to it (`/permission full-access-real`).
3. Ask the agent to run `full_real_status` — it reports the channel, host
   elevation, and the resolved PowerShell.
4. Run `pwsh`: `Write-Output $env:DSH_FULL_PERMISSION_REAL` → `1`, and an
   administrator-only operation such as an `HKLM:` write succeeds.

## Configuration

All fields are optional; the bundle patch ships working defaults.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. `false` = the bundle registers nothing. |
| `presetEnabled` | `true` | Register the `full-access-real` permission mode. |
| `presetName` | `完全权限（真实）` | User-facing label shown in the selector. |
| `presetDescription` | Chinese one-liner | Description shown under the label. |
| `elevation` | `auto` | `auto` = inherited admin token when available, else one UAC activation; `never` = never initiate UAC. |
| `shell` | `auto` | `auto` / `powershell` / `pwsh`; `auto` prefers Windows PowerShell 5.1. |
| `powershellPath` | `''` | Explicit PowerShell executable path. |
| `pshBridge` | `true` | Serve the `dsh-powershell` tools through the elevated channel in this mode. |
| `contextEnabled` | `true` | Contribute the model-facing mode context. |
| `broker.startTimeoutMs` | `180000` | How long one-time UAC activation may take (includes human clicking). |
| `broker.idleTimeoutMs` | `1800000` | Broker self-exit after inactivity. |
| `broker.maxConcurrentRuns` | `16` | Concurrent elevated commands. |

## Security notes — read before enabling

This mode is intentionally the strongest permission a local agent can have.

- **The agent can change anything the administrator can change.** Registry,
  services, drivers, firewall, accounts, disk, other users' data. Treat the
  session as a remote-administrator session and review the task report.
- **The persistent broker is a local privilege boundary.** It listens only on
  `127.0.0.1`, requires a 256-bit random bearer token (never written to the
  profile), and its discovery file lives in the per-user `%TEMP%` directory.
  Any process running as the same Windows user could, in principle, read that
  file and ask the broker for administrator commands — the same trust boundary
  as any elevated helper. Disable the bundle (`enabled: false` or Remove) to
  stop the broker; it also exits with its parent Harness process.
- **No per-request protection.** Approval policy is `never` by design: nothing
  asks before a destructive action. The plugin does not add its own guardrails;
  do not enable this mode for tasks or inputs you do not trust.
- **UAC is a user consent boundary.** The one-time broker activation is a real
  UAC dialog; cancelling it is honoured and never retried. The plugin does not
  bypass UAC, disable it, or create scheduled tasks/services.
- **Windows only.** On other platforms the bundle is not installable
  (`os: ["win32"]`, `dsh.bundle.platforms: ["win32"]`).

## Compatibility

Built and verified against DSH **0.2.2-rc.1**. The mode registration uses the
live `permissionPresets` service internals (the only runtime registration path
this version offers a plugin) and the shell routing patches the mounted
`ctx.shell` provider's `execute`. `package.json` pins `engines.dsh` to that
exact version; re-verify before using with another DSH release.

Sub-agents and delegated in-process children pin their own preset; they do not
inherit `full-access-real` unless that preset is selected for them (DSH's child
permission vocabulary only forwards `danger-full-access`/`auto`). Give a child
the mode explicitly when it needs administrator rights.

## Troubleshooting

- **`full_real_status` says `degraded`** — the DSH runtime shape differs from
  0.2.2-rc.1, or a higher-priority profile patch replaced `ctx.shell`. Check the
  Harness log for `[full-permission-real]` lines.
- **Broker did not start** — `%TEMP%\dsh-full-permission-real\host-<pid>\broker.log`
  records the broker's own view. A cancelled UAC dialog surface as
  `ELEVATION_CANCELLED` and is never retried automatically.
- **`psh` still looks unelevated** — the bridge only activates while the
  calling session's preset is `full-access-real`; check the current preset with
  `full_real_status`.

## Uninstall

Remove the bundle (`plugin_manager` `remove_bundle`, or the Plugins page).
The broker is shut down, the mode disappears from the selector, and the shell
provider returns to the shipped sandbox executor. Existing sessions that had
selected the mode fall back to `custom` until another preset is selected.

## Development

```powershell
node test/elevation-smoke.mjs   # direct + broker channels, streaming, kill, timeout, UTF-8
node test/host-logic.mjs        # plugin wiring against a mock Cordis context
```

## License

MIT. See [LICENSE](LICENSE).
