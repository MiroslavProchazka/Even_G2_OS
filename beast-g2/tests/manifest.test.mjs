import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { checkManifest } from '../scripts/check-manifest.mjs'

const manifest = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'))

function withWhitelist(entries) {
  const copy = structuredClone(manifest)
  copy.permissions.find((permission) => permission.name === 'network').whitelist = entries
  return copy
}

test('the committed manifest still carries the example whitelist and is refused', () => {
  const errors = checkManifest(manifest)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /reserved example host/)
})

test('a real https origin passes', () => {
  assert.deepEqual(checkManifest(withWhitelist(['https://beast.prochmi.dev'])), [])
  assert.deepEqual(checkManifest(withWhitelist(['https://beast.prochmi.dev', 'https://g2.prochmi.dev'])), [])
})

test('plain http, relative entries and empty whitelists are refused', () => {
  assert.match(checkManifest(withWhitelist(['http://beast.prochmi.dev']))[0], /must use https/)
  assert.match(checkManifest(withWhitelist(['beast.prochmi.dev']))[0], /not an absolute URL/)
  assert.match(checkManifest(withWhitelist([]))[0], /non-empty whitelist/)
})

test('credentials, query strings and fragments are refused', () => {
  assert.match(checkManifest(withWhitelist(['https://user:pass@beast.prochmi.dev']))[0], /must not embed credentials/)
  assert.match(checkManifest(withWhitelist(['https://beast.prochmi.dev/?key=1']))[0], /query or fragment/)
  assert.match(checkManifest(withWhitelist(['https://beast.prochmi.dev/#top']))[0], /query or fragment/)
})

test('reserved example domains are refused in every form', () => {
  for (const host of ['https://example.com', 'https://gateway.example.com', 'https://example.org', 'https://beast.example.net']) {
    assert.match(checkManifest(withWhitelist([host]))[0], /reserved example host/, host)
  }
})

test('a manifest without a network permission has nothing to validate', () => {
  const copy = structuredClone(manifest)
  copy.permissions = copy.permissions.filter((permission) => permission.name !== 'network')
  assert.deepEqual(checkManifest(copy), [])
})

test('a wrong entrypoint or version is refused', () => {
  const copy = structuredClone(manifest)
  copy.entrypoint = 'main.html'
  copy.version = 'v0.5'
  const errors = checkManifest(copy)
  assert.equal(errors.length, 3)
  assert.match(errors.join('\n'), /entrypoint must be index\.html/)
  assert.match(errors.join('\n'), /semantic version/)
})
