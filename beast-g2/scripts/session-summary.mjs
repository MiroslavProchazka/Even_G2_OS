#!/usr/bin/env node
import { writeFileSync } from 'node:fs'

const DEMO_TOKEN = 'local-demo-token-only'

function usage() {
  console.log(`Usage: node scripts/session-summary.mjs <session-id> [options]

Options:
  --gateway <url>       Gateway origin (default: http://127.0.0.1:8787)
  --token <token>       Gateway token (default: GATEWAY_TOKEN, or the demo token with --demo)
  --demo                Use the public demo token
  --request             Request a summary and wait for it to finish
  --wait                Wait for an existing pending summary
  --allow-partial       Allow a summary before the session ends
  --force               Create a new version even if one exists
  --summary <id>         Use this summary for --prepare (default: latest ready)
  --prepare             Create a preparation snapshot from a ready summary
  --focus <text>         Preparation focus, at most 4000 characters
  --out <path>           Write the summary JSON to a file
  --prep-out <path>      Write the preparation JSON to a file
  --timeout <seconds>    Wait limit (default: 300)
  --help                 Show this help`)
}

function parseArgs(argv) {
  const options = {
    gateway: process.env.GATEWAY_URL || 'http://127.0.0.1:8787',
    token: process.env.GATEWAY_TOKEN || '',
    demo: false,
    request: false,
    wait: false,
    allowPartial: false,
    force: false,
    prepare: false,
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
    if (arg === '--request') {
      options.request = true
      continue
    }
    if (arg === '--wait') {
      options.wait = true
      continue
    }
    if (arg === '--allow-partial') {
      options.allowPartial = true
      continue
    }
    if (arg === '--force') {
      options.force = true
      continue
    }
    if (arg === '--prepare') {
      options.prepare = true
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
    else if (key === 'summary') options.summary = value
    else if (key === 'focus') options.focus = value
    else if (key === 'out') options.out = value
    else if (key === 'prep-out') options.prepOut = value
    else if (key === 'timeout') options.timeout = Number(value)
    else throw new Error(`Unknown option: ${arg}`)
  }
  if (positional.length !== 1) throw new Error('Provide exactly one session ID.')
  if (!Number.isFinite(options.timeout) || options.timeout < 1) throw new Error('Timeout must be a positive number of seconds.')
  if (options.demo) options.token = DEMO_TOKEN
  if (!options.token) throw new Error('Set GATEWAY_TOKEN or pass --token.')
  return { sessionId: positional[0], options }
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

async function waitForSummary(options, sessionId) {
  const deadline = Date.now() + options.timeout * 1000
  while (Date.now() < deadline) {
    const result = await request(options, `/api/sessions/${sessionId}/summary`)
    if (result.summary && result.summary.status !== 'pending') return result.summary
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`Summary did not finish within ${options.timeout}s.`)
}

async function main() {
  const { sessionId, options } = parseArgs(process.argv.slice(2))
  let summary = null
  if (options.request) {
    const requested = await request(options, `/api/sessions/${sessionId}/summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowPartial: options.allowPartial, force: options.force })
    })
    console.error(`Summary ${requested.summary.id}: ${requested.summary.status}`)
    summary = requested.summary
  }
  if (options.request || options.wait) summary = await waitForSummary(options, sessionId)
  if (!summary) {
    const latest = await request(options, `/api/sessions/${sessionId}/summary`)
    summary = latest.summary
  }
  if (!summary) throw new Error('The session has no summary.')
  if (options.out) {
    writeFileSync(options.out, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 })
    console.error(`Summary: ${options.out}`)
  }
  let preparation = null
  if (options.prepare) {
    const source = options.summary ? { id: options.summary } : summary.status === 'ready' ? { id: summary.id } : null
    if (!source) throw new Error('Only a ready summary can be used as preparation.')
    const created = await request(options, `/api/sessions/${sessionId}/preparation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceSummaryId: source.id, focus: options.focus })
    })
    preparation = created.preparation
    if (options.prepOut) {
      writeFileSync(options.prepOut, `${JSON.stringify(preparation, null, 2)}\n`, { mode: 0o600 })
      console.error(`Preparation: ${options.prepOut}`)
    }
  }
  if (!options.out || (preparation && !options.prepOut)) {
    const output = preparation ?? summary
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  }
}

main().catch((error) => {
  console.error(`Summary failed: ${error.message}`)
  process.exit(1)
})
