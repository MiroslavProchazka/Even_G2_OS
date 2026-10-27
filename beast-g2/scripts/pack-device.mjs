import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { checkManifest } from './check-manifest.mjs'
import { sourceFingerprint } from './source-fingerprint.mjs'
const url = new URL(process.argv[2] || '')
if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Pass a plain HTTPS Beast API base URL without credentials.')
const manifest = JSON.parse(readFileSync('app.json', 'utf8'))
const origins = [url.origin]
if (process.argv[3]) {
  const gateway = new URL(process.argv[3])
  if (gateway.protocol !== 'https:' || gateway.username || gateway.password || gateway.search || gateway.hash || gateway.pathname !== '/')
    throw new Error('Optional gateway must be a plain HTTPS origin.')
  origins.push(gateway.origin)
}
manifest.permissions.find((p) => p.name === 'network').whitelist = [...new Set(origins)]
const errors = checkManifest(manifest)
if (errors.length) {
  console.error('Refusing to pack an unusable manifest:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}
writeFileSync('app.device.json', JSON.stringify(manifest, null, 2) + '\n')
const buildId = sourceFingerprint('src', JSON.stringify(manifest))
const build = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', env: { ...process.env, VITE_BUILD_ID: buildId, VITE_BEAST_URL: url.href.replace(/\/$/, '') } })
if (build.status !== 0) process.exit(build.status || 1)
const pack = spawnSync(process.execPath, ['node_modules/@evenrealities/evenhub-cli/main.js', 'pack', 'app.device.json', 'dist', '--sdk-ver', '0.0.16', '-o', `beast-g2-${manifest.version}.ehpk`], {
  stdio: 'inherit'
})
process.exit(pack.status ?? 1)
