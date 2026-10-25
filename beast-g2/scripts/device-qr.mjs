import { networkInterfaces } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'

// Use the QR encoder shipped as a dependency of the official Even Hub CLI.
const cli = new URL('../node_modules/@evenrealities/evenhub-cli/main.js', import.meta.url)
const require = createRequire(cli)
const qr = require('qr-image')
const addresses = Object.entries(networkInterfaces())
  .filter(([name]) => !/^(utun|tun|tap|awdl|llw|lo)/.test(name))
  .flatMap(([, entries]) => entries ?? [])
  .filter(entry => entry.family === 'IPv4' && !entry.internal)
const supplied = process.argv[2]
if (!supplied && addresses.length !== 1) {
  console.error('Pass the Mac LAN URL explicitly: npm run qr -- http://<Mac-IP>:5173')
  console.error('Available addresses:', addresses.map(entry => entry.address).join(', ') || 'none')
  process.exit(1)
}
const url = new URL(supplied ?? `http://${addresses[0].address}:5173`)
if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Expected an HTTP(S) development URL')
const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
if (!response.ok) throw new Error(`Development server returned HTTP ${response.status}; run npm run dev first`)
const dir = new URL('../.dev/', import.meta.url)
mkdirSync(dir, { recursive: true })
writeFileSync(new URL('device-qr.png', dir), qr.imageSync(url.href, { type: 'png', size: 8 }))
writeFileSync(new URL('device-url.txt', dir), `${url.href}\n`)
console.log(`Phone and Mac must be on the same Wi-Fi. Open in phone browser first: ${url.href}`)
console.log('QR image: .dev/device-qr.png — scan inside Even Realities Developer/Prototype Mode.')
const result = spawnSync(process.execPath, [cli.pathname, 'qr', '--url', url.href], { stdio: 'inherit' })
process.exit(result.status ?? 1)
