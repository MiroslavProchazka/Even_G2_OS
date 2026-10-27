import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionApiError } from '../src/session-api'
import type { Session, SessionJob, SessionSummary } from '../src/session-api'
import {
  citationLabel,
  coverageLabel,
  deadlineLabel,
  describeError,
  formatClock,
  formatDate,
  formatDuration,
  formatRange,
  gapLabel,
  glassesStatus,
  jobCounts,
  languageLabel,
  latestSummary,
  pollDelay,
  sessionDurationMs,
  sessionStatusLabel,
  sortSessions,
  sourceLabel,
  summaryBadge,
  SUMMARY_POLL_BUDGET_MS,
  SUMMARY_POLL_INTERVAL_MS
} from '../src/sessions-view'

const session = (overrides: Partial<Session> = {}): Session =>
  ({
    id: 'ses_1',
    name: 'Monday call',
    source: 'import',
    language: 'cs',
    goal: '',
    prep: '',
    timezone: 'Europe/Prague',
    status: 'ended',
    captureState: 'off',
    transcriptRevision: 1,
    coverageDeclared: 'partial',
    retentionDays: 30,
    createdAt: Date.UTC(2026, 9, 26, 9, 0),
    startedAt: Date.UTC(2026, 9, 26, 9, 1),
    endedAt: Date.UTC(2026, 9, 26, 9, 11),
    expiresAt: Date.UTC(2026, 10, 25, 9, 0),
    endReason: null,
    ...overrides
  }) as Session

const summary = (overrides: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    id: 'sum_1',
    sessionId: 'ses_1',
    transcriptRevision: 1,
    generator: 'test',
    promptVersion: 'v1',
    content: {},
    coverage: {},
    status: 'ready',
    reviewStatus: 'unreviewed',
    staleReason: null,
    lastError: null,
    supersedesId: null,
    createdAt: Date.UTC(2026, 9, 26, 9, 12),
    updatedAt: Date.UTC(2026, 9, 26, 9, 12),
    readyAt: Date.UTC(2026, 9, 26, 9, 12),
    editedAt: null,
    citations: [],
    actionCandidates: [],
    ...overrides
  }) as SessionSummary

const job = (state: SessionJob['state']): SessionJob => ({ state }) as SessionJob

test('duration and transcript clock stay readable for seconds, minutes and hours', () => {
  assert.equal(formatDuration(0), '0:00')
  assert.equal(formatDuration(7_400), '0:07')
  assert.equal(formatDuration(65_000), '1:05')
  assert.equal(formatDuration(3_600_000), '1:00:00')
  assert.equal(formatDuration(3_723_000), '1:02:03')
  assert.equal(formatDuration(-5), '0:00')
  assert.equal(formatDuration(Number.NaN), '0:00')
  assert.equal(formatClock(0), '00:00')
  assert.equal(formatClock(59_999), '00:59')
  assert.equal(formatClock(65_000), '01:05')
  assert.equal(formatClock(3_600_000), '1:00:00')
  assert.equal(formatClock(-5), '00:00')
  assert.equal(formatRange(0, 30_000), '00:00 - 00:30')
  assert.equal(formatRange(30_000, null), '00:30 - unknown')
})

test('dates are local calendar dates and never invent an invalid one', () => {
  assert.equal(formatDate(Date.UTC(2026, 9, 27, 10, 0), 'UTC'), '27 Oct 2026')
  assert.equal(formatDate(new Date(Date.UTC(2026, 9, 27, 10, 0)).toISOString(), 'UTC'), '27 Oct 2026')
  assert.equal(formatDate(null), 'Unknown date')
  assert.equal(formatDate(undefined), 'Unknown date')
  assert.equal(formatDate('not-a-date'), 'Unknown date')
  assert.equal(formatDate(Date.UTC(2026, 9, 27), 'Not/AZone'), '27 Oct 2026')
})

test('an unfinished session measures to now and never returns a negative duration', () => {
  const started = session({ startedAt: 1_000, endedAt: null })
  assert.equal(sessionDurationMs(started, 61_000), 60_000)
  const draft = session({ status: 'draft', startedAt: null, endedAt: null, createdAt: 5_000 })
  assert.equal(sessionDurationMs(draft, 9_000), 4_000)
  assert.equal(sessionDurationMs(session({ startedAt: 10_000, endedAt: 5_000 }), 20_000), 0)
})

test('session status separates lifecycle from an unknown microphone', () => {
  assert.equal(sessionStatusLabel('draft'), 'Draft')
  assert.equal(sessionStatusLabel('paused'), 'Paused')
  assert.equal(sessionStatusLabel('ended'), 'Ended')
  assert.equal(sessionStatusLabel('active', 'starting'), 'Starting')
  assert.equal(sessionStatusLabel('active', 'unknown'), 'Live · mic unknown')
  assert.equal(sessionStatusLabel('active', 'on'), 'Live')
  assert.equal(sessionStatusLabel('active', 'off'), 'Live')
})

test('labels name the source, language and declared coverage', () => {
  assert.equal(sourceLabel('import'), 'Import')
  assert.equal(sourceLabel('g2'), 'G2')
  assert.equal(languageLabel('cs'), 'Czech')
  assert.equal(languageLabel('en'), 'English')
  assert.equal(languageLabel('auto'), 'Automatic')
  assert.equal(coverageLabel('unknown'), 'Coverage unknown')
  assert.equal(coverageLabel('partial'), 'Partial coverage')
  assert.equal(coverageLabel('complete'), 'Complete coverage')
})

test('summary badge reflects generation and manual edits', () => {
  assert.equal(summaryBadge(null), 'No summary')
  assert.equal(summaryBadge(undefined), 'No summary')
  assert.equal(summaryBadge(summary({ status: 'pending' })), 'Generating')
  assert.equal(summaryBadge(summary({ status: 'failed' })), 'Failed')
  assert.equal(summaryBadge(summary({ status: 'stale' })), 'Stale')
  assert.equal(summaryBadge(summary({ status: 'ready' })), 'Ready')
  assert.equal(summaryBadge(summary({ status: 'ready', reviewStatus: 'edited' })), 'Edited')
})

test('citation labels carry the timestamp and a short visible quote', () => {
  assert.equal(citationLabel({ startMs: 65_000, quote: 'We agreed to ship on Friday.' }), '[01:05] "We agreed to ship on Friday."')
  assert.equal(citationLabel({ startMs: 5_000, quote: '  spaced   words  ' }), '[00:05] "spaced words"')
  assert.equal(citationLabel({ startMs: 5_000, quote: '' }), '[00:05]')
  const long = citationLabel({ startMs: 5_000, quote: 'a'.repeat(100) })
  assert.ok(long.includes('...'))
  assert.ok(long.length < 80)
})

test('deadline labels prefer the normalized date, then the original wording, then no deadline', () => {
  assert.equal(deadlineLabel({ due: '2026-10-30', dueText: 'next week' }), '2026-10-30')
  assert.equal(deadlineLabel({ due: null, dueText: 'next week' }), 'next week')
  assert.equal(deadlineLabel({ due: null, dueText: '  ' }), 'no deadline')
  assert.equal(deadlineLabel({ due: '', dueText: null }), 'no deadline')
})

test('job counts treat running work as pending and ignore cancelled work', () => {
  assert.deepEqual(jobCounts([job('pending'), job('running'), job('failed'), job('done'), job('cancelled')]), { pending: 2, failed: 1, done: 1 })
  assert.deepEqual(jobCounts([]), { pending: 0, failed: 0, done: 0 })
})

test('sessions sort newest first without mutating the input', () => {
  const older = session({ id: 'ses_old', createdAt: 1_000 })
  const newer = session({ id: 'ses_new', createdAt: 3_000 })
  const tieA = session({ id: 'ses_a', createdAt: 2_000 })
  const tieB = session({ id: 'ses_b', createdAt: 2_000 })
  const input = [older, newer, tieB, tieA]
  const sorted = sortSessions(input)
  assert.deepEqual(
    sorted.map((item) => item.id),
    ['ses_new', 'ses_a', 'ses_b', 'ses_old']
  )
  assert.deepEqual(
    input.map((item) => item.id),
    ['ses_old', 'ses_new', 'ses_b', 'ses_a']
  )
  assert.deepEqual(sortSessions([]), [])
})

test('the latest summary is the newest version regardless of server order', () => {
  const older = summary({ id: 'sum_old', createdAt: 1_000 })
  const newer = summary({ id: 'sum_new', createdAt: 3_000 })
  assert.equal(latestSummary([older, newer])?.id, 'sum_new')
  assert.equal(latestSummary([]), null)
})

test('gap labels keep an unknown end explicit and humanize the reason', () => {
  assert.equal(gapLabel({ startMs: 30_000, endMs: 45_000, reason: 'missing_segment' }), '00:30 - 00:45 · missing segment')
  assert.equal(gapLabel({ startMs: 0, endMs: null, reason: 'stt_failed' }), '00:00 - unknown · stt failed')
})

test('glasses status is one short ASCII line for the selected session', () => {
  assert.equal(glassesStatus(null, 0, false), '')
  assert.equal(glassesStatus(null, 0, true), 'SESS - BUSY')
  assert.equal(glassesStatus(session({ status: 'active' }), 3, false), 'SESS 3 - REC')
  assert.equal(glassesStatus(session({ status: 'draft' }), 1, false), 'SESS 1 - DRAFT')
  assert.equal(glassesStatus(session({ status: 'paused' }), 2, false), 'SESS 2 - PAUSED')
  assert.equal(glassesStatus(session({ status: 'ended' }), 1, false), 'SESS 1 - ENDED')
  assert.equal(glassesStatus(session({ status: 'active' }), 1, true), 'SESS 1 - BUSY')
  for (const value of [glassesStatus(null, 0, true), glassesStatus(session(), 12, true), glassesStatus(session(), 999_999, false)]) {
    assert.match(value, /^[\x20-\x7e]+$/)
    assert.ok(value.length <= 40)
  }
})

test('polling stops after two minutes and never overshoots the budget', () => {
  assert.equal(SUMMARY_POLL_INTERVAL_MS, 2000)
  assert.equal(SUMMARY_POLL_BUDGET_MS, 120_000)
  assert.equal(pollDelay(0), 2000)
  assert.equal(pollDelay(1_000), 2000)
  assert.equal(pollDelay(118_000), 2000)
  assert.equal(pollDelay(119_000), 1_000)
  assert.equal(pollDelay(120_000), null)
  assert.equal(pollDelay(999_999), null)
  assert.equal(pollDelay(Number.NaN), 2000)
  assert.equal(pollDelay(-1), 2000)
})

test('known gateway codes map to actionable text without leaking the server message', () => {
  const codes = [
    'session_paused',
    'session_not_active',
    'writer_conflict',
    'transcription_pending',
    'session_not_ended',
    'summary_edited',
    'summary_stale',
    'no_transcript',
    'not_found',
    'unauthorized'
  ]
  const messages = new Set<string>()
  for (const code of codes) {
    const text = describeError(new SessionApiError(409, code, 'raw server detail with at /stack', 'req_1'))
    assert.ok(text.length > 20, code)
    assert.match(text, /req_1/, code)
    assert.doesNotMatch(text, /raw server detail/, code)
    assert.doesNotMatch(text, /\n\s+at /, code)
    messages.add(text)
  }
  assert.equal(messages.size, codes.length)
  assert.match(describeError(new SessionApiError(409, 'summary_edited', 'raw')), /manual edit/)
  assert.match(describeError(new SessionApiError(409, 'summary_stale', 'raw')), /stale/)
  assert.match(describeError(new SessionApiError(409, 'writer_conflict', 'raw')), /Another device/)
  assert.match(describeError(new SessionApiError(404, 'not_found', 'raw')), /deleted or expired/)
  assert.match(describeError(new SessionApiError(401, 'unauthorized', 'raw')), /API key/)
})

test('unknown failures stay short and never show a stack trace', () => {
  assert.match(describeError(new SessionApiError(500, 'http_error', 'stack at /srv/app.js:1')), /HTTP 500, http_error/)
  assert.doesNotMatch(describeError(new SessionApiError(500, 'http_error', 'stack at /srv/app.js:1')), /srv\/app/)
  assert.equal(describeError(new TypeError('fetch failed')), 'Cannot reach the gateway. Check the connection and try again.')
  assert.equal(describeError(new Error('boom')), 'Unexpected error. Refresh and try again.')
  assert.equal(describeError('boom'), 'Unexpected error. Refresh and try again.')
  assert.equal(describeError(new DOMException('aborted', 'AbortError')), 'Request cancelled.')
  assert.equal(describeError(new DOMException('timeout', 'TimeoutError')), 'The gateway did not respond in time. Try again.')
})
