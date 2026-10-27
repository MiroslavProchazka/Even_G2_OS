#!/usr/bin/env node
import Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { countRows, integrityCheck, readSchemaVersion, sha256File } from './backup.mjs'

const USAGE = `Usage: node scripts/restore-check.mjs --backup <file> [--manifest <file>] [--json]

Copies a backup into a temporary directory, opens the copy read-only, runs
PRAGMA integrity_check, counts sessions and derived records, and verifies the
manifest checksum and schema version. The temporary copy is always removed.
The report contains counts only, never session text.

Options:
  --backup <file>      Backup file written by scripts/backup.mjs
  --manifest <file>    Manifest (default: <backup>.manifest.json)
  --json               Print a machine-readable report
  --help               Show this help`

function requireField(manifest, key, check, description) {
  if (!check(manifest[key])) throw new Error(`Manifest field ${key} must be ${description}.`)
}

function readManifest(file) {
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  requireField(manifest, 'createdAt', (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)), 'an ISO date')
  requireField(manifest, 'sourceBytes', (value) => Number.isInteger(value) && value >= 0, 'a non-negative integer')
  requireField(manifest, 'backupBytes', (value) => Number.isInteger(value) && value > 0, 'a positive integer')
  requireField(manifest, 'sha256', (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), 'a hex SHA-256')
  requireField(manifest, 'schemaVersion', (value) => Number.isInteger(value) && value >= 0, 'a non-negative integer')
  requireField(manifest, 'integrity', (value) => typeof value === 'string', 'a string')
  return manifest
}

export async function restoreCheck({ backup, manifest: manifestPath }) {
  const backupPath = path.resolve(backup)
  const manifestFile = path.resolve(manifestPath ?? `${backupPath}.manifest.json`)
  if (!statSync(backupPath).isFile()) throw new Error('--backup must be a regular file.')
  if (!existsSync(manifestFile)) throw new Error(`Manifest not found: ${manifestFile}`)
  const manifest = readManifest(manifestFile)

  const dir = mkdtempSync(path.join(tmpdir(), 'beast-restore-'))
  const restored = path.join(dir, 'restored.sqlite')
  let failure
  let report
  try {
    copyFileSync(backupPath, restored)
    const bytes = statSync(restored).size
    if (bytes !== manifest.backupBytes) throw new Error(`Backup size ${bytes} does not match the manifest (${manifest.backupBytes}).`)
    const sha256 = await sha256File(restored)
    if (sha256 !== manifest.sha256) throw new Error('Backup checksum does not match the manifest.')

    const db = new Database(restored, { readonly: true, fileMustExist: true })
    try {
      const integrity = integrityCheck(db)
      if (integrity !== 'ok') throw new Error(`Integrity check failed: ${integrity}`)
      if (manifest.integrity !== 'ok') throw new Error(`Manifest records a failed integrity check: ${manifest.integrity}`)
      const schemaVersion = readSchemaVersion(db)
      if (schemaVersion !== manifest.schemaVersion) throw new Error(`Schema version mismatch: manifest ${manifest.schemaVersion}, backup ${schemaVersion}.`)
      report = {
        ok: true,
        backup: backupPath,
        manifest: manifestFile,
        bytes,
        sha256,
        schemaVersion,
        integrity,
        counts: countRows(db),
        createdAt: manifest.createdAt,
        tempRemoved: false
      }
    } finally {
      db.close()
    }
  } catch (error) {
    failure = error
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      if (!failure) failure = error
    }
  }
  if (failure) throw failure
  report.tempRemoved = !existsSync(dir)
  if (!report.tempRemoved) throw new Error(`Temporary restore copy was not removed: ${dir}`)
  return report
}

function parseArgs(argv) {
  const options = { backup: '', manifest: '', json: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg === '--json') {
      options.json = true
      continue
    }
    const value = argv[index + 1]
    if (arg === '--backup' && value !== undefined) {
      options.backup = value
      index += 1
    } else if (arg === '--manifest' && value !== undefined) {
      options.manifest = value
      index += 1
    } else if (!arg.startsWith('--') && !options.backup) {
      options.backup = arg
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
    console.error(`Restore check failed: ${error.message}`)
    console.error(USAGE)
    return 1
  }
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  if (!options.backup) {
    console.error('Restore check failed: --backup is required.')
    console.error(USAGE)
    return 1
  }
  try {
    const report = await restoreCheck({ backup: options.backup, manifest: options.manifest || undefined })
    if (options.json) {
      console.log(JSON.stringify(report))
    } else {
      console.log('Restore check OK')
      console.log(`  backup: ${report.backup}`)
      console.log(`  bytes: ${report.bytes}`)
      console.log(`  sha256: ${report.sha256}`)
      console.log(`  schema version: ${report.schemaVersion}`)
      console.log(`  integrity: ${report.integrity}`)
      console.log(`  sessions: ${report.counts.sessions}`)
      console.log(`  segments: ${report.counts.segments}`)
      console.log(`  turns: ${report.counts.turns}`)
      console.log(`  summaries: ${report.counts.summaries}`)
      console.log(`  preparations: ${report.counts.preparations}`)
      console.log(`  temp copy removed: ${report.tempRemoved ? 'yes' : 'no'}`)
    }
    return 0
  } catch (error) {
    if (options.json) console.log(JSON.stringify({ ok: false, error: error.message }))
    else console.error(`Restore check failed: ${error.message}`)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
