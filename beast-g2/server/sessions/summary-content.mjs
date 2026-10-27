import { ApiError } from '../errors.mjs'

export const SUMMARY_SCHEMA_VERSION = 1
export const SUMMARY_PROMPT_VERSION = 'summary-v1'
const MAX_CITATIONS = 8
const MAX_ITEM_TEXT = 1000
const MAX_OVERVIEW_TEXT = 4000

function invalid(message, status = 502) {
  return new ApiError(status, 'invalid_summary', message)
}

function cleanText(value, label, max, status) {
  if (typeof value !== 'string') throw invalid(`${label} must be a string.`, status)
  const text = value.trim()
  if (!text || text.length > max) throw invalid(`${label} must contain 1-${max} characters.`, status)
  return text
}

function citations(value, allowed, label, status) {
  if (!Array.isArray(value) || value.length === 0) throw invalid(`${label} needs at least one citation.`, status)
  if (value.length > MAX_CITATIONS) throw invalid(`${label} has too many citations.`, status)
  const unique = []
  for (const id of value) {
    if (typeof id !== 'string' || !allowed.has(id)) throw invalid(`${label} has an invalid citation: unknown transcript turn.`, status)
    if (!unique.includes(id)) unique.push(id)
  }
  return unique
}

function list(value, label, status) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw invalid(`${label} must be an array.`, status)
  return value
}

function optionalText(value, label, max, status) {
  if (value === undefined || value === null || value === '') return null
  return cleanText(value, label, max, status)
}

function mergeItems(items, keyOf) {
  const merged = new Map()
  for (const item of items) {
    const key = keyOf(item)
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, { ...item, citations: [...item.citations] })
      continue
    }
    for (const citation of item.citations) if (!existing.citations.includes(citation)) existing.citations.push(citation)
  }
  return [...merged.values()]
}

export function validateSummaryContent(input, turns, { status = 502, maxItems = 100 } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Summary must be a JSON object.', status)
  const allowed = new Set(turns.map((turn) => turn.id))
  const overviewInput = input.overview
  if (!overviewInput || typeof overviewInput !== 'object' || Array.isArray(overviewInput)) throw invalid('Summary overview is required.', status)
  const overview = {
    text: cleanText(overviewInput.text, 'overview.text', MAX_OVERVIEW_TEXT, status),
    citations: citations(overviewInput.citations, allowed, 'overview', status)
  }
  const decisions = list(input.decisions, 'decisions', status).map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid(`decisions[${index}] must be an object.`, status)
    return {
      text: cleanText(item.text, `decisions[${index}].text`, MAX_ITEM_TEXT, status),
      citations: citations(item.citations, allowed, `decisions[${index}]`, status)
    }
  })
  const actionCandidates = list(input.actionCandidates, 'actionCandidates', status).map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid(`actionCandidates[${index}] must be an object.`, status)
    const conditional = item.conditional ?? false
    if (typeof conditional !== 'boolean') throw invalid(`actionCandidates[${index}].conditional must be a boolean.`, status)
    return {
      text: cleanText(item.text, `actionCandidates[${index}].text`, MAX_ITEM_TEXT, status),
      owner: optionalText(item.owner, `actionCandidates[${index}].owner`, 100, status),
      due: optionalText(item.due, `actionCandidates[${index}].due`, 40, status),
      dueText: optionalText(item.dueText, `actionCandidates[${index}].dueText`, 200, status),
      conditional,
      citations: citations(item.citations, allowed, `actionCandidates[${index}]`, status)
    }
  })
  const openQuestions = list(input.openQuestions, 'openQuestions', status).map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid(`openQuestions[${index}] must be an object.`, status)
    return {
      text: cleanText(item.text, `openQuestions[${index}].text`, MAX_ITEM_TEXT, status),
      citations: citations(item.citations, allowed, `openQuestions[${index}]`, status)
    }
  })
  for (const [name, items] of [
    ['decisions', decisions],
    ['actionCandidates', actionCandidates],
    ['openQuestions', openQuestions]
  ]) {
    if (items.length > 50) throw invalid(`${name} exceeds the per-summary limit.`, status)
  }
  if (decisions.length + actionCandidates.length + openQuestions.length > maxItems) throw invalid('Summary has too many extracted items.', status)
  return { schemaVersion: SUMMARY_SCHEMA_VERSION, overview, decisions, actionCandidates, openQuestions }
}

export function mergeSummaryParts(parts, { maxItems = 100 } = {}) {
  const overview = {
    text: parts.map((part) => part.overview.text).join(' '),
    citations: [...new Set(parts.flatMap((part) => part.overview.citations))]
  }
  if (overview.text.length > MAX_OVERVIEW_TEXT) throw new ApiError(413, 'summary_too_large', 'Combined summary overview exceeds the size limit.')
  const decisions = mergeItems(
    parts.flatMap((part) => part.decisions),
    (item) => item.text.toLowerCase()
  )
  const actionCandidates = mergeItems(
    parts.flatMap((part) => part.actionCandidates),
    (item) => `${item.text.toLowerCase()}\u0000${item.owner ?? ''}\u0000${item.due ?? ''}\u0000${item.dueText ?? ''}\u0000${item.conditional}`
  )
  const openQuestions = mergeItems(
    parts.flatMap((part) => part.openQuestions),
    (item) => item.text.toLowerCase()
  )
  if (decisions.length + actionCandidates.length + openQuestions.length > maxItems) throw new ApiError(413, 'summary_too_large', 'Combined summary has too many extracted items.')
  return { schemaVersion: SUMMARY_SCHEMA_VERSION, overview, decisions, actionCandidates, openQuestions }
}

export function collectCitations(content, turns) {
  const byId = new Map(turns.map((turn) => [turn.id, turn]))
  const citations = new Map()
  for (const item of [content.overview, ...content.decisions, ...content.actionCandidates, ...content.openQuestions]) {
    for (const id of item.citations) {
      const turn = byId.get(id)
      if (!turn) throw new ApiError(502, 'invalid_summary', 'Summary cites an unknown transcript turn.')
      citations.set(`${turn.id}:${turn.revision}`, {
        turnId: turn.id,
        turnRevision: turn.revision,
        startMs: turn.startMs,
        endMs: turn.endMs,
        quote: turn.text
      })
    }
  }
  return [...citations.values()].sort((a, b) => a.startMs - b.startMs || a.turnId.localeCompare(b.turnId))
}
