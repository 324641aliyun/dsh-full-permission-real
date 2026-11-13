// Medium-integrity child: the "DSH host is not elevated" scenario for the
// INTEGRATED plugin code. It must detect its filtered token, ask the launcher
// for one elevation, and then serve real administrator commands through the
// persistent broker with no further prompts.
//
// argv[2] = absolute result JSON path. Launched by test/run-broker-medium.mjs
// through explorer.exe so the token is genuinely medium integrity.
import { existsSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

import { normalizeConfig } from '../lib/config.js'
import { ElevatedRunner } from '../lib/elevation.js'

const resultPath = process.argv[2]
const report = {
  kind: 'integrated-plugin-broker-medium',
  ok: false,
  ownPid: process.pid,
  stages: {},
  error: null,
}

const identityCommand =
  '$id=[Security.Principal.WindowsIdentity]::GetCurrent();' +
  '$p=[Security.Principal.WindowsPrincipal]::new($id);' +
  '[pscustomobject]@{user=$id.Name;' +
  'elevated=$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);' +
  'psVersion=$PSVersionTable.PSVersion.ToString();' +
  'marker=$env:DSH_FULL_PERMISSION_REAL}|ConvertTo-Json -Compress'

const probeCommand =
  "$key='HKLM:\\SOFTWARE\\DshFullPermissionRealMediumProbe';" +
  '$before=(Test-Path -LiteralPath $key);' +
  'New-Item -Path $key -Force -ErrorAction Stop | Out-Null;' +
  "Set-ItemProperty -Path $key -Name Value -Value 'medium-e2e-ok' -ErrorAction Stop;" +
  '$read=(Get-ItemProperty -Path $key -Name Value -ErrorAction Stop).Value;' +
  'Remove-Item -Path $key -Recurse -Force -ErrorAction Stop;' +
  '$after=(Test-Path -LiteralPath $key);' +
  '[pscustomobject]@{before=$before;read=$read;existsAfterDelete=$after}|ConvertTo-Json -Compress'

let runner = null
try {
  const config = normalizeConfig({ enabled: true, elevation: 'auto', pshBridge: false })
  runner = new ElevatedRunner({
    config,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  })

  const host = await runner.probeHost()
  report.stages.probedHost = true
  report.hostElevatedInChild = host.elevated
  report.childUser = host.user

  const ready = await runner.ensureReady()
  report.stages.elevated = true
  report.mode = ready.mode
  report.launch = ready.mode === 'broker'
    ? { brokerPid: ready.broker?.pid, brokerPort: ready.broker?.port, brokerUser: ready.broker?.user }
    : { direct: true }
  report.uacConsentPolicy = readConsentPolicy()

  const identity = await runner.runToCompletion({ command: identityCommand, workdir: process.cwd(), timeoutMs: 60_000 })
  report.stages.identity = true
  report.identityRun = { exitCode: identity.exitCode, stdout: identity.stdout.text.trim() }
  report.identity = JSON.parse(identity.stdout.text.trim().split('\n').find((line) => line.trim().startsWith('{')))

  const probe = await runner.runToCompletion({ command: probeCommand, workdir: process.cwd(), timeoutMs: 60_000 })
  report.stages.probe = true
  report.probeRun = { exitCode: probe.exitCode, stdout: probe.stdout.text.trim() }
  report.probe = JSON.parse(probe.stdout.text.trim().split('\n').find((line) => line.trim().startsWith('{')))

  report.ok =
    report.hostElevatedInChild === false &&
    report.mode === 'broker' &&
    report.identity?.elevated === true &&
    report.identity?.marker === '1' &&
    report.probe?.read === 'medium-e2e-ok' &&
    report.probe?.existsAfterDelete === false
} catch (error) {
  report.error = {
    name: error?.name ?? null,
    code: error?.code ?? null,
    message: error?.message ?? String(error),
  }
} finally {
  try {
    if (runner !== null) {
      await runner.dispose()
      report.tempDirRemoved = !existsSync(runner.baseDir)
    }
  } catch (error) {
    report.disposeError = String(error?.message ?? error)
  }
  writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

/** Read-only UAC policy probe, so the report explains whether a prompt was expected. */
function readConsentPolicy() {
  try {
    const result = spawnSync(
      'reg.exe',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System', '/v', 'ConsentPromptBehaviorAdmin'],
      { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
    )
    const match = /ConsentPromptBehaviorAdmin\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(result.stdout ?? '')
    return match === null ? null : Number.parseInt(match[1], 16)
  } catch {
    return null
  }
}
