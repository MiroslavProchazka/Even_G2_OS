import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sourceFingerprint } from '../scripts/source-fingerprint.mjs'

function tree(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'beast-fingerprint-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(path.join(root, 'nested'))
  writeFileSync(path.join(root, 'a.ts'), 'export const a = 1\n')
  writeFileSync(path.join(root, 'nested', 'b.ts'), 'export const b = 2\n')
  return root
}

test('the source fingerprint hashes nested files and directories', (t) => {
  const root = tree(t)
  const first = sourceFingerprint(root, 'manifest')
  assert.match(first, /^[0-9a-f]{16}$/)
  assert.equal(sourceFingerprint(root, 'manifest'), first)
  assert.notEqual(sourceFingerprint(root, 'other manifest'), first)
})

test('a nested file changes the fingerprint and a directory is not read as a file', (t) => {
  const root = tree(t)
  const first = sourceFingerprint(root)
  writeFileSync(path.join(root, 'nested', 'b.ts'), 'export const b = 3\n')
  assert.notEqual(sourceFingerprint(root), first)
  renameSync(path.join(root, 'nested', 'b.ts'), path.join(root, 'nested', 'c.ts'))
  assert.notEqual(sourceFingerprint(root), first)
})
