#!/usr/bin/env node
import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { openDatabase } from '../server/sessions/db.mjs'
import { importDeletedSessions, listDeletedSessions, sweep } from '../server/sessions/retention.mjs'

const USAGE = `Usage: node scripts/retention-check.mjs [--db <file>] [--apply] [--deleted-from <file>] [--now <iso>] [--json]

Runs the audio and session retention sweep. The default is a dry run on a
temporary copy of the database: the report shows what would be deleted and the
source file does not change. --apply runs the sweep on the database itself.

--deleted-from copies the deleted-session journal from another database before the
sweep, for example from the live database into a restored backup. The restored
sessions whose ids are in that journal are removed, so a restore cannot bring them
back. The report contains counts and ids only, never transcript text.

Options:
  --db <file>            Session database (default: SESSION_DB_PATH, or
                         SESSION_DATA_DIR/sessions.sqlite)
  --apply                Delete the expired rows instead of reporting them
  --deleted-from <file>  Copy deleted session ids from this database first
  --now <iso>            Evaluate retention at this time (default: now)
  --json                 Print a machine-readable report
  --help                 Show this help`

function defaultDatabase() {
  if (process.env.SESSION_DB_PATH) return process.env.SESSION_DB_PATH
  const dataDir = process.env.SESSION_DATA_DIR || path.join(homedir(), '.local/share/beast-g2')
  return path.join(dataDir, 'sessions.sqlite')
}

function parseArgs(argv) {
  const options = { db: defaultDatabase(), apply: false, deletedFrom: '', now: Date.now(), json: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg === '--apply') {
      options.apply = true
      continue
    }
    if (arg === '--json') {
      options.json = true
      continue
    }
    const value = argv[index + 1]
    if (arg === '--db' && value !== undefined) {
      options.db = value
      index += 1
    } else if (arg === '--deleted-from' && value !== undefined) {
      options.deletedFrom = value
      index += 1
    } else if (arg === '--now' && value !== undefined) {
      const parsed = Date.parse(value)
      if (Number.isNaN(parsed)) throw new Error(`--now must be an ISO date, got ${value}.`)
      options.now = parsed
      index += 1
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return options
}

function requireDatabase(file) {
  const resolved = path.resolve(file)
  if (!existsSync(resolved)) throw new Error(`Database not found: ${resolved}`)
  if (!statSync(resolved).isFile()) throw new Error('--db must be a regular file.')
  return resolved
}

function importFrom(db, file) {
  if (!file) return 0
  const sourcePath = requireDatabase(file)
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true })
  try {
    return importDeletedSessions(db, source)
  } finally {
    source.close()
  }
}

function report(result, { mode, database, deletedFrom, now, imported, journalSize, tempCopyRemoved }) {
  return {
    mode,
    database,
    deletedFrom: deletedFrom || null,
    now: new Date(now).toISOString(),
    importedTombstones: imported,
    audioDeleted: result.audioDeleted,
    sessionsDeleted: result.sessionsDeleted,
    deletedIds: result.deletedIds,
    audioSegmentIds: result.audioSegmentIds,
    journalRows: journalSize,
    tempCopyRemoved: tempCopyRemoved ?? null
  }
}

export async function retentionCheck({ db: database, apply = false, deletedFrom = '', now = Date.now() }) {
  const databasePath = requireDatabase(database)
  if (!Number.isInteger(now)) throw new Error('now must be epoch milliseconds.')
  if (deletedFrom) requireDatabase(deletedFrom)

  if (!apply) {
    const dir = mkdtempSync(path.join(tmpdir(), 'beast-retention-'))
    const copyPath = path.join(dir, 'sessions.sqlite')
    let db
    let tempCopyRemoved = false
    try {
      const source = new Database(databasePath, { readonly: true, fileMustExist: true })
      try {
        await source.backup(copyPath)
      } finally {
        source.close()
      }
      db = openDatabase(copyPath)
      const imported = importFrom(db, deletedFrom)
      const result = sweep(db, now)
      const journalSize = listDeletedSessions(db).length
      db.close()
      db = undefined
      rmSync(dir, { recursive: true, force: true })
      tempCopyRemoved = !existsSync(dir)
      return report(result, { mode: 'dry-run', database: databasePath, deletedFrom, now, imported, journalSize, tempCopyRemoved })
    } finally {
      if (db) db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const db = openDatabase(databasePath)
  try {
    const imported = importFrom(db, deletedFrom)
    const result = sweep(db, now)
    return report(result, { mode: 'apply', database: databasePath, deletedFrom, now, imported, journalSize: listDeletedSessions(db).length })
  } finally {
    db.close()
  }
}

function printReport(result) {
  const dryRun = result.mode === 'dry-run'
  console.log(dryRun ? 'Retention dry run (no changes written)' : 'Retention applied')
  console.log(`  database: ${result.database}`)
  if (result.deletedFrom) console.log(`  deleted from: ${result.deletedFrom}`)
  console.log(`  now: ${result.now}`)
  console.log(`  imported tombstones: ${result.importedTombstones}`)
  console.log(`  audio ${dryRun ? 'to delete' : 'deleted'}: ${result.audioDeleted}`)
  console.log(`  sessions ${dryRun ? 'to delete' : 'deleted'}: ${result.sessionsDeleted}`)
  console.log(`  deleted ids: ${result.deletedIds.length ? result.deletedIds.join(', ') : 'none'}`)
  console.log(`  audio segment ids: ${result.audioSegmentIds.length ? result.audioSegmentIds.join(', ') : 'none'}`)
  console.log(`  journal rows after sweep: ${result.journalRows}`)
  if (dryRun) console.log(`  temp copy removed: ${result.tempCopyRemoved ? 'yes' : 'no'}`)
}

export async function main(argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`Retention check failed: ${error.message}`)
    console.error(USAGE)
    return 1
  }
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  try {
    const result = await retentionCheck({ db: options.db, apply: options.apply, deletedFrom: options.deletedFrom, now: options.now })
    if (options.json) console.log(JSON.stringify(result))
    else printReport(result)
    return 0
  } catch (error) {
    if (options.json) console.log(JSON.stringify({ ok: false, error: error.message }))
    else console.error(`Retention check failed: ${error.message}`)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
