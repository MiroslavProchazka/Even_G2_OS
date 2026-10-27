import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import { migrate } from '../server/sessions/db.mjs'
import { migrations } from '../server/sessions/migrations/index.mjs'

function versions(db) {
  return db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all()
    .map((row) => row.version)
}

function tempDatabase(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'beast-migration-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, file: path.join(dir, 'sessions.sqlite') }
}

test('the migration registry exposes versions 1, 2, 3 and 4 in ascending order', () => {
  assert.deepEqual(
    migrations.map((migration) => migration.version),
    [1, 2, 3, 4]
  )
  for (const migration of migrations) {
    assert.equal(typeof migration.sql, 'string')
    assert.ok(migration.sql.trim().length > 0)
  }
})

test('migrate applies the default registry to a fresh database', (t) => {
  const { file } = tempDatabase(t)
  const db = new Database(file)
  t.after(() => db.close())

  migrate(db)

  assert.deepEqual(versions(db), [1, 2, 3, 4])
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'summaries'").get())
})

test('a migration module appended to the registry is applied without editing db.mjs', async (t) => {
  const { dir, file } = tempDatabase(t)
  writeFileSync(path.join(dir, '005-seam-probe.mjs'), 'export const version = 5\nexport const sql = `\n      CREATE TABLE seam_probe (id TEXT PRIMARY KEY);\n    `\n')
  const probe = await import(pathToFileURL(path.join(dir, '005-seam-probe.mjs')).href)
  const db = new Database(file)
  t.after(() => db.close())

  migrate(db, [...migrations, probe])

  assert.deepEqual(versions(db), [1, 2, 3, 4, 5])
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'seam_probe'").get())

  migrate(db, [...migrations, probe])
  assert.deepEqual(versions(db), [1, 2, 3, 4, 5])
})
