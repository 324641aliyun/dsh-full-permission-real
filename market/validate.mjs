import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const requireHost = createRequire(process.env.DSH_ANCHOR || import.meta.url)
const {parseMarketIndex,marketInstallTarget} = await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-plugin-market-index')).href)
const base = 'https://raw.githubusercontent.com/324641aliyun/dsh-full-permission-real/main/market/index.json'
const data = JSON.parse(await readFile(new URL('./index.json', import.meta.url),'utf8'))
const index = parseMarketIndex(data,base)
for(const plugin of index.plugins) {
  const version=plugin.versions[0]
  assert.match(version.source.commit,/^[0-9a-f]{40}$/)
  assert.equal(version.engines.dsh,'0.2.2-rc.4')
  console.log(plugin.name,version.version,marketInstallTarget(plugin.name,version).spec)
}
