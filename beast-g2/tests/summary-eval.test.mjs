import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateFixture, evaluateFixtures, formatReport, loadFixtures, validateFixture } from '../scripts/summary-eval.mjs'

const scriptPath = fileURLToPath(new URL('../scripts/summary-eval.mjs', import.meta.url))
const fixturesDir = fileURLToPath(new URL('./fixtures/summary-eval', import.meta.url))
const temporaryDirectories = []

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true })
})

function turnId(character, index = 1) {
  return `turn_${character.repeat(31)}${index}`
}

function fixture(overrides = {}) {
  const decisionTurn = turnId('a')
  const actionTurn = turnId('b')
  return {
    name: 'perfect case',
    language: 'cs',
    turns: [
      { id: decisionTurn, revision: 1, startMs: 0, endMs: 1000, text: 'Rozhodli jsme se najmout nového vývojáře.' },
      { id: actionTurn, revision: 1, startMs: 1000, endMs: 2000, text: 'Petra připraví inzerát do pátku.' }
    ],
    expected: {
      decisions: ['Najmout nového vývojáře'],
      actionCandidates: [{ text: 'Připravit inzerát', owner: 'Petra', due: '2026-11-06' }],
      openQuestions: ['Kdo schválí rozpočet']
    },
    summary: {
      schemaVersion: 1,
      transcriptRevision: 1,
      overview: { text: 'Tým se rozhodl najmout nového vývojáře.', citations: [decisionTurn] },
      decisions: [{ text: 'Najmout nového vývojáře.', citations: [decisionTurn] }],
      actionCandidates: [{ text: 'Petra připraví inzerát do pátku.', owner: 'Petra', due: '2026-11-06', dueText: 'do pátku', conditional: false, citations: [actionTurn] }],
      openQuestions: [{ text: 'Kdo schválí rozpočet?', citations: [decisionTurn] }]
    },
    ...overrides
  }
}

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'summary-eval-'))
  temporaryDirectories.push(directory)
  return directory
}

function writeFixture(directory, name, value) {
  writeFileSync(join(directory, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`)
}

function runCli(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' })
}

test('a perfect fixture has full coverage and no citation errors', () => {
  const result = evaluateFixture(fixture(), 'perfect.json')
  assert.equal(result.expected.total, 3)
  assert.equal(result.matched.total, 3)
  assert.equal(result.coverage, 1)
  assert.equal(result.openQuestionRecall, 1)
  assert.equal(result.citations.total, 4)
  assert.equal(result.citations.valid, 4)
  assert.equal(result.citations.rate, 1)
  assert.equal(result.unsupportedDecisions, 0)
  assert.equal(result.inventedAttributionCount, 0)
  assert.equal(result.missed.length, 0)
  assert.equal(result.ok, true)
  assert.equal(result.belowTarget, false)
  assert.equal(result.status, 'ok')
})

test('a missing citation is reported and fails the case', () => {
  const value = fixture()
  value.summary.decisions[0].citations = [turnId('f')]
  const result = evaluateFixture(value, 'missing-citation.json')
  assert.equal(result.citations.invalid, 1)
  assert.equal(result.citations.rate, 3 / 4)
  assert.equal(result.unsupportedDecisions, 1)
  assert.equal(result.invalidCitations.length, 1)
  assert.equal(result.invalidCitations[0].reason, 'unknown_turn')
  assert.equal(result.ok, false)
  assert.equal(result.status, 'FAIL')
  assert.match(result.failures[0], /invalid citation in decision/)
})

test('a decision without any citation counts as unsupported and fails', () => {
  const value = fixture()
  value.summary.decisions[0].citations = []
  const result = evaluateFixture(value, 'no-citation.json')
  assert.equal(result.citations.missing, 1)
  assert.equal(result.citations.rate, 3 / 4)
  assert.equal(result.unsupportedDecisions, 1)
  assert.equal(result.invalidCitations[0].reason, 'missing_citation')
  assert.equal(result.ok, false)
})

test('a citation whose turn revision does not match the summary revision fails', () => {
  const value = fixture()
  value.summary.decisions[0].citations = [{ turnId: value.turns[0].id, turnRevision: 2 }]
  const result = evaluateFixture(value, 'revision-mismatch.json')
  assert.equal(result.citations.invalid, 1)
  assert.equal(result.invalidCitations[0].reason, 'revision_mismatch')
  assert.equal(result.ok, false)
})

test('a citation object must match both the turn and its revision', () => {
  const value = fixture()
  value.summary.decisions[0].citations = [{ turnId: value.turns[0].id, turnRevision: 2 }]
  const result = evaluateFixture(value, 'citation-object.json')
  assert.equal(result.invalidCitations[0].reason, 'revision_mismatch')
  const valid = fixture()
  valid.summary.decisions[0].citations = [{ turnId: valid.turns[0].id, turnRevision: 1 }]
  assert.equal(evaluateFixture(valid, 'citation-object-valid.json').ok, true)
})

test('an invented owner and deadline are counted and fail the case', () => {
  const value = fixture()
  value.expected.actionCandidates[0].owner = null
  value.expected.actionCandidates[0].due = null
  value.summary.actionCandidates[0].owner = 'Petr'
  value.summary.actionCandidates[0].due = '2026-12-01'
  const result = evaluateFixture(value, 'invented-attribution.json')
  assert.equal(result.inventedOwnerCount, 1)
  assert.equal(result.inventedDueCount, 1)
  assert.equal(result.inventedAttributionCount, 2)
  assert.equal(result.inventedAttributions.length, 2)
  assert.equal(result.ok, false)
  assert.equal(result.status, 'FAIL')
  assert.match(result.failures.join('\n'), /invented owner/)
  assert.match(result.failures.join('\n'), /invented due/)
})

test('a wrong but non-invented owner is reported without failing the run', () => {
  const value = fixture()
  value.summary.actionCandidates[0].owner = 'Jana'
  const result = evaluateFixture(value, 'wrong-owner.json')
  assert.equal(result.inventedOwnerCount, 0)
  assert.equal(result.attributionMismatchCount, 1)
  assert.equal(result.ok, true)
  assert.equal(result.status, 'ok')
})

test('a case with no expected items scores full coverage by convention', () => {
  const value = fixture({
    turns: [{ id: turnId('c'), revision: 1, startMs: 0, endMs: 1000, text: 'Byli jsme na obědě.' }],
    expected: { decisions: [], actionCandidates: [], openQuestions: [] },
    summary: {
      schemaVersion: 1,
      transcriptRevision: 1,
      overview: { text: 'Krátké povídání bez rozhodnutí.', citations: [turnId('c')] },
      decisions: [],
      actionCandidates: [],
      openQuestions: []
    }
  })
  const result = evaluateFixture(value, 'empty.json')
  assert.equal(result.expected.total, 0)
  assert.equal(result.coverage, 1)
  assert.equal(result.openQuestionRecall, 1)
  assert.equal(result.ok, true)
  assert.equal(result.status, 'ok')
})

test('a malformed fixture is rejected with the file name', () => {
  const value = fixture({ expected: { decisions: [], actionCandidates: [], openQuestions: [] } })
  value.summary.schemaVersion = 2
  assert.throws(() => validateFixture(value, 'broken.json'), /broken\.json: summary\.schemaVersion must be 1/)
})

test('the shipped fixture set loads and stays above the Product_spec targets', () => {
  const entries = loadFixtures(fixturesDir)
  const report = evaluateFixtures(entries, { fixtures: fixturesDir })
  assert.ok(report.totals.caseCount >= 10)
  assert.equal(report.totals.caseCount, 11)
  assert.equal(report.ok, true)
  assert.equal(report.totals.failedCases, 0)
  assert.equal(report.totals.inventedAttributionCount, 0)
  assert.equal(report.totals.citations.invalid, 0)
  assert.equal(report.totals.citations.rate, 1)
  assert.ok(report.totals.coverage >= 0.9)
  assert.equal(report.belowTargetCases.length, 1)
  assert.match(report.belowTargetCases[0], /long meeting/)
  assert.match(formatReport(report), /Missed items:\n- long meeting/)
})

test('the CLI exits 0 for a perfect fixture and prints the table', () => {
  const directory = temporaryDirectory()
  writeFixture(directory, 'perfect', fixture())
  const result = runCli(['--fixtures', directory, '--replay'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Summary quality evaluation \(replay, 1 cases\)/)
  assert.match(result.stdout, /perfect case/)
  assert.match(result.stdout, /Cases: 1 \(1 ok, 0 failed, 0 below target\)/)
})

test('the CLI exits 1 for an invalid citation and for an invented owner', () => {
  const invalidDirectory = temporaryDirectory()
  const invalid = fixture()
  invalid.summary.decisions[0].citations = [turnId('f')]
  writeFixture(invalidDirectory, 'invalid', invalid)
  const invalidResult = runCli(['--fixtures', invalidDirectory, '--replay'])
  assert.equal(invalidResult.status, 1, invalidResult.stderr)
  assert.match(invalidResult.stdout, /FAIL/)

  const inventedDirectory = temporaryDirectory()
  const invented = fixture()
  invented.expected.actionCandidates[0].owner = null
  invented.summary.actionCandidates[0].owner = 'Petr'
  writeFixture(inventedDirectory, 'invented', invented)
  const inventedResult = runCli(['--fixtures', inventedDirectory, '--replay'])
  assert.equal(inventedResult.status, 1, inventedResult.stderr)
  assert.match(inventedResult.stdout, /Invented owner\/deadline: 1/)
})

test('the CLI JSON report is machine-readable and carries the same verdict', () => {
  const directory = temporaryDirectory()
  const invalid = fixture()
  invalid.summary.decisions[0].citations = [turnId('f')]
  writeFixture(directory, 'invalid', invalid)
  const result = runCli(['--fixtures', directory, '--replay', '--json'])
  assert.equal(result.status, 1, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.ok, false)
  assert.equal(report.totals.caseCount, 1)
  assert.equal(report.totals.citations.invalid, 1)
  assert.equal(report.totals.unsupportedDecisions, 1)
  assert.equal(report.cases[0].invalidCitations[0].reason, 'unknown_turn')

  const perfectDirectory = temporaryDirectory()
  writeFixture(perfectDirectory, 'perfect', fixture())
  const perfectResult = runCli(['--fixtures', perfectDirectory, '--replay', '--json'])
  assert.equal(perfectResult.status, 0, perfectResult.stderr)
  const perfectReport = JSON.parse(perfectResult.stdout)
  assert.equal(perfectReport.ok, true)
  assert.equal(perfectReport.cases[0].coverage, 1)
})

test('the CLI exits 2 for a missing fixture directory or malformed fixture', () => {
  const missing = runCli(['--fixtures', join(tmpdir(), 'summary-eval-does-not-exist'), '--replay'])
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /cannot read fixture directory/)

  const directory = temporaryDirectory()
  writeFixture(directory, 'broken', { name: 'broken' })
  const malformed = runCli(['--fixtures', directory, '--replay'])
  assert.equal(malformed.status, 2)
  assert.match(malformed.stderr, /broken\.json: language must be a non-empty string/)
})

test('the shipped CLI command exits 0', () => {
  const result = runCli(['--fixtures', fixturesDir, '--replay'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Expected items: 20, matched 19 \(95\.0%\)/)
  assert.match(formatReport(evaluateFixtures(loadFixtures(fixturesDir))), /Targets \(Product_spec §12\): coverage >= 90%: yes/)
})
