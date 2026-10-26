#!/usr/bin/env node
import { createReadStream, existsSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DEMO_TOKEN = 'local-demo-token-only'

function usage() {
  console.log(`Usage: node scripts/session-import.mjs <recording.wav> [options]

Options:
  --gateway <url>      Gateway origin (default: http://127.0.0.1:8787)
  --token <token>      Gateway token (default: GATEWAY_TOKEN, or the demo token with --demo)
  --demo               Use the public demo token and demo gateway
  --name <name>        Session name (default: the file name)
  --language <code>    cs, en or auto (default: cs)
  --goal <text>        Optional session goal
  --writer <id>         Writer lease id (default: cli)
  --format <format>    markdown or json (default: markdown)
  --out <path>         Write the export to a file instead of stdout
  --keep                Keep the session open instead of ending it after import
  --delete              Delete the session after exporting
  --timeout <seconds>  Wait for transcription jobs (default: 300)
  --help                Show this help`)
}

function parseArgs(argv) {
  const options = {
    gateway: process.env.GATEWAY_URL || 'http://127.0.0.1:8787',
    token: process.env.GATEWAY_TOKEN || '',
    demo: false,
    language: 'cs',
    writer: 'cli',
    format: 'markdown',
    keep: false,
    delete: false,
    timeout: 300
  }
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      usage()
      process.exit(0)
    }
    if (arg === '--demo') {
      options.demo = true
      continue
    }
    if (arg === '--keep') {
      options.keep = true
      continue
    }
    if (arg === '--delete') {
      options.delete = true
      continue
    }
    const value = argv[index + 1]
    if (!arg.startsWith('--') || value === undefined) {
      positional.push(arg)
      continue
    }
    index += 1
    const key = arg.slice(2)
    if (key === 'gateway') options.gateway = value
    else if (key === 'token') options.token = value
    else if (key === 'name') options.name = value
    else if (key === 'language') options.language = value
    else if (key === 'goal') options.goal = value
    else if (key === 'writer') options.writer = value
    else if (key === 'format') options.format = value
    else if (key === 'out') options.out = value
    else if (key === 'timeout') options.timeout = Number(value)
    else throw new Error(`Unknown option: ${arg}`)
  }
  if (positional.length !== 1) throw new Error('Provide exactly one WAV file.')
  if (!['markdown', 'json'].includes(options.format)) throw new Error('Format must be markdown or json.')
  if (!Number.isFinite(options.timeout) || options.timeout < 1) throw new Error('Timeout must be a positive number of seconds.')
  if (options.demo) options.token = DEMO_TOKEN
  if (!options.token) throw new Error('Set GATEWAY_TOKEN or pass --token.')
  return { file: positional[0], options }
}

async function request(options, pathname, init = {}) {
  const response = await fetch(`${options.gateway.replace(/\/$/, '')}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${options.token}`,
      ...(init.headers ?? {})
    }
  })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  if (!response.ok) {
    const message = body && typeof body === 'object' ? body.message || body.error : body
    throw new Error(`${response.status} ${message || response.statusText}`)
  }
  return body
}

async function main() {
  const { file, options } = parseArgs(process.argv.slice(2))
  if (!existsSync(file)) throw new Error(`File not found: ${file}`)
  const stat = statSync(file)
  if (!stat.isFile()) throw new Error(`Not a file: ${file}`)
  const name = options.name || path.basename(file, path.extname(file))
  const session = await request(options, '/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, language: options.language, goal: options.goal })
  })
  const id = session.session.id
  console.error(`Session ${id}`)
  await request(options, `/api/sessions/${id}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ writerId: options.writer })
  })
  const imported = await request(options, `/api/sessions/${id}/import`, {
    method: 'POST',
    headers: {
      'Content-Type': 'audio/wav',
      'Content-Length': String(stat.size),
      'X-Writer-Id': options.writer
    },
    body: createReadStream(file),
    duplex: 'half'
  })
  console.error(`Imported ${imported.import.segmentsAccepted} segments (${imported.import.segmentsDuplicate} duplicates, ${imported.import.receivedDurationMs} ms)`)
  if (!options.keep) {
    const lastSequence = imported.import.segmentsAccepted + imported.import.segmentsDuplicate - 1
    await request(options, `/api/sessions/${id}/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ writerId: options.writer, ...(lastSequence >= 0 ? { lastSequence } : {}) })
    })
  }
  const deadline = Date.now() + options.timeout * 1000
  let detail = await request(options, `/api/sessions/${id}`)
  while (detail.jobs.some((job) => job.state === 'pending' || job.state === 'running') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    detail = await request(options, `/api/sessions/${id}`)
  }
  const pending = detail.jobs.filter((job) => job.state === 'pending' || job.state === 'running').length
  if (pending) console.error(`Warning: ${pending} transcription jobs are still running after ${options.timeout}s.`)
  const exported = await request(options, `/api/sessions/${id}/export?format=${options.format}`)
  const output = options.format === 'json' ? JSON.stringify(exported, null, 2) : exported
  if (options.out) {
    writeFileSync(options.out, output, { mode: 0o600 })
    console.error(`Export: ${options.out}`)
  } else {
    process.stdout.write(output)
    if (!output.endsWith('\n')) process.stdout.write('\n')
  }
  if (options.delete) {
    await request(options, `/api/sessions/${id}`, { method: 'DELETE' })
    console.error(`Deleted session ${id}`)
  }
}

main().catch((error) => {
  console.error(`Import failed: ${error.message}`)
  process.exit(1)
})
