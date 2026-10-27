import { SessionApiError } from './session-api'
import type {
  CaptureState,
  CoverageDeclared,
  Session,
  SessionGap,
  SessionJob,
  SessionLanguage,
  SessionSource,
  SessionStatus,
  SessionSummary,
  SummaryActionCandidate,
  SummaryCitation
} from './session-api'

/** The phone polls a pending summary every two seconds and stops after two minutes. */
export const SUMMARY_POLL_INTERVAL_MS = 2000
export const SUMMARY_POLL_BUDGET_MS = 120000

function whole(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

function pad(value: number) {
  return String(value).padStart(2, '0')
}

/** Compact duration for lists and metadata: 0:07, 12:34, 1:02:03. */
export function formatDuration(ms: number): string {
  const total = Math.floor(whole(ms) / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

/** Fixed-width transcript clock: 00:00, 01:05, 1:02:03. */
export function formatClock(ms: number): string {
  const total = Math.floor(whole(ms) / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

/** A gap interval, with an unknown end kept explicit instead of invented. */
export function formatRange(startMs: number, endMs: number | null | undefined): string {
  return `${formatClock(startMs)} - ${endMs === null || endMs === undefined ? 'unknown' : formatClock(endMs)}`
}

/** Local calendar date; an invalid or missing value is not presented as a real date. */
export function formatDate(value: number | string | null | undefined, timeZone?: string): string {
  if (value === null || value === undefined || value === '') return 'Unknown date'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown date'
  const options: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', year: 'numeric' }
  try {
    return new Intl.DateTimeFormat('en-GB', timeZone ? { ...options, timeZone } : options).format(date)
  } catch {
    return new Intl.DateTimeFormat('en-GB', options).format(date)
  }
}

/** An unfinished session measures from its start (or creation) to now. */
export function sessionDurationMs(session: Pick<Session, 'createdAt' | 'startedAt' | 'endedAt'>, now: number): number {
  const start = session.startedAt ?? session.createdAt
  const end = session.endedAt ?? now
  return Math.max(0, whole(end) - whole(start))
}

export function sessionStatusLabel(status: SessionStatus, capture?: CaptureState): string {
  if (status === 'draft') return 'Draft'
  if (status === 'paused') return 'Paused'
  if (status === 'ended') return 'Ended'
  if (capture === 'starting') return 'Starting'
  if (capture === 'unknown') return 'Live · mic unknown'
  return 'Live'
}

export function sourceLabel(source: SessionSource): string {
  return source === 'g2' ? 'G2' : 'Import'
}

export function languageLabel(language: SessionLanguage): string {
  return language === 'cs' ? 'Czech' : language === 'en' ? 'English' : 'Automatic'
}

export function coverageLabel(coverage: CoverageDeclared): string {
  return coverage === 'complete' ? 'Complete coverage' : coverage === 'partial' ? 'Partial coverage' : 'Coverage unknown'
}

export function summaryBadge(summary: SessionSummary | null | undefined): string {
  if (!summary) return 'No summary'
  if (summary.status === 'pending') return 'Generating'
  if (summary.status === 'failed') return 'Failed'
  if (summary.status === 'stale') return 'Stale'
  return summary.reviewStatus === 'edited' ? 'Edited' : 'Ready'
}

/** A short visible label for a citation chip: [01:05] "quoted words". */
export function citationLabel(citation: Pick<SummaryCitation, 'startMs' | 'quote'>): string {
  const stamp = `[${formatClock(citation.startMs)}]`
  const quote = (citation.quote ?? '').trim().replace(/\s+/g, ' ')
  if (!quote) return stamp
  return `${stamp} "${quote.length > 60 ? `${quote.slice(0, 57)}...` : quote}"`
}

/** The explicit deadline, the original relative wording, or an honest "no deadline". */
export function deadlineLabel(candidate: Pick<SummaryActionCandidate, 'due' | 'dueText'>): string {
  return candidate.due?.trim() || candidate.dueText?.trim() || 'no deadline'
}

export function jobCounts(jobs: SessionJob[]): { pending: number; failed: number; done: number } {
  let pending = 0,
    failed = 0,
    done = 0
  for (const job of jobs) {
    if (job.state === 'pending' || job.state === 'running') pending++
    else if (job.state === 'failed') failed++
    else if (job.state === 'done') done++
  }
  return { pending, failed, done }
}

/** Newest first; the server already sorts, but the UI never depends on that. */
export function sortSessions(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
}

export function latestSummary(summaries: SessionSummary[]): SessionSummary | null {
  if (!summaries.length) return null
  return [...summaries].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))[0] ?? null
}

export function gapLabel(gap: Pick<SessionGap, 'startMs' | 'endMs' | 'reason'>): string {
  return `${formatRange(gap.startMs, gap.endMs)} · ${gap.reason.replaceAll('_', ' ')}`
}

/** One ASCII line for the glasses, at most 40 characters. */
export function glassesStatus(session: Session | null, position: number, busy: boolean): string {
  if (!session) return busy ? 'SESS - BUSY' : ''
  const index = Number.isFinite(position) ? Math.max(1, Math.trunc(position)) : 1
  const state = busy ? 'BUSY' : session.status === 'draft' ? 'DRAFT' : session.status === 'active' ? 'REC' : session.status === 'paused' ? 'PAUSED' : 'ENDED'
  return `SESS ${index} - ${state}`.slice(0, 40)
}

/** Milliseconds until the next poll, or null when the two-minute budget is spent. */
export function pollDelay(elapsedMs: number): number | null {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return SUMMARY_POLL_INTERVAL_MS
  if (elapsedMs >= SUMMARY_POLL_BUDGET_MS) return null
  return Math.min(SUMMARY_POLL_INTERVAL_MS, SUMMARY_POLL_BUDGET_MS - elapsedMs)
}

const errorMessages: Record<string, string> = {
  session_paused: 'Session is paused. Resume it before starting or sending audio.',
  session_not_active: 'Session is not active. Start or resume it first.',
  writer_conflict: 'Another device is writing this session. Wait for its lease to expire or close it there.',
  transcription_pending: 'Transcription is still running. Wait for it, or allow a partial summary.',
  session_not_ended: 'End the session before requesting a summary, or allow a partial summary.',
  summary_edited: 'The summary has a manual edit. Regenerate with force to replace it.',
  summary_stale: 'The summary is stale. Regenerate it from the current transcript.',
  no_transcript: 'The session has no final transcript yet. Wait for transcription or import audio.',
  not_found: 'Session not found. It may have been deleted or expired.',
  unauthorized: 'Enter the API key or gateway token first.',
  invalid_state: 'The session is not in a state for this action. Refresh and check its status.',
  session_ended: 'The session has ended. Create a new session instead.',
  summary_not_ready: 'The summary is not ready yet. Wait for it to finish.',
  sessions_disabled: 'Stored sessions are not enabled on this gateway.',
  summaries_disabled: 'Summaries are not enabled on this gateway.',
  summary_too_large: 'The transcript is too large to summarize in one request.'
}

export class RecorderError extends Error {}

/** Actionable text for a gateway failure. Never includes a stack trace or exception message. */
export function describeError(error: unknown): string {
  if (error instanceof RecorderError) return error.message
  if (error instanceof SessionApiError) {
    const text = errorMessages[error.code] ?? `The gateway rejected the request (HTTP ${error.status}, ${error.code}). Try again.`
    return error.requestId ? `${text} Request ${error.requestId}.` : text
  }
  if (error instanceof DOMException && error.name === 'AbortError') return 'Request cancelled.'
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'The gateway did not respond in time. Try again.'
  if (error instanceof TypeError) return 'Cannot reach the gateway. Check the connection and try again.'
  return 'Unexpected error. Refresh and try again.'
}
