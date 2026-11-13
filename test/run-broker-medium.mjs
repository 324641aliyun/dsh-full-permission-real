// Orchestrates test/broker-medium-child.mjs:
//  - when this process is elevated (the normal case here), the child is launched
//    through the already-running medium-integrity explorer.exe shell, exactly
//    like research/elevation/test/helpers/harness.mjs does;
//  - otherwise the direct child is already medium integrity.
//
// Run: node test/run-broker-medium.mjs
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CHILD = path.join(HERE, 'broker-medium-child.mjs')
const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-full-real-medium-'))
const resultPath = path.join(dir, 'result.json')
const outPath = path.join(dir, 'stdout.log')
const errPath = path.join(dir, 'stderr.log')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function ownElevated() {
  const probe = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$p=[Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent(); $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 20_000 },
  )
  return String(probe.stdout ?? '').trim().toLowerCase() === 'true'
}

const elevated = ownElevated()
let mode = 'direct'
if (elevated) {
  mode = 'medium'
  const cmdPath = path.join(dir, 'run.cmd')
  const launchedPath = path.join(dir, 'launched.txt')
  const quoted = [process.execPath, CHILD, resultPath].map((value) => `"${value}"`).join(' ')
  writeFileSync(
    cmdPath,
    ['@echo off', 'chcp 65001 >nul', `echo launched > "${launchedPath}"`, `${quoted} > "${outPath}" 2> "${errPath}"`, ''].join('\r\n'),
    'ascii',
  )
  const explorer = spawn('explorer.exe', [cmdPath], { stdio: 'ignore', windowsHide: false })
  explorer.on('error', (error) => {
    console.log(`explorer spawn error: ${String(error)}`)
  })
} else {
  const child = spawn(process.execPath, [CHILD, resultPath], { stdio: 'ignore', windowsHide: true })
  child.on('error', () => {})
}

const deadline = Date.now() + 90_000
let report = null
const startedAt = Date.now()
let lastNote = 0
while (Date.now() < deadline) {
  if (existsSync(resultPath)) {
    try {
      report = JSON.parse(readFileSync(resultPath, 'utf8'))
      break
    } catch {
      /* still being written */
    }
  }
  const elapsed = Date.now() - startedAt
  if (elapsed - lastNote >= 15_000) {
    lastNote = elapsed
    console.log(
      `waiting ${String(Math.round(elapsed / 1000))}s: launched=${existsSync(path.join(dir, 'launched.txt'))} ` +
        `out=${existsSync(outPath)} err=${existsSync(errPath)} size=${existsSync(errPath) ? readFileSync(errPath, 'utf8').length : 0}`,
    )
  }
  await sleep(200)
}

const stdout = existsSync(outPath) ? readFileSync(outPath, 'utf8') : ''
const stderr = existsSync(errPath) ? readFileSync(errPath, 'utf8') : ''

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`PASS ${name}${detail === '' ? '' : `  → ${detail}`}`)
  else {
    failures += 1
    console.log(`FAIL ${name}${detail === '' ? '' : `  → ${detail}`}`)
  }
}

console.log(`route: ${mode}${mode === 'medium' ? ' (explorer.exe de-elevation)' : ' (direct, already medium)'}`)
console.log(`result: ${resultPath}`)
if (report === null) {
  console.log(`FAIL medium broker child did not report within 180 s`)
  if (stdout.trim() !== '') console.log(`child stdout:\n${stdout}`)
  if (stderr.trim() !== '') console.log(`child stderr:\n${stderr}`)
  failures += 1
} else {
  console.log(JSON.stringify(report, null, 2))
  check('medium child really is NOT elevated', report.hostElevatedInChild === false, String(report.hostElevatedInChild))
  check('child selected the broker provider', report.mode === 'broker', String(report.mode))
  check('one-time elevation produced an elevated broker', Number.isInteger(report.launch?.brokerPid), `pid ${report.launch?.brokerPid}`)
  check('broker reports the elevated user', report.launch?.brokerUser === report.childUser, String(report.launch?.brokerUser))
  check('broker command has an elevated token', report.identity?.elevated === true)
  check('broker command carries the plugin channel marker', report.identity?.marker === '1')
  check('HKLM write/read through the broker succeeded', report.probe?.read === 'medium-e2e-ok', String(report.probe?.read))
  check('HKLM probe key was cleaned up', report.probe?.existsAfterDelete === false)
  check('broker temp dir was removed on dispose', report.tempDirRemoved === true, String(report.tempDirRemoved))
  check('no error was reported', report.error === null, JSON.stringify(report.error))
  console.log(`UAC policy ConsentPromptBehaviorAdmin: ${String(report.uacConsentPolicy)} (0 = elevate without prompting)`)
}

if (failures > 0) {
  console.log(`diagnostics kept in: ${dir}`)
} else {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    /* explorer may still hold the shim briefly */
  }
}

console.log(failures === 0 ? '\nMEDIUM-INTEGRITY BROKER E2E PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
