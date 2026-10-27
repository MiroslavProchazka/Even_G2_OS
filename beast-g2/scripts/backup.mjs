#!/usr/bin/env node
import Database from 'better-sqlite3'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const USAGE = `Usage: node scripts/backup.mjs --source <db> --out <file> [--force]

Writes a consistent copy of the SQLite session database with the driver's
online backup API, checks the copy with PRAGMA integrity_check, and writes
<out>.manifest.json. Audio files are never copied. The output is a plain
SQLite file and is not encrypted.

Options:
  --source <db>    Source session database (opened read-only)
  --out <file>     Backup destination
  --force          Replace an existing backup and manifest
  --help           Show this help`

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export function integrityCheck(db) {
  const rows = db.pragma('integrity_check')
  const messages = rows.map((row) => String(row.integrity_check ?? '')).filter(Boolean)
  return messages.length ? messages.join('; ') : 'unknown'
}

export function readSchemaVersion(db) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()
  if (!table) return 0
  return db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get().version
}

export function countRows(db) {
  const names = {
    sessions: 'sessions',
    segments: 'segments',
    turns: 'transcript_turns',
    summaries: 'summaries',
    preparations: 'preparations'
  }
  const counts = {}
  for (const [key, table] of Object.entries(names)) {
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
    counts[key] = exists ? db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count : 0
  }
  return counts
}

function sourceBytes(file) {
  let bytes = statSync(file).size
  try {
    bytes += statSync(`${file}-wal`).size
  } catch {
    // No WAL file: the main file is the whole source.
  }
  return bytes
}

export async function backupDatabase({ source, out, force = false, now = new Date() }) {
  const sourcePath = path.resolve(source)
  const outPath = path.resolve(out)
  const manifestPath = `${outPath}.manifest.json`
  if (sourcePath === outPath) throw new Error('--out must differ from --source.')
  const sourceStat = statSync(sourcePath)
  if (!sourceStat.isFile()) throw new Error('--source must be a regular file.')
  if (!force && (existsSync(outPath) || existsSync(manifestPath))) throw new Error(`Refusing to overwrite ${outPath}. Pass --force to replace it.`)
  mkdirSync(path.dirname(outPath), { recursive: true, mode: 0o700 })

  const nonce = randomBytes(4).toString('hex')
  const tempPath = `${outPath}.tmp-${process.pid}-${nonce}`
  const tempManifestPath = `${tempPath}.manifest.json`
  const bytes = sourceBytes(sourcePath)
  let db
  try {
    db = new Database(sourcePath, { readonly: true, fileMustExist: true })
    await db.backup(tempPath)
    db.close()
    db = undefined

    const copy = new Database(tempPath, { readonly: true, fileMustExist: true })
    let integrity
    let schemaVersion
    try {
      integrity = integrityCheck(copy)
      schemaVersion = readSchemaVersion(copy)
    } finally {
      copy.close()
    }
    if (integrity !== 'ok') throw new Error(`Backup integrity check failed: ${integrity}`)

    const manifest = {
      createdAt: now.toISOString(),
      sourceBytes: bytes,
      backupBytes: statSync(tempPath).size,
      sha256: await sha256File(tempPath),
      schemaVersion,
      integrity
    }
    writeFileSync(tempManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    renameSync(tempPath, outPath)
    renameSync(tempManifestPath, manifestPath)
    return { ...manifest, out: outPath, manifestPath }
  } finally {
    if (db) db.close()
    rmSync(tempPath, { force: true })
    rmSync(tempManifestPath, { force: true })
  }
}

function parseArgs(argv) {
  const options = { source: '', out: '', force: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg === '--force') {
      options.force = true
      continue
    }
    const value = argv[index + 1]
    if (arg === '--source' && value !== undefined) {
      options.source = value
      index += 1
    } else if (arg === '--out' && value !== undefined) {
      options.out = value
      index += 1
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return options
}

export async function main(argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`Backup failed: ${error.message}`)
    console.error(USAGE)
    return 1
  }
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  if (!options.source || !options.out) {
    console.error('Backup failed: --source and --out are required.')
    console.error(USAGE)
    return 1
  }
  try {
    const result = await backupDatabase({ source: options.source, out: options.out, force: options.force })
    console.log('Backup OK')
    console.log(`  backup: ${result.out}`)
    console.log(`  manifest: ${result.manifestPath}`)
    console.log(`  bytes: ${result.backupBytes}`)
    console.log(`  sha256: ${result.sha256}`)
    console.log(`  schema version: ${result.schemaVersion}`)
    console.log(`  integrity: ${result.integrity}`)
    return 0
  } catch (error) {
    console.error(`Backup failed: ${error.message}`)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
