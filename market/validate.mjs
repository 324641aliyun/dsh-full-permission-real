#!/usr/bin/env node
/**
 * Validate this bundle's market artifacts against the DSH installation on this
 * machine. Read-only: writes nothing and never touches the profile.
 *
 * Checks:
 *  1. `index.json` and `index.git-sample.json` against the real
 *     `@deepseek-ai/dsh-plugin-market-index` validator (`parseMarketIndex`).
 *  2. The exact install specs `marketInstallTarget` hands to `install_bundle`.
 *  3. The package manifest: bundle patch, win32 platform gate, and `engines.dsh`
 *     via `evaluatePluginCompatibility` from `@deepseek-ai/dsh-app-boot`.
 *  4. The patch, locales, and icon files.
 *  5. A Discover simulation: a throwaway static server serves this directory;
 *     the index is fetched with no redirects and strict UTF-8, parsed, and its
 *     relative icon fetched, exactly like `pluginMarket` does.
 *  6. Negative cases proving the validator really rejects malformed indexes.
 *
 * Run: node market/validate.mjs
 * Override the DSH installation with DSH_NPX_ROOT=<npm-cache npx dir>.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolvePath(HERE, '..')
const NPX_ROOT = process.env.DSH_NPX_ROOT ?? 'C:\\Users\\324641\\AppData\\Local\\npm-cache\\_npx\\1e7f6d9597241db0'
const moduleUrl = (relative) => pathToFileURL(join(NPX_ROOT, 'node_modules', relative)).href

const { parseMarketIndex, marketInstallTarget } = await import(moduleUrl('@deepseek-ai/dsh-plugin-market-index/lib/index.js'))
const { evaluatePluginCompatibility, assertBundlePlatform, getDshRuntimeVersion } = await import(
  moduleUrl('@deepseek-ai/dsh-app-boot/lib/index.js')
)
const YAML = await import(moduleUrl('yaml/dist/index.js'))

let failures = 0
const pass = (label, detail = '') => console.log(`PASS  ${label}${detail === '' ? '' : `  → ${detail}`}`)
const fail = (label, error) => {
  failures += 1
  console.log(`FAIL  ${label}  → ${error instanceof Error ? error.message : String(error)}`)
}
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}
function check(label, body) {
  try {
    pass(label, body() ?? '')
  } catch (error) {
    fail(label, error)
  }
}
async function checkAsync(label, body) {
  try {
    pass(label, (await body()) ?? '')
  } catch (error) {
    fail(label, error)
  }
}
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))

const RAW_BASE = 'https://raw.githubusercontent.com/324641aliyun/dsh-full-permission-real/main/market'
const indexUrl = `${RAW_BASE}/index.json`
const gitSampleUrl = `${RAW_BASE}/index.git-sample.json`

const runtimeVersion = getDshRuntimeVersion()
console.log('='.repeat(78))
console.log(`dsh runtime version: ${runtimeVersion}`)
console.log('='.repeat(78))

const index = await readJson(join(HERE, 'index.json'))
const gitSample = await readJson(join(HERE, 'index.git-sample.json'))
const pkg = await readJson(join(ROOT, 'package.json'))
let parsedIndex
let parsedGitSample

check('index.json is a valid format-1 index', () => {
  parsedIndex = parseMarketIndex(index, indexUrl)
  const plugin = parsedIndex.plugins[0]
  assert(parsedIndex.format === 1, 'format')
  assert(plugin.name === pkg.name, `plugin ${plugin.name} !== package ${pkg.name}`)
  return `${parsedIndex.plugins.length} plugin, ${plugin.name}@${plugin.versions[0].version}`
})

check('index.git-sample.json is a valid format-1 index', () => {
  parsedGitSample = parseMarketIndex(gitSample, gitSampleUrl)
  return `${parsedGitSample.plugins.length} plugin(s), source ${parsedGitSample.plugins[0].versions[0].source.type}`
})

check('index.json install target is an exact npm pin', () => {
  const plugin = parsedIndex.plugins[0]
  const target = marketInstallTarget(plugin.name, plugin.versions[0])
  assert(target.spec === 'dsh-full-permission-real@1.0.0', `spec ${target.spec}`)
  assert(target.registry === undefined, 'a portable index names no registry')
  return target.spec
})

check('index.git-sample.json install target is commit-pinned', () => {
  const plugin = parsedGitSample.plugins[0]
  const target = marketInstallTarget(plugin.name, plugin.versions[0])
  assert(target.spec.startsWith('git+https://github.com/324641aliyun/dsh-full-permission-real.git#'), `spec ${target.spec}`)
  assert(/[0-9a-f]{40}$/u.test(target.spec), 'commit is not 40-hex')
  return target.spec
})

check('relative icon resolves against the published index URL', () => {
  const icon = parsedIndex.plugins[0].icon
  assert(icon === `${RAW_BASE}/icons/dsh-full-permission-real.svg`, `icon ${icon}`)
  return icon
})

check('package manifest declares the bundle patch and win32 platforms', () => {
  assert(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch')
  assert(Array.isArray(pkg.dsh.bundle.platforms) && pkg.dsh.bundle.platforms.includes('win32'), 'platforms')
  return `name=${pkg.name}@${pkg.version} platforms=${pkg.dsh.bundle.platforms.join(',')}`
})

check('package engines.dsh admits the running DSH', () => {
  const issue = evaluatePluginCompatibility(pkg, {}, runtimeVersion)
  assert(issue === undefined, `unmet ${JSON.stringify(issue?.requirements)}`)
  return `engines.dsh=${pkg.engines.dsh} accepts dsh ${runtimeVersion}`
})

check('index engines.dsh matches the package manifest', () => {
  assert(parsedIndex.plugins[0].versions[0].engines.dsh === pkg.engines.dsh, 'engines mismatch')
  return pkg.engines.dsh
})

check('win32 platform gate: darwin is refused before selection', () => {
  assertBundlePlatform(pkg.dsh.bundle.platforms, 'win32')
  try {
    assertBundlePlatform(pkg.dsh.bundle.platforms, 'darwin')
  } catch (error) {
    assert(error.name === 'UnsupportedBundlePlatformError', `threw ${error.name}`)
    return 'win32 accepted; darwin refused'
  }
  throw new Error('darwin was not refused')
})

await checkAsync('cordis.patch.yml is a loader patch list with the bundle row', async () => {
  const text = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8')
  for (const document of YAML.parseAllDocuments(text)) if (document.errors.length > 0) throw document.errors[0]
  const patches = YAML.parse(text)
  assert(Array.isArray(patches), 'patch is not a list')
  const rows = patches.flatMap((patch) => (Array.isArray(patch?.insert) ? patch.insert : []))
  const row = rows.find((candidate) => candidate?.id === 'full-permission-real')
  assert(row !== undefined, 'full-permission-real row missing')
  assert(row.name === pkg.name, `row name ${row.name} !== ${pkg.name}`)
  return `row ${row.id} -> ${row.name}`
})

await checkAsync('locale dictionaries carry localized display metadata', async () => {
  for (const [locale, file] of [['en', 'en.json'], ['zh', 'zh.json']]) {
    const dictionary = await readJson(join(ROOT, 'locale', file))
    assert(typeof dictionary.meta?.title === 'string' && dictionary.meta.title.length > 0, `${locale} meta.title`)
    assert(typeof dictionary.meta?.description === 'string' && dictionary.meta.description.length > 0, `${locale} meta.description`)
  }
  return 'en + zh meta.title/description present'
})

await checkAsync('icon is a non-empty SVG within the size limit', async () => {
  const bytes = await readFile(join(HERE, 'icons', 'dsh-full-permission-real.svg'))
  assert(bytes.length > 0 && bytes.length <= 256 * 1024, `size ${bytes.length}`)
  assert(bytes.subarray(0, 4).toString('utf8') === '<svg', 'not an SVG')
  return `${bytes.length} bytes`
})

check('malformed indexes are rejected by the real validator', () => {
  const broken = JSON.parse(JSON.stringify(index))
  broken.plugins[0].versions = []
  try {
    parseMarketIndex(broken, indexUrl)
  } catch (error) {
    assert(error.name === 'MarketIndexError', `threw ${error.name}`)
    assert(error.path === '$.plugins[0].versions', `path ${error.path}`)
    return `rejected at ${error.path}`
  }
  throw new Error('accepted an index with no versions')
})

// ---------------------------------------------------------------------------
// Discover simulation
// ---------------------------------------------------------------------------
const CONTENT_TYPES = { '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' }
async function startStaticServer(root) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname
      const target = resolvePath(root, decodeURIComponent(pathname).replace(/^\/+/u, ''))
      if (target !== root && !target.startsWith(root + sep)) throw new Error('outside root')
      const body = await readFile(target)
      response.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
        'content-length': body.length,
      })
      response.end(body)
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found')
    }
  })
  await new Promise((resolveServer, rejectServer) => {
    server.once('error', rejectServer)
    server.listen(0, '127.0.0.1', () => resolveServer(server))
  })
  return server
}
async function fetchIndex(url) {
  const response = await fetch(url, { redirect: 'error', headers: { accept: 'application/json' } })
  assert(response.status >= 200 && response.status < 300, `HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return parseMarketIndex(JSON.parse(text), url)
}

const server = await startStaticServer(HERE)
const port = server.address().port
const localIndexUrl = `http://127.0.0.1:${String(port)}/index.json`
console.log('-'.repeat(78))
console.log(`Discover simulation: ${HERE} on http://127.0.0.1:${String(port)}`)
try {
  await checkAsync('Discover can load the index over loopback HTTP (no redirect, strict UTF-8)', async () => {
    const loaded = await fetchIndex(localIndexUrl)
    const plugin = loaded.plugins[0]
    return `HTTP 200, parseMarketIndex OK: ${plugin.name}@${plugin.versions[0].version}`
  })
  await checkAsync('the relative icon is served beside the index', async () => {
    const loaded = await fetchIndex(localIndexUrl)
    const response = await fetch(loaded.plugins[0].icon, { redirect: 'error' })
    assert(response.status === 200, `HTTP ${response.status}`)
    assert((response.headers.get('content-type') ?? '').startsWith('image/svg+xml'), 'not image/svg+xml')
    const bytes = new Uint8Array(await response.arrayBuffer())
    assert(bytes.length > 0, 'empty icon')
    return `${String(bytes.length)} bytes, image/svg+xml`
  })
} finally {
  server.closeAllConnections?.()
  await new Promise((resolveClose) => server.close(resolveClose))
}

console.log('='.repeat(78))
if (failures === 0) {
  console.log('ALL MARKET ARTIFACT CHECKS PASSED')
  process.exitCode = 0
} else {
  console.log(`${failures} MARKET ARTIFACT CHECK(S) FAILED`)
  process.exitCode = 1
}
