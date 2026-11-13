// Host-wiring test: activates lib/host.js against a mock Cordis context and
// proves the mode registration, the real-mode routing, the psh bridge, the
// system-prompt context and clean disposal. Uses the real elevated channel for
// the routed command (the machine's DSH process is already elevated), so this
// is a genuine end-to-end check of the Host half without installing anything.
//
// Run: node test/host-logic.mjs
import assert from 'node:assert/strict'

import { apply } from '../lib/host.js'
import { PRESET } from '../lib/constants.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${name}:`, error?.message ?? error)
  }
}

function createMockContext() {
  const disposers = []
  const handlers = []
  const registeredTools = []
  const presetTable = {
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask', name: 'workspace-write' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never', name: 'danger-full-access' },
  }
  let catalogChanges = 0
  let currentPreset = 'danger-full-access'
  let contextContribution = null
  let toolExecuteHandler = null

  const permissionPresets = {
    presets: presetTable,
    current() {
      return currentPreset
    },
    catalog() {
      const options = Object.entries(presetTable).map(([value, spec]) => ({ value, name: spec.name, description: spec.description }))
      return {
        options,
        defaultOptions: options,
        defaultPreset: 'danger-full-access',
      }
    },
    emitCatalogChanged() {
      catalogChanges += 1
    },
  }

  const shell = {
    sandboxMode: 'workspace-write',
    resolve(request) {
      return {
        command: request.command,
        workdir: request.workdir ?? process.cwd(),
        timeoutMs: request.timeoutMs ?? 0,
        onExpiry: request.onExpiry ?? 'kill',
        stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
        sandboxPolicy: request.sandboxPolicy,
      }
    },
    async execute(spec) {
      // The shipped executor stand-in: what an unelevated call would do.
      return { shipped: true, command: spec.command }
    },
  }

  const systemPrompt = {
    getContextOrder() {
      return 115
    },
    context(contribution) {
      contextContribution = contribution
      return () => {
        contextContribution = null
      }
    },
  }

  const tools = {
    register(definition) {
      registeredTools.push(definition)
      return () => {}
    },
  }

  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    shell,
    permissionPresets,
    systemPrompt,
    tools,
    effect(execute) {
      const disposer = execute()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    on(name, listener) {
      if (name === 'tools/execute') toolExecuteHandler = listener
      handlers.push(listener)
      return () => {}
    },
    events: { dispatch() {} },
  }

  return {
    ctx,
    shell,
    presetTable,
    registeredTools,
    get catalogChanges() {
      return catalogChanges
    },
    get contextContribution() {
      return contextContribution
    },
    get toolExecuteHandler() {
      return toolExecuteHandler
    },
    setCurrentPreset(value) {
      currentPreset = value
    },
    dispose() {
      for (const disposer of disposers.reverse()) {
        try {
          const result = disposer()
          if (result && typeof result.then === 'function') void result.catch(() => {})
        } catch {
          /* ignore */
        }
      }
    },
  }
}

const mock = createMockContext()
apply(mock.ctx, {
  enabled: true,
  presetName: '完全权限（真实）',
  presetDescription: '真实管理员权限',
  elevation: 'auto',
  pshBridge: true,
  contextEnabled: true,
})

await check('registers the full-access-real preset in the live preset table', async () => {
  const spec = mock.presetTable[PRESET]
  assert.ok(spec, 'preset entry missing')
  assert.equal(spec.sandbox, 'danger-full-access')
  assert.equal(spec.approval, 'never')
  assert.equal(spec.name, '完全权限（真实）')
  assert.ok(mock.catalogChanges > 0, 'catalog change was not announced')
})

await check('keeps the runtime-injected preset out of the persisted default list', async () => {
  const catalog = mock.ctx.permissionPresets.catalog()
  assert.equal(catalog.options.some((option) => option.value === PRESET), true, 'mode must be selectable')
  assert.equal(catalog.defaultOptions.some((option) => option.value === PRESET), false, 'mode must not be defaultable')
  assert.equal(catalog.defaultPreset, 'danger-full-access')
})

await check('registers the full_real_status diagnostic tool', async () => {
  const tool = mock.registeredTools.find((definition) => definition.name === 'full_real_status')
  assert.ok(tool, 'status tool missing')
  assert.equal(typeof tool.execute, 'function')
  const value = await tool.execute({}, {})
  assert.equal(value.modeRegistered, true)
  assert.equal(value.preset, PRESET)
  assert.equal(value.hostElevated, true)
  assert.equal(value.elevationMode, 'direct')
})

await check('system-prompt context is empty outside the mode and full inside it', async () => {
  const contribution = mock.contextContribution
  assert.ok(contribution, 'no context contribution')
  const session = { header: { cwd: process.cwd() } }
  mock.setCurrentPreset('danger-full-access')
  assert.equal(contribution.text({ agent: { session } }), '')
  mock.setCurrentPreset(PRESET)
  const text = contribution.text({ agent: { session } })
  assert.match(text, /完全权限（真实）/)
  assert.match(text, /full-access-real/)
  assert.match(text, /administrator/)
})

await check('real-mode pwsh calls are routed to the elevated channel', async () => {
  const handler = mock.toolExecuteHandler
  assert.ok(handler, 'no tools/execute listener')
  mock.setCurrentPreset(PRESET)
  const exec = { name: 'pwsh', agent: { session: { header: { cwd: process.cwd() } } } }
  const result = await handler(exec, async () => {
    const handle = await mock.shell.execute({
      command: "[pscustomobject]@{marker=$env:DSH_FULL_PERMISSION_REAL;elevated=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)}|ConvertTo-Json -Compress",
      workdir: process.cwd(),
      timeoutMs: 60_000,
      onExpiry: 'kill',
      sandboxPolicy: { mode: 'danger-full-access' },
    })
    return { handleResult: await handle.result() }
  })
  const text = result.handleResult.stdout.text
  const parsed = JSON.parse(text.trim().split('\n').find((line) => line.trim().startsWith('{')))
  assert.equal(parsed.marker, '1', 'elevated-channel marker missing')
  assert.equal(parsed.elevated, true)
})

await check('non-real sessions keep the shipped executor', async () => {
  mock.setCurrentPreset('danger-full-access')
  const handler = mock.toolExecuteHandler
  const exec = { name: 'pwsh', agent: { session: { header: { cwd: process.cwd() } } } }
  const result = await handler(exec, async () => mock.shell.execute({ command: 'ignored' }))
  assert.equal(result.shipped, true)
})

await check('psh bridge serves psh_elevated without a UAC prompt', async () => {
  mock.setCurrentPreset(PRESET)
  const handler = mock.toolExecuteHandler
  const exec = {
    name: 'psh_elevated',
    arguments: { code: "Write-Output 'bridged-elevated'", timeoutMs: 30_000 },
    agent: { session: { header: { cwd: process.cwd() } } },
    signal: new AbortController().signal,
  }
  const result = await handler(exec, async () => {
    throw new Error('the bridged tool body must not run')
  })
  assert.equal(result.isError, false)
  assert.equal(result.value.elevated, true)
  assert.equal(result.value.pid, 0)
  assert.match(result.value.preview, /real administrator channel/)
  assert.match(result.value.preview, /bridged-elevated/)
})

await check('psh bridge serves psh_job start/poll without leaving a job behind', async () => {
  const handler = mock.toolExecuteHandler
  const startExec = {
    name: 'psh_job',
    arguments: { action: 'start', code: "Write-Output 'job-line'; Start-Sleep -Milliseconds 300", timeoutMs: 30_000 },
    agent: { session: { header: { cwd: process.cwd() } } },
    signal: new AbortController().signal,
  }
  const started = await handler(startExec, async () => {
    throw new Error('the bridged job tool body must not run')
  })
  assert.equal(started.value.ok, true)
  assert.match(started.value.id, /^real-/)
  const pollExec = {
    name: 'psh_job',
    arguments: { action: 'poll', id: started.value.id, offset: 0 },
    agent: { session: { header: { cwd: process.cwd() } } },
    signal: new AbortController().signal,
  }
  let polled
  for (let attempt = 0; attempt < 20; attempt += 1) {
    polled = await handler(pollExec, async () => {
      throw new Error('the bridged job tool body must not run')
    })
    if (polled.value.done) break
    await sleep(100)
  }
  assert.equal(polled.value.done, true)
  assert.equal(polled.value.exitCode, 0)
  assert.match(polled.value.output, /job-line/)
})

await check('disposal restores the shell and removes the preset', async () => {
  const originalExecute = mock.shell.execute
  assert.notEqual(originalExecute.name, 'shippedExecute')
  mock.dispose()
  assert.equal(Object.hasOwn(mock.presetTable, PRESET), false)
  const nonReal = mock.shell.execute({ command: 'x' })
  const result = await nonReal
  assert.equal(result.shipped, true)
})

console.log(failures === 0 ? '\nALL HOST-WIRING TESTS PASSED' : `\n${failures} TEST(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
