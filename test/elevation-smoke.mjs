// Standalone smoke test for the elevated execution channel (direct + broker).
// Run: node test/elevation-smoke.mjs
// On this machine the DSH host is already elevated, so both providers are
// exercised without any UAC dialog. The launcher/UAC branch is covered by
// `test/uac-launcher.ps1` documentation and by the code path, not by this test.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeConfig } from '../lib/config.js'
import { ElevatedRunner } from '../lib/elevation.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const logger = {
  info: (m) => console.log('[info]', m),
  warn: (m) => console.warn('[warn]', m),
  debug: () => {},
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`PASS ${name}`))
    .catch((error) => {
      failures += 1
      console.error(`FAIL ${name}:`, error?.message ?? error)
    })
}

const config = normalizeConfig({ enabled: true, pshBridge: true })
const direct = new ElevatedRunner({ config, logger })
const broker = new ElevatedRunner({ config, logger, forceBroker: true })

const jsonProbe =
  '$id=[Security.Principal.WindowsIdentity]::GetCurrent();' +
  '$p=[Security.Principal.WindowsPrincipal]::new($id);' +
  '[pscustomobject]@{user=$id.Name;elevated=$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);ps=$PSVersionTable.PSVersion.ToString();pid=$PID}|ConvertTo-Json -Compress'

try {
  await check('direct: real administrator token', async () => {
    const run = await direct.runToCompletion({ command: jsonProbe, workdir: process.cwd(), timeoutMs: 60_000 })
    assert.equal(run.exitCode, 0)
    const parsed = JSON.parse(run.stdout.text.trim().split('\n').find((l) => l.trim().startsWith('{')))
    assert.equal(parsed.elevated, true)
    console.log('   user:', parsed.user, 'ps:', parsed.ps, 'child pid:', parsed.pid)
  })

  await check('direct: UTF-8 Chinese output round-trips', async () => {
    const run = await direct.runToCompletion({ command: "Write-Output '中文测试 完全权限（真实）'", workdir: process.cwd(), timeoutMs: 60_000 })
    assert.equal(run.exitCode, 0)
    assert.match(run.stdout.text, /中文测试 完全权限（真实）/)
  })

  await check('direct: exit code and stderr separation', async () => {
    const run = await direct.runToCompletion({
      command: "[Console]::Error.WriteLine('err-line'); cmd /c exit 5; exit $LASTEXITCODE",
      workdir: process.cwd(),
      timeoutMs: 60_000,
    })
    assert.equal(run.exitCode, 5)
    assert.match(run.stderr.text, /err-line/)
  })

  await check('direct: streaming visible before completion', async () => {
    const started = Date.now()
    const handle = await direct.startRun({
      command: "Write-Output 'tick-1'; Start-Sleep -Milliseconds 1800; Write-Output 'tick-2'",
      workdir: process.cwd(),
      timeoutMs: 30_000,
      onExpiry: 'kill',
    })
    let firstSeenAt = 0
    while (Date.now() - started < 10_000) {
      const read = handle.observed.stdout.readFrom(0)
      if (read.text.includes('tick-1')) {
        firstSeenAt = Date.now() - started
        break
      }
      await sleep(50)
    }
    const result = await handle.result()
    assert.equal(result.exitCode, 0)
    assert.ok(firstSeenAt > 0 && firstSeenAt < 1500, `tick-1 seen after ${firstSeenAt} ms`)
    console.log('   first chunk at', firstSeenAt, 'ms; total', Date.now() - started, 'ms')
  })

  await check('direct: kill a long run without breaking the runner', async () => {
    const handle = await direct.startRun({ command: 'Start-Sleep -Seconds 30', workdir: process.cwd(), timeoutMs: 0, onExpiry: 'none' })
    await sleep(400)
    assert.equal(handle.kill(), true)
    const result = await handle.result()
    assert.ok(result.exitCode !== null || result.signal !== null)
    const next = await direct.runToCompletion({ command: "Write-Output 'alive'", workdir: process.cwd(), timeoutMs: 30_000 })
    assert.equal(next.exitCode, 0)
  })

  await check('direct: timeout classification', async () => {
    const handle = await direct.startRun({ command: 'Start-Sleep -Seconds 5', workdir: process.cwd(), timeoutMs: 600, onExpiry: 'kill' })
    const result = await handle.result()
    assert.equal(result.timedOut, true)
  })

  await check('broker: starts once, reuses one process across commands', async () => {
    const first = await broker.runToCompletion({ command: "Write-Output 'one'", workdir: process.cwd(), timeoutMs: 30_000 })
    assert.equal(first.exitCode, 0)
    const pid1 = (await broker.statusSnapshot()).brokerPid
    const second = await broker.runToCompletion({ command: "Write-Output 'two'", workdir: process.cwd(), timeoutMs: 30_000 })
    assert.equal(second.exitCode, 0)
    const pid2 = (await broker.statusSnapshot()).brokerPid
    assert.equal(pid1, pid2)
    assert.ok(pid1 > 0)
    const discovery = JSON.parse(readFileSync(path.join(broker.baseDir, 'broker.json'), 'utf8'))
    assert.equal(discovery.elevated, true)
    assert.equal(discovery.port > 0, true)
    console.log('   broker pid', pid1, 'port', discovery.port, 'user', discovery.user)
  })

  await check('broker: admin token proof through broker', async () => {
    const run = await broker.runToCompletion({ command: jsonProbe, workdir: process.cwd(), timeoutMs: 30_000 })
    const parsed = JSON.parse(run.stdout.text.trim().split('\n').find((l) => l.trim().startsWith('{')))
    assert.equal(parsed.elevated, true)
    console.log('   broker child user:', parsed.user, 'pid:', parsed.pid)
  })

  await check('broker: kill one run, broker stays alive', async () => {
    const handle = await broker.startRun({ command: 'Start-Sleep -Seconds 30', workdir: process.cwd(), timeoutMs: 0, onExpiry: 'none' })
    await sleep(500)
    assert.equal(handle.kill(), true)
    await handle.result().catch(() => {})
    const next = await broker.runToCompletion({ command: "Write-Output 'still-alive'", workdir: process.cwd(), timeoutMs: 30_000 })
    assert.equal(next.exitCode, 0)
    assert.match(next.stdout.text, /still-alive/)
  })
} finally {
  await direct.dispose()
  await broker.dispose()
}

console.log(failures === 0 ? '\nALL ELEVATION SMOKE TESTS PASSED' : `\n${failures} TEST(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
