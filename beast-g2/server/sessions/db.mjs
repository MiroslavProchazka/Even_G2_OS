import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { migrations } from './migrations/index.mjs'

export { migrations }

export function openDatabase(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  migrate(db)
  return db
}

export function migrate(db, registry = migrations) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)')
  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => row.version)
  )
  for (const migration of registry) {
    if (applied.has(migration.version)) continue
    db.transaction(() => {
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, Date.now())
    })()
  }
}
