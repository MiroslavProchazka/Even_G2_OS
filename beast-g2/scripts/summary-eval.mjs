#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

export const COVERAGE_TARGET = 0.9
export const CITATION_TARGET = 0.95
const MATCH_THRESHOLD = 0.6
const MIN_PREFIX = 5

const STOPWORDS = new Set(
  `a aby aj ale ani asi az bez bude budem budeme budes by bych byl byla byli bylo byt co coz
  do ho i jak jakze je jeho její jejich jen jeste jiz jsem jsme jste k kam kde kdo kdy ktery ktera ktere
  ma mate mi mit mne mnou na nad nami nas nase ne nebo nech nez o od on ona oni po pod podle pro proto
  protoze pred pres pri s se si tak take taky tady ten tento to tohle ty u uz v ve z za ze
  the a an and are as at be been but by can could did do does for from had has have if in into is it its
  may might no not of on or our shall should so than that the their then there these they this to was we
  were what when where which who will with would you your`
    .split(/\s+/)
    .filter(Boolean)
)

function normalize(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function contentTokens(text) {
  return normalize(text)
    .split(' ')
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
}

function commonPrefixLength(left, right) {
  let index = 0
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1
  return index
}

function tokensMatch(left, right) {
  return left === right || commonPrefixLength(left, right) >= MIN_PREFIX
}

function similarity(expectedText, actualText) {
  const expected = [...new Set(contentTokens(expectedText))]
  const actual = new Set(contentTokens(actualText))
  if (!expected.length || !actual.size) return { score: 0, shared: 0, total: expected.length }
  let shared = 0
  for (const token of expected) if ([...actual].some((candidate) => tokensMatch(token, candidate))) shared += 1
  return { score: shared / expected.length, shared, total: expected.length }
}

function matchItems(expectedItems, actualItems, textOf) {
  const scored = []
  expectedItems.forEach((expected, expectedIndex) => {
    actualItems.forEach((actual, actualIndex) => {
      const { score } = similarity(textOf(expected), textOf(actual))
      if (score >= MATCH_THRESHOLD) scored.push({ expectedIndex, actualIndex, score })
    })
  })
  scored.sort((left, right) => right.score - left.score || left.expectedIndex - right.expectedIndex || left.actualIndex - right.actualIndex)
  const usedExpected = new Set()
  const usedActual = new Set()
  const pairs = []
  for (const candidate of scored) {
    if (usedExpected.has(candidate.expectedIndex) || usedActual.has(candidate.actualIndex)) continue
    usedExpected.add(candidate.expectedIndex)
    usedActual.add(candidate.actualIndex)
    pairs.push(candidate)
  }
  return { pairs, missed: expectedItems.map((item, index) => ({ item, index })).filter(({ index }) => !usedExpected.has(index)) }
}

function attributeValue(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text ? text : null
}

function sameAttribute(left, right) {
  return normalize(left) === normalize(right)
}

function citationId(citation) {
  if (typeof citation === 'string') return citation
  if (citation && typeof citation === 'object' && typeof citation.turnId === 'string') return citation.turnId
  return null
}

function citationRevision(citation) {
  if (!citation || typeof citation !== 'object') return undefined
  const value = citation.turnRevision ?? citation.revision
  return Number.isInteger(value) ? value : undefined
}

function validateCitation(citation, turns, transcriptRevision) {
  const turnId = citationId(citation)
  if (!turnId) return { valid: false, reason: 'invalid_citation' }
  const turn = turns.get(turnId)
  if (!turn) return { valid: false, reason: 'unknown_turn' }
  const citedRevision = citationRevision(citation)
  if (citedRevision !== undefined && citedRevision !== turn.revision) return { valid: false, reason: 'revision_mismatch' }
  if (transcriptRevision !== undefined && transcriptRevision !== null && turn.revision !== transcriptRevision) return { valid: false, reason: 'revision_mismatch' }
  return { valid: true }
}

function checkItem(kind, index, item, turns, transcriptRevision, stats, invalid) {
  const citations = Array.isArray(item.citations) ? item.citations : []
  if (!citations.length) {
    stats.missing += 1
    invalid.push({ kind, index, citation: null, reason: 'missing_citation' })
    return { supported: false }
  }
  let valid = 0
  for (const citation of citations) {
    stats.total += 1
    const result = validateCitation(citation, turns, transcriptRevision)
    if (result.valid) {
      stats.valid += 1
      valid += 1
      continue
    }
    stats.invalid += 1
    invalid.push({ kind, index, citation: citationId(citation), reason: result.reason })
  }
  return { supported: valid > 0 }
}

function checkAttribution(expected, actual, field, pair, invented, mismatches) {
  const expectedValue = attributeValue(expected[field])
  const actualValue = attributeValue(actual[field])
  if (expectedValue === null && actualValue !== null) {
    invented.push({ kind: 'actionCandidate', index: pair.actualIndex, text: actual.text, field, expected: null, actual: actualValue })
    return
  }
  if (expectedValue !== null && (actualValue === null || !sameAttribute(expectedValue, actualValue))) {
    mismatches.push({ kind: 'actionCandidate', index: pair.actualIndex, text: actual.text, field, expected: expectedValue, actual: actualValue })
  }
}

function validateOptionalString(value, label, fail) {
  if (value === undefined || value === null) return
  if (typeof value !== 'string') fail(`${label} must be a string or null.`)
}

function validateTextList(value, label, fail) {
  if (!Array.isArray(value)) fail(`${label} must be an array.`)
  value.forEach((item, index) => {
    if (typeof item !== 'string' || !item.trim()) fail(`${label}[${index}] must be a non-empty string.`)
  })
}

function validateSummaryList(value, label, fail, { action = false } = {}) {
  if (!Array.isArray(value)) fail(`${label} must be an array.`)
  value.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`${label}[${index}] must be an object.`)
    if (typeof item.text !== 'string' || !item.text.trim()) fail(`${label}[${index}].text must be a non-empty string.`)
    if (!Array.isArray(item.citations)) fail(`${label}[${index}].citations must be an array.`)
    if (!action) return
    validateOptionalString(item.owner, `${label}[${index}].owner`, fail)
    validateOptionalString(item.due, `${label}[${index}].due`, fail)
    validateOptionalString(item.dueText, `${label}[${index}].dueText`, fail)
    if (item.conditional !== undefined && typeof item.conditional !== 'boolean') fail(`${label}[${index}].conditional must be a boolean.`)
  })
}

export function validateFixture(fixture, file = '<inline>') {
  const fail = (message) => {
    throw new Error(`${file}: ${message}`)
  }
  if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)) fail('fixture must be a JSON object.')
  if (typeof fixture.name !== 'string' || !fixture.name.trim()) fail('name must be a non-empty string.')
  if (typeof fixture.language !== 'string' || !fixture.language.trim()) fail('language must be a non-empty string.')
  if (!Array.isArray(fixture.turns)) fail('turns must be an array.')
  const turnIds = new Set()
  fixture.turns.forEach((turn, index) => {
    if (!turn || typeof turn !== 'object' || Array.isArray(turn)) fail(`turns[${index}] must be an object.`)
    if (typeof turn.id !== 'string' || !turn.id.trim()) fail(`turns[${index}].id must be a non-empty string.`)
    if (turnIds.has(turn.id)) fail(`duplicate turn id: ${turn.id}.`)
    turnIds.add(turn.id)
    if (!Number.isInteger(turn.revision) || turn.revision < 1) fail(`turns[${index}].revision must be a positive integer.`)
    if (!Number.isFinite(turn.startMs) || turn.startMs < 0) fail(`turns[${index}].startMs must be a non-negative number.`)
    if (!Number.isFinite(turn.endMs) || turn.endMs < turn.startMs) fail(`turns[${index}].endMs must be a number not smaller than startMs.`)
    if (typeof turn.text !== 'string' || !turn.text.trim()) fail(`turns[${index}].text must be a non-empty string.`)
  })
  if (!fixture.expected || typeof fixture.expected !== 'object' || Array.isArray(fixture.expected)) fail('expected must be an object.')
  validateTextList(fixture.expected.decisions, 'expected.decisions', fail)
  validateTextList(fixture.expected.openQuestions, 'expected.openQuestions', fail)
  if (!Array.isArray(fixture.expected.actionCandidates)) fail('expected.actionCandidates must be an array.')
  fixture.expected.actionCandidates.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`expected.actionCandidates[${index}] must be an object.`)
    if (typeof item.text !== 'string' || !item.text.trim()) fail(`expected.actionCandidates[${index}].text must be a non-empty string.`)
    validateOptionalString(item.owner, `expected.actionCandidates[${index}].owner`, fail)
    validateOptionalString(item.due, `expected.actionCandidates[${index}].due`, fail)
  })
  if (!fixture.summary || typeof fixture.summary !== 'object' || Array.isArray(fixture.summary)) fail('summary must be an object.')
  if (fixture.summary.schemaVersion !== 1) fail('summary.schemaVersion must be 1.')
  if (fixture.summary.transcriptRevision !== undefined && (!Number.isInteger(fixture.summary.transcriptRevision) || fixture.summary.transcriptRevision < 1))
    fail('summary.transcriptRevision must be a positive integer when present.')
  if (!fixture.summary.overview || typeof fixture.summary.overview !== 'object' || Array.isArray(fixture.summary.overview)) fail('summary.overview must be an object.')
  validateSummaryList([fixture.summary.overview], 'summary.overview', fail)
  validateSummaryList(fixture.summary.decisions, 'summary.decisions', fail)
  validateSummaryList(fixture.summary.actionCandidates, 'summary.actionCandidates', fail, { action: true })
  validateSummaryList(fixture.summary.openQuestions, 'summary.openQuestions', fail)
}

export function evaluateFixture(fixture, file = '<inline>') {
  const started = performance.now()
  validateFixture(fixture, file)
  const turns = new Map(fixture.turns.map((turn) => [turn.id, turn]))
  const transcriptRevision = fixture.summary.transcriptRevision
  const stats = { total: 0, valid: 0, invalid: 0, missing: 0 }
  const invalidCitations = []
  const inventedAttributions = []
  const attributionMismatches = []
  const failures = []

  const overview = checkItem('overview', null, fixture.summary.overview, turns, transcriptRevision, stats, invalidCitations)
  let unsupportedItems = 0
  let unsupportedDecisions = 0
  for (const [index, item] of fixture.summary.decisions.entries()) {
    const result = checkItem('decision', index, item, turns, transcriptRevision, stats, invalidCitations)
    if (!result.supported) {
      unsupportedItems += 1
      unsupportedDecisions += 1
    }
  }
  for (const [index, item] of fixture.summary.actionCandidates.entries()) {
    if (!checkItem('actionCandidate', index, item, turns, transcriptRevision, stats, invalidCitations).supported) unsupportedItems += 1
  }
  for (const [index, item] of fixture.summary.openQuestions.entries()) {
    if (!checkItem('openQuestion', index, item, turns, transcriptRevision, stats, invalidCitations).supported) unsupportedItems += 1
  }

  const decisionMatch = matchItems(fixture.expected.decisions, fixture.summary.decisions, (item) => (typeof item === 'string' ? item : item.text))
  const actionMatch = matchItems(fixture.expected.actionCandidates, fixture.summary.actionCandidates, (item) => item.text)
  const questionMatch = matchItems(fixture.expected.openQuestions, fixture.summary.openQuestions, (item) => (typeof item === 'string' ? item : item.text))

  for (const pair of actionMatch.pairs) {
    const expected = fixture.expected.actionCandidates[pair.expectedIndex]
    const actual = fixture.summary.actionCandidates[pair.actualIndex]
    checkAttribution(expected, actual, 'owner', pair, inventedAttributions, attributionMismatches)
    checkAttribution(expected, actual, 'due', pair, inventedAttributions, attributionMismatches)
  }

  for (const item of invalidCitations) {
    failures.push(`invalid citation in ${item.kind}[${item.index ?? ''}]: ${item.citation ?? 'none'} (${item.reason})`)
  }
  for (const item of inventedAttributions) {
    failures.push(`invented ${item.field} in actionCandidate[${item.index}] "${item.text}" (expected null, got "${item.actual}")`)
  }

  const expected = {
    decisions: fixture.expected.decisions.length,
    actionCandidates: fixture.expected.actionCandidates.length,
    openQuestions: fixture.expected.openQuestions.length,
    total: fixture.expected.decisions.length + fixture.expected.actionCandidates.length + fixture.expected.openQuestions.length
  }
  const matched = {
    decisions: decisionMatch.pairs.length,
    actionCandidates: actionMatch.pairs.length,
    openQuestions: questionMatch.pairs.length,
    total: decisionMatch.pairs.length + actionMatch.pairs.length + questionMatch.pairs.length
  }
  const extra = {
    decisions: fixture.summary.decisions.length - matched.decisions,
    actionCandidates: fixture.summary.actionCandidates.length - matched.actionCandidates,
    openQuestions: fixture.summary.openQuestions.length - matched.openQuestions,
    total: fixture.summary.decisions.length + fixture.summary.actionCandidates.length + fixture.summary.openQuestions.length - matched.total
  }
  const missed = [
    ...decisionMatch.missed.map(({ item }) => ({ kind: 'decision', text: item })),
    ...actionMatch.missed.map(({ item }) => ({ kind: 'actionCandidate', text: item.text })),
    ...questionMatch.missed.map(({ item }) => ({ kind: 'openQuestion', text: item }))
  ]
  const slots = stats.total + stats.missing
  const citations = { ...stats, rate: slots ? stats.valid / slots : 1 }
  const coverage = expected.total ? matched.total / expected.total : 1
  const openQuestionRecall = expected.openQuestions ? matched.openQuestions / expected.openQuestions : 1
  const inventedAttributionCount = inventedAttributions.length
  const ok = invalidCitations.length === 0 && inventedAttributionCount === 0
  const belowTarget = coverage < COVERAGE_TARGET || citations.rate < CITATION_TARGET
  return {
    name: fixture.name,
    file,
    language: fixture.language,
    turns: fixture.turns.length,
    expected,
    matched,
    extra,
    coverage,
    openQuestionRecall,
    citations,
    unsupportedItems,
    unsupportedDecisions,
    unsupportedOverview: !overview.supported,
    inventedOwnerCount: inventedAttributions.filter((item) => item.field === 'owner').length,
    inventedDueCount: inventedAttributions.filter((item) => item.field === 'due').length,
    inventedAttributionCount,
    attributionMismatchCount: attributionMismatches.length,
    missed,
    invalidCitations,
    inventedAttributions,
    attributionMismatches,
    durationMs: Number((performance.now() - started).toFixed(3)),
    ok,
    belowTarget,
    status: !ok ? 'FAIL' : belowTarget ? 'below target' : 'ok',
    failures
  }
}

export function loadFixtures(directory) {
  const absolute = resolve(directory)
  let entries
  try {
    entries = readdirSync(absolute, { withFileTypes: true })
  } catch (error) {
    throw new Error(`cannot read fixture directory ${absolute}: ${error.message}`)
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort()
  if (!files.length) throw new Error(`no .json fixtures found in ${absolute}.`)
  return files.map((file) => {
    const path = join(absolute, file)
    let fixture
    try {
      fixture = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      throw new Error(`${file}: invalid JSON (${error.message})`)
    }
    validateFixture(fixture, file)
    return { file, fixture }
  })
}

export function evaluateFixtures(entries, { fixtures = null, mode = 'replay', durationMs = 0 } = {}) {
  const cases = entries.map(({ file, fixture }) => evaluateFixture(fixture, file))
  const caseCount = cases.length
  const passedCases = cases.filter((item) => item.ok).length
  const belowTargetCases = cases.filter((item) => item.belowTarget).length
  const expectedItems = cases.reduce((sum, item) => sum + item.expected.total, 0)
  const matchedItems = cases.reduce((sum, item) => sum + item.matched.total, 0)
  const expectedQuestions = cases.reduce((sum, item) => sum + item.expected.openQuestions, 0)
  const matchedQuestions = cases.reduce((sum, item) => sum + item.matched.openQuestions, 0)
  const citationTotals = cases.reduce(
    (sum, item) => ({
      total: sum.total + item.citations.total,
      valid: sum.valid + item.citations.valid,
      invalid: sum.invalid + item.citations.invalid,
      missing: sum.missing + item.citations.missing
    }),
    { total: 0, valid: 0, invalid: 0, missing: 0 }
  )
  const citationSlots = citationTotals.total + citationTotals.missing
  const citations = { ...citationTotals, rate: citationSlots ? citationTotals.valid / citationSlots : 1 }
  const coverage = expectedItems ? matchedItems / expectedItems : 1
  const totals = {
    caseCount,
    passedCases,
    failedCases: caseCount - passedCases,
    belowTargetCases,
    expectedItems,
    matchedItems,
    coverage,
    openQuestions: { expected: expectedQuestions, matched: matchedQuestions, recall: expectedQuestions ? matchedQuestions / expectedQuestions : 1 },
    citations,
    unsupportedDecisions: cases.reduce((sum, item) => sum + item.unsupportedDecisions, 0),
    unsupportedItems: cases.reduce((sum, item) => sum + item.unsupportedItems, 0),
    unsupportedOverview: cases.filter((item) => item.unsupportedOverview).length,
    inventedOwnerCount: cases.reduce((sum, item) => sum + item.inventedOwnerCount, 0),
    inventedDueCount: cases.reduce((sum, item) => sum + item.inventedDueCount, 0),
    inventedAttributionCount: cases.reduce((sum, item) => sum + item.inventedAttributionCount, 0),
    attributionMismatchCount: cases.reduce((sum, item) => sum + item.attributionMismatchCount, 0),
    extraItems: cases.reduce((sum, item) => sum + item.extra.total, 0),
    durationMs: Number((durationMs || cases.reduce((sum, item) => sum + item.durationMs, 0)).toFixed(3))
  }
  return {
    mode,
    fixtures,
    generatedAt: new Date().toISOString(),
    targets: { coverage: COVERAGE_TARGET, citationValidity: CITATION_TARGET },
    cases,
    totals,
    targetsMet: { coverage: coverage >= COVERAGE_TARGET, citationValidity: citations.rate >= CITATION_TARGET },
    failedCases: cases.filter((item) => !item.ok).map((item) => item.name),
    belowTargetCases: cases.filter((item) => item.belowTarget).map((item) => item.name),
    ok: passedCases === caseCount
  }
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function formatReport(report) {
  const header = ['case', 'lang', 'items', 'cover', 'cite', 'unsup', 'inv', 'oq', 'ms', 'result']
  const rows = report.cases.map((item) => [
    truncate(item.name, 46),
    item.language,
    `${item.matched.total}/${item.expected.total}`,
    item.expected.total ? percent(item.coverage) : 'n/a',
    percent(item.citations.rate),
    String(item.unsupportedDecisions),
    String(item.inventedAttributionCount),
    item.expected.openQuestions ? `${item.matched.openQuestions}/${item.expected.openQuestions}` : 'n/a',
    item.durationMs.toFixed(1),
    item.status
  ])
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => row[index].length)))
  const line = (row) => row.map((value, index) => (index === 0 ? value.padEnd(widths[index]) : value.padStart(widths[index]))).join('  ')
  const lines = [`Summary quality evaluation (${report.mode}, ${report.totals.caseCount} cases)`, line(header), widths.map((width) => '-'.repeat(width)).join('  '), ...rows.map(line), '']
  const totals = report.totals
  lines.push(`Cases: ${totals.caseCount} (${totals.passedCases} ok, ${totals.failedCases} failed, ${totals.belowTargetCases} below target)`)
  lines.push(`Expected items: ${totals.expectedItems}, matched ${totals.matchedItems} (${percent(totals.coverage)})`)
  lines.push(
    `Citation validity: ${totals.citations.valid}/${totals.citations.total + totals.citations.missing} (${percent(totals.citations.rate)}), missing citation slots: ${totals.citations.missing}`
  )
  lines.push(`Unsupported decisions: ${totals.unsupportedDecisions}`)
  lines.push(`Invented owner/deadline: ${totals.inventedAttributionCount} (owner ${totals.inventedOwnerCount}, deadline ${totals.inventedDueCount})`)
  lines.push(`Open-question recall: ${totals.openQuestions.matched}/${totals.openQuestions.expected} (${percent(totals.openQuestions.recall)})`)
  lines.push(`Runtime: ${totals.durationMs.toFixed(1)} ms`)
  lines.push(`Targets (Product_spec §12): coverage >= 90%: ${report.targetsMet.coverage ? 'yes' : 'no'}; citation validity >= 95%: ${report.targetsMet.citationValidity ? 'yes' : 'no'}`)
  if (report.failedCases.length) lines.push(`Failed cases: ${report.failedCases.join('; ')}`)
  if (report.belowTargetCases.length) lines.push(`Below target: ${report.belowTargetCases.join('; ')}`)
  const missed = report.cases.flatMap((item) => item.missed.map((entry) => `${item.name}: ${entry.kind} "${entry.text}"`))
  lines.push(`Missed items:${missed.length ? '' : ' none'}`)
  for (const entry of missed) lines.push(`- ${entry}`)
  return lines.join('\n')
}

function usage() {
  console.log(`Usage: node scripts/summary-eval.mjs --fixtures <dir> --replay [--json]

Replay mode scores recorded summary fixtures offline:
  --fixtures <dir>      Directory with *.json summary fixtures
  --replay              Replay recorded summaries (no network)
  --json                Print the JSON report instead of the table

Live mode records a gateway summary into a fixture (never run in tests):
  --live                Fetch a session and its latest ready summary
  --session <id>         Session ID to record
  --gateway <url>        Gateway origin (default: GATEWAY_URL or http://127.0.0.1:8787)
  --token <token>        Gateway token (default: GATEWAY_TOKEN)
  --record <path>        Write the recorded fixture to this path
  --expected <path>       Copy expected annotations from this fixture
  --help                 Show this help

Exit codes: 0 no citation or attribution errors, 1 those errors were found,
2 the harness could not run (bad arguments, fixture or gateway response).`)
}

function parseArgs(argv) {
  const options = {
    fixtures: null,
    replay: false,
    live: false,
    json: false,
    gateway: process.env.GATEWAY_URL || 'http://127.0.0.1:8787',
    token: process.env.GATEWAY_TOKEN || '',
    session: null,
    record: null,
    expected: null,
    help: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg === '--replay') {
      options.replay = true
      continue
    }
    if (arg === '--live') {
      options.live = true
      continue
    }
    if (arg === '--json') {
      options.json = true
      continue
    }
    const value = argv[index + 1]
    if (!arg.startsWith('--') || value === undefined) throw new Error(`unknown argument: ${arg}`)
    index += 1
    if (arg === '--fixtures') options.fixtures = value
    else if (arg === '--gateway') options.gateway = value
    else if (arg === '--token') options.token = value
    else if (arg === '--session') options.session = value
    else if (arg === '--record') options.record = value
    else if (arg === '--expected') options.expected = value
    else throw new Error(`unknown option: ${arg}`)
  }
  if (options.help) return options
  if (options.replay && options.live) throw new Error('use either --replay or --live.')
  if (!options.replay && !options.live) throw new Error('use --replay or --live.')
  if (options.replay && !options.fixtures) throw new Error('--replay needs --fixtures <dir>.')
  if (options.live && !options.session) throw new Error('--live needs --session <id>.')
  if (options.live && !options.token) throw new Error('--live needs --token or GATEWAY_TOKEN.')
  if (options.record && !options.live) throw new Error('--record only applies to --live.')
  if (options.expected && !options.live) throw new Error('--expected only applies to --live.')
  return options
}

async function fetchJson(url, token) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`${url}: response is not JSON.`)
  }
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status} ${body?.message ?? ''}`.trim())
  return body
}

async function runLive(options) {
  const gateway = options.gateway.replace(/\/$/, '')
  const detail = await fetchJson(`${gateway}/api/sessions/${options.session}`, options.token)
  const latest = await fetchJson(`${gateway}/api/sessions/${options.session}/summary`, options.token)
  if (!latest.summary) throw new Error('the session has no summary; run npm run session:summary -- <id> --request first.')
  if (latest.summary.status !== 'ready') throw new Error(`the latest summary is ${latest.summary.status}, not ready.`)
  const content = latest.summary.content ?? {}
  const recorded = options.expected ? JSON.parse(readFileSync(options.expected, 'utf8')) : null
  const turns = (detail.turns ?? []).map(({ id, revision, startMs, endMs, text }) => ({ id, revision, startMs, endMs, text }))
  const fixture = {
    name: recorded?.name ?? detail.session?.name ?? `live ${options.session}`,
    language: recorded?.language ?? detail.session?.language ?? 'unknown',
    notes: `Recorded from the gateway on ${new Date().toISOString()} for session ${options.session}. Review and annotate before committing; never commit real session data without consent.`,
    turns,
    expected: recorded?.expected ?? { decisions: [], actionCandidates: [], openQuestions: [] },
    summary: {
      schemaVersion: content.schemaVersion ?? 1,
      transcriptRevision: latest.summary.transcriptRevision,
      overview: content.overview,
      decisions: content.decisions ?? [],
      actionCandidates: content.actionCandidates ?? [],
      openQuestions: content.openQuestions ?? []
    }
  }
  if (!options.record) {
    process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`)
    return
  }
  validateFixture(fixture, options.record)
  writeFileSync(options.record, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o600 })
  const items = fixture.summary.decisions.length + fixture.summary.actionCandidates.length + fixture.summary.openQuestions.length
  console.log(`Recorded ${turns.length} turns and ${items} summary items to ${options.record}.`)
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    usage()
    return 0
  }
  if (options.live) {
    await runLive(options)
    return 0
  }
  const started = performance.now()
  const entries = loadFixtures(options.fixtures)
  const report = evaluateFixtures(entries, { fixtures: resolve(options.fixtures), mode: 'replay', durationMs: performance.now() - started })
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else process.stdout.write(`${formatReport(report)}\n`)
  return report.ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      console.error(`summary-eval: ${error.message}`)
      process.exitCode = 2
    })
}
