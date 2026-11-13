#!/usr/bin/env node
/**
 * Throwaway static HTTP server for this plugin index.
 *
 * DSH's Discover tab accepts an absolute http(s) index URL with no credentials
 * and no fragment. For local verification:
 *
 *     node market/serve.mjs 8791
 *     # then add http://127.0.0.1:8791/index.json as an index source in
 *     # Plugins -> Discover -> Add index source, or in the profile patch:
 *     # - id: plugin-market
 *     #   config:
 *     #     indexes:
 *     #       - http://127.0.0.1:8791/index.json
 *
 * Anyone on the network path can change an http: index (and therefore the
 * install specs it lists), so keep this on loopback or a trusted LAN.
 *
 * Options:
 *   <port>          port to listen on (default 8791)
 *   --host <addr>   bind address (default 127.0.0.1; use 0.0.0.0 for the LAN)
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const port = Number(args.find((argument) => /^\d+$/u.test(argument)) ?? 8791)
const hostFlag = args.indexOf('--host')
const host = hostFlag >= 0 ? (args[hostFlag + 1] ?? '127.0.0.1') : '127.0.0.1'

const CONTENT_TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
}

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, `http://${host}`).pathname
    const target = resolve(HERE, decodeURIComponent(pathname).replace(/^\/+/u, ''))
    if (target !== HERE && !target.startsWith(HERE + sep)) throw new Error('outside root')
    const body = await readFile(target)
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
    })
    response.end(body)
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('not found\n')
  }
})

server.listen(port, host, () => {
  const shown = host === '0.0.0.0' ? '<this-machine-lan-ip>' : host
  console.log(`Serving ${HERE}`)
  console.log(`  index      http://${shown}:${String(port)}/index.json`)
  console.log(`  git sample http://${shown}:${String(port)}/index.git-sample.json`)
  console.log('Add one of those as an index source, then Ctrl+C to stop.')
})

server.on('error', (error) => {
  console.error(`serve.mjs: ${error.message}`)
  process.exitCode = 1
})
