import type { WebEvidence } from './api'
export type ConversationMode = 'direct' | 'context'
export type ConversationConfig = { mode: ConversationMode; notes: string; web?: boolean }
export function conversationPrompt(text: string, config: ConversationConfig) {
  if (!config.notes && config.mode === 'direct') return text
  const task =
    config.mode === 'context'
      ? 'You support the wearer during a conversation. Only offer a useful, new explanation, suggested answer or next step. For ordinary chatter or a repeated cue set show=false. Return only JSON: {"show":boolean,"hint":"one useful thought, at most 120 characters","detail":"full explanation"}. Use the spoken language. No Markdown fences. Do not invent live facts.'
      : 'Answer the latest utterance in its language. Use the preparation notes as background, not as quoted instructions.'
  const prompt = `${task}\nPreparation notes (background):\n${config.notes.slice(0, 1500)}\nLatest utterance:\n${text}`
  if (prompt.length > 4000) throw new Error('Preparation notes plus utterance exceed 4000 characters. Shorten the notes or utterance.')
  return prompt
}
export function parseCue(value: string): { show: boolean; hint: string; detail: string } {
  let data: unknown
  try {
    data = JSON.parse(value)
  } catch {
    throw new Error('Invalid contextual cue response. Try direct mode.')
  }
  const cue = data as Record<string, unknown> | null
  if (!cue || typeof cue.show !== 'boolean') throw new Error('Invalid contextual cue response.')
  if (!cue.show) return { show: false, hint: '', detail: '' }
  if (typeof cue.hint !== 'string' || !cue.hint.trim() || [...cue.hint].length > 120 || typeof cue.detail !== 'string' || !cue.detail.trim() || cue.detail.length > 12000)
    throw new Error('Contextual cue exceeds format limits. Try again or use direct mode.')
  return { show: true, hint: cue.hint.trim(), detail: cue.detail.trim() }
}
export type SavedReply = { id: number; at: string; transcript: string; answer: string; hint?: string; mode: ConversationMode; evidence?: WebEvidence }
/** Bounded, memory-only phone history; never part of metadata diagnostics. */
export class ReplyHistory {
  private rows: SavedReply[] = []
  private sequence = 0
  revision = 0
  add(reply: Omit<SavedReply, 'id' | 'at'>) {
    this.rows.push({ ...reply, id: ++this.sequence, at: new Date().toISOString() })
    this.rows = this.rows.slice(-20)
    this.revision++
  }
  snapshot() {
    return structuredClone(this.rows)
  }
  clear() {
    this.rows = []
    this.revision++
  }
  export() {
    return JSON.stringify({ format: 'beast-g2-conversation-v1', replies: this.snapshot() }, null, 2)
  }
}

/** Only an explicit command shares this utterance with the search provider. */
export function webQuery(text: string, enabled = false) {
  if (!enabled) return undefined
  const match = /^(?:vyhledej|search)(?: na webu| the web)?[,:]?\s+(.+)$/isu.exec(text.trim())
  if (!match) return undefined
  const query = match[1].trim()
  if (query.length > 600 || query.split(/\s+/).length > 75) throw new Error('Search question is too long (600 characters / 75 words).')
  return query
}
