// Questions over one stored session. The answer is built only from that session's final transcript and
// its existing summary; every answer must point at a turn that exists at its current revision. This module
// is read-only: it never writes a turn, summary or session row.
import { ApiError } from '../errors.mjs'
import { searchSessions, tokenizeQuery } from './search.mjs'

export const QA_LIMITS = {
  qaMaxQuestionChars: 500,
  qaMaxTurns: 20,
  qaMaxChars: 12000,
  qaMaxAnswerChars: 4000,
  qaMaxSummaryChars: 4000,
  qaTimeoutMs: 30000,
  qaSearchLimit: 50
}

export const INSUFFICIENT_ANSWER = 'The transcript does not contain enough evidence to answer this question.'

const SESSION_ID = /^ses_[a-f0-9]{32}$/
const MAX_QUOTE_CHARS = 600
const MAX_SUMMARY_ITEM_CHARS = 400
const MAX_SUMMARY_ITEMS = 5

// Czech and English function words. `searchSessions` ANDs every token, so a natural question rarely
// matches one turn; the fallback retries with these words removed. The list is deliberately small and
// only affects candidate selection, never the answer itself.
// One string keeps the list compact; `normalize` handles case and diacritics before the lookup.
const STOPWORDS = new Set(
  'a až az aby ale ani ano asi bez bude budem budeš budes by byl byla bylo být byt co či ci do ho i jak jaký jaky je jeho jejich jen ještě jeste ji jich jsme jsou k kam kde kdo kdy když kdyz ke která ktera které ktere který ktery má ma máme mame mezi mi mít mit mně mne můj muj my na nad nám nam náš nas ne nebo než nez ní ni o od on ona oni ono pak po pod pro před pred přes pres pri při s se si sme své sve ta tak také take tam te tedy ten tento to tohle tom tu tuto ty u už uz v ve ví vi vy z za ze že about and are did for from how the was were what when where which who why with'.split(
    ' '
  )
)

function message(error) {
  return error instanceof Error && error.message ? error.message.slice(0, 500) : 'Answer generation failed.'
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

/** Case- and diacritics-insensitive text, so `rozpoctu` and `rozpočtu` compare equal. */
function normalize(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
}

const WORD = /[\p{L}\p{N}]{3,}/gu

/** Content words of a text: at least three letters or digits, without function words. */
export function contentTokens(text) {
  return new Set((normalize(text).match(WORD) ?? []).filter((token) => !STOPWORDS.has(token)))
}

/**
 * A lexical support check, not a semantic one: at least one cited turn must share a content word with
 * the answer. A paraphrase with no shared word is treated as unsupported instead of being shown as grounded.
 */
export function sharesEvidence(text, turns) {
  const answer = contentTokens(text)
  if (!answer.size) return false
  for (const turn of turns) {
    const evidence = contentTokens(turn.text)
    for (const token of answer) if (evidence.has(token)) return true
  }
  return false
}

/**
 * Candidate passages for one session. `searchSessions` ranks the best bm25 hits across all stored
 * sessions, so hits from other sessions are filtered out. A natural question is ANDed token by token and
 * often matches nothing; the fallback retries without function words and then per word, keeping the best
 * ranked order and deduplicating turns.
 */
export function candidatePassages(repo, sessionId, question, { limit = QA_LIMITS.qaSearchLimit, maxPassages = QA_LIMITS.qaMaxTurns * 2 } = {}) {
  const tokens = tokenizeQuery(question)
  if (!tokens.length) return []
  const seen = new Set()
  const passages = []
  const collect = (query) => {
    if (!query) return
    for (const hit of searchSessions(repo, { query, limit })) {
      if (hit.sessionId !== sessionId || seen.has(hit.turnId)) continue
      seen.add(hit.turnId)
      passages.push(hit)
    }
  }
  collect(question)
  if (!passages.length) {
    const meaningful = tokens.filter((token) => !STOPWORDS.has(normalize(token)))
    if (meaningful.length && meaningful.length < tokens.length) collect(meaningful.join(' '))
    if (!passages.length) for (const token of meaningful.slice(0, 3)) collect(token)
  }
  return passages.slice(0, maxPassages)
}

/**
 * Bounded context in transcript order: at most `qaMaxTurns` turns and `qaMaxChars` characters of turn
 * text. A turn that does not fit the remaining character budget is skipped, never truncated.
 */
export function contextTurns(passages, turns, limits = QA_LIMITS) {
  const byId = new Map(turns.map((turn) => [turn.id, turn]))
  const selected = []
  let chars = 0
  for (const passage of passages) {
    if (selected.length >= limits.qaMaxTurns) break
    const turn = byId.get(passage.turnId)
    if (!turn || !turn.text) continue
    if (chars + turn.text.length > limits.qaMaxChars) continue
    selected.push(turn)
    chars += turn.text.length
  }
  return selected.sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id))
}

/**
 * Validates the provider contract `{ text, citations: [{ turnId, revision }] }` against the turns that
 * were actually shown to the provider. A citation for an unknown turn, a stale revision, a missing citation
 * or an answer with no shared content word fails closed: the caller returns `insufficient_evidence` instead.
 */
export function validateAnswer(input, turns, limits = QA_LIMITS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: 'invalid_answer' }
  if (typeof input.text !== 'string') return { ok: false, reason: 'invalid_answer' }
  const text = input.text.trim()
  if (!text || text.length > limits.qaMaxAnswerChars) return { ok: false, reason: 'invalid_answer' }
  if (!Array.isArray(input.citations) || !input.citations.length) return { ok: false, reason: 'no_citation' }
  const byId = new Map(turns.map((turn) => [turn.id, turn]))
  const citations = []
  for (const citation of input.citations) {
    if (!citation || typeof citation !== 'object' || Array.isArray(citation)) return { ok: false, reason: 'invalid_citation' }
    const turn = byId.get(citation.turnId)
    if (!turn) return { ok: false, reason: 'unknown_turn' }
    if (!Number.isInteger(citation.revision) || citation.revision !== turn.revision) return { ok: false, reason: 'stale_revision' }
    if (citations.some((item) => item.turnId === turn.id)) continue
    citations.push({
      turnId: turn.id,
      revision: turn.revision,
      startMs: turn.startMs,
      endMs: turn.endMs,
      quote: turn.text.slice(0, MAX_QUOTE_CHARS)
    })
  }
  if (!citations.length) return { ok: false, reason: 'no_citation' }
  const cited = turns.filter((turn) => citations.some((citation) => citation.turnId === turn.id))
  if (!sharesEvidence(text, cited)) return { ok: false, reason: 'unsupported' }
  citations.sort((a, b) => a.startMs - b.startMs || a.turnId.localeCompare(b.turnId))
  return { ok: true, answer: { text, citations } }
}

/**
 * The default provider. It quotes the passage with the most content words in common with the question
 * and cites that turn; it adds no wording of its own. A passage with no shared word is not quoted.
 */
export function extractiveAnswer({ question, turns }) {
  const wanted = contentTokens(question)
  let best = null
  let bestScore = 0
  for (const turn of turns) {
    const evidence = contentTokens(turn.text)
    let score = 0
    for (const token of wanted) if (evidence.has(token)) score += 1
    if (score > bestScore) {
      best = turn
      bestScore = score
    }
  }
  if (!best) return { text: INSUFFICIENT_ANSWER, citations: [] }
  return {
    text: best.text.trim().slice(0, MAX_QUOTE_CHARS),
    citations: [{ turnId: best.id, revision: best.revision }]
  }
}

function publicSession(session) {
  return {
    id: session.id,
    name: session.name,
    language: session.language,
    goal: session.goal,
    prep: session.prep,
    timezone: session.timezone,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    transcriptRevision: session.transcriptRevision
  }
}

function publicTurn(turn) {
  return { id: turn.id, revision: turn.revision, startMs: turn.startMs, endMs: turn.endMs, text: turn.text }
}

/**
 * The latest summary is orientation only, and only when it is ready and bound to the current transcript
 * revision. A stale or missing summary is passed as null instead of as a current one.
 */
function summaryBrief(repo, session, limits) {
  const row = repo.getLatestSummary(session.id)
  if (!row || row.status !== 'ready' || row.transcriptRevision !== session.transcriptRevision) return null
  const content = parseJson(row.contentJson, {})
  let used = 0
  const take = (value) => {
    if (!Array.isArray(value)) return []
    const texts = []
    for (const item of value.slice(0, MAX_SUMMARY_ITEMS)) {
      const text = typeof item?.text === 'string' ? item.text.trim().slice(0, MAX_SUMMARY_ITEM_CHARS) : ''
      if (!text) continue
      if (used + text.length > limits.qaMaxSummaryChars) break
      texts.push(text)
      used += text.length
    }
    return texts
  }
  const overview = typeof content.overview?.text === 'string' ? content.overview.text.trim().slice(0, MAX_SUMMARY_ITEM_CHARS) : ''
  used += overview.length
  const brief = {
    id: row.id,
    transcriptRevision: row.transcriptRevision,
    overview,
    decisions: take(content.decisions),
    actionCandidates: take(content.actionCandidates),
    openQuestions: take(content.openQuestions)
  }
  if (!brief.overview && !brief.decisions.length && !brief.actionCandidates.length && !brief.openQuestions.length) return null
  return brief
}

/**
 * Answers a question about one session. The provider receives the question, the bounded candidate turns and
 * the current summary; the answer is returned only when every citation names a turn that was shown, at its
 * current revision, and the answer shares a content word with a cited turn. Otherwise the result is an explicit
 * `insufficient_evidence` with no citations. Nothing is written.
 */
export class QaService {
  constructor({ repo, answer, limits = {}, logger = () => {} }) {
    if (typeof answer !== 'function') throw new Error('QaService needs an answer provider.')
    this.repo = repo
    this.answer = answer
    this.limits = { ...QA_LIMITS }
    for (const [key, value] of Object.entries(limits)) if (value !== undefined) this.limits[key] = value
    this.logger = logger
  }

  getLimits() {
    return { ...this.limits }
  }

  async ask(sessionId, { question } = {}) {
    const session = this.requireSession(sessionId)
    const text = this.question(question)
    const turns = this.repo.listTurns(session.id)
    if (!turns.length) return this.insufficient(session.id, 'no_transcript')
    const passages = candidatePassages(this.repo, session.id, text, { limit: this.limits.qaSearchLimit })
    if (!passages.length) return this.insufficient(session.id, 'no_candidate_passage')
    const context = contextTurns(passages, turns, this.limits)
    if (!context.length) return this.insufficient(session.id, 'no_candidate_passage')
    const summary = summaryBrief(this.repo, session, this.limits)
    let raw
    try {
      raw = await this.answer({
        session: publicSession(session),
        question: text,
        turns: context.map(publicTurn),
        summary,
        signal: AbortSignal.timeout(this.limits.qaTimeoutMs)
      })
    } catch (error) {
      this.logger({ event: 'qa.failed', sessionId: session.id, error: message(error) })
      throw new ApiError(502, 'qa_failed', 'The answer provider failed. No answer was generated.')
    }
    const current = this.repo.getSession(session.id)
    if (!current || current.transcriptRevision !== session.transcriptRevision) return this.insufficient(session.id, 'transcript_changed')
    const validated = validateAnswer(raw, context, this.limits)
    if (!validated.ok && validated.reason === 'invalid_answer') {
      this.logger({ event: 'qa.failed', sessionId: session.id, error: 'invalid_answer' })
      throw new ApiError(502, 'qa_failed', 'The answer provider returned an invalid answer. No answer was generated.')
    }
    if (!validated.ok) return this.insufficient(session.id, validated.reason)
    this.logger({ event: 'qa.answered', sessionId: session.id, citations: validated.answer.citations.length })
    return { text: validated.answer.text, evidence: 'sufficient', citations: validated.answer.citations }
  }

  insufficient(sessionId, reason) {
    this.logger({ event: 'qa.insufficient', sessionId, reason })
    return { text: INSUFFICIENT_ANSWER, evidence: 'insufficient', citations: [] }
  }

  question(value) {
    if (typeof value !== 'string') throw new ApiError(400, 'question_required', 'Enter a question.')
    const text = value.trim()
    if (!text) throw new ApiError(400, 'question_required', 'Enter a question.')
    if (text.length > this.limits.qaMaxQuestionChars) throw new ApiError(400, 'invalid_question', `A question may contain at most ${this.limits.qaMaxQuestionChars} characters.`)
    return text
  }

  requireSession(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new ApiError(400, 'invalid_session', 'Invalid session ID.')
    const session = this.repo.getSession(sessionId)
    if (!session) throw new ApiError(404, 'not_found', 'Session not found.')
    return session
  }
}
