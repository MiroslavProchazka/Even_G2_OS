import { diagnostics } from './diagnostics'

/** The hard floor for automatic hints. The panel may raise the spacing, never lower it. */
export const HINT_MIN_SPACING_MS = 30_000

export type HintKind = 'unsolicited' | 'ask'
export type HintDecision = 'show-unsolicited' | 'show-ask' | 'suppress'
export type HintRating = 'useful' | 'distracting'
export type HintBlock = 'disabled' | 'paused' | 'visible' | 'spacing'
export type HintContext = { visible?: boolean }

export type HintPolicyOptions = {
  enabled?: boolean
  minSpacingMs?: number
  now?: () => number
}

/**
 * The opt-in policy for contextual hints. It owns no timer, microphone or model call: callers ask it for a decision and
 * report the hints they actually showed. The clock is injected so tests can advance time without waiting.
 */
export class HintPolicy {
  /** Automatic hints are off until the wearer turns them on. */
  enabled: boolean
  minSpacingMs: number
  /** When the last automatic hint became visible. An explicit Ask never changes it. */
  lastShownAt: number | undefined
  /** Pausing hints leaves transcription and the live transcript untouched. */
  paused = false
  private clock: () => number

  constructor(options: HintPolicyOptions = {}) {
    this.enabled = options.enabled ?? false
    this.minSpacingMs = spacing(options.minSpacingMs)
    this.clock = options.now ?? Date.now
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled
  }

  /** Raises or lowers the spacing within the allowed range. Below the hard minimum is refused. */
  setSpacing(ms: number) {
    if (!Number.isFinite(ms) || ms < HINT_MIN_SPACING_MS) return false
    this.minSpacingMs = Math.round(ms)
    return true
  }

  pause() {
    this.paused = true
  }

  resume() {
    this.paused = false
  }

  /** Milliseconds until another automatic hint is allowed; zero means it may be shown now. */
  remainingMs() {
    if (this.lastShownAt === undefined) return 0
    const elapsed = Math.max(0, this.clock() - this.lastShownAt)
    return Math.max(0, Math.max(HINT_MIN_SPACING_MS, this.minSpacingMs) - elapsed)
  }

  /** Why an automatic hint would be refused right now, or undefined when it may be shown. */
  blockedBy(context: HintContext = {}): HintBlock | undefined {
    if (!this.enabled) return 'disabled'
    if (this.paused) return 'paused'
    if (context.visible) return 'visible'
    if (this.remainingMs() > 0) return 'spacing'
    return undefined
  }

  /**
   * A pure decision. An explicit Ask always wins and ignores the toggle, the pause, a visible hint and the spacing clock.
   * An automatic hint needs the toggle on, the pause off, no visible hint and at least minSpacingMs since the last one.
   */
  decide(kind: HintKind, context: HintContext = {}): HintDecision {
    if (kind === 'ask') return 'show-ask'
    return this.blockedBy(context) ? 'suppress' : 'show-unsolicited'
  }

  /** Records an automatic hint that actually became visible. An explicit Ask does not consume the spacing. */
  noteShown(decision: HintDecision) {
    if (decision === 'show-unsolicited') this.lastShownAt = this.clock()
  }
}

function spacing(value: number | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(HINT_MIN_SPACING_MS, Math.round(value)) : HINT_MIN_SPACING_MS
}

export type HintFeedbackCounts = { useful: number; distracting: number }

/**
 * Local feedback counters. A rating is one of two words and nothing else: no hint text, transcript or prompt is stored
 * or sent. The diagnostic event carries the rating code and the two counts only.
 */
export class HintFeedback {
  private counts: HintFeedbackCounts = { useful: 0, distracting: 0 }

  rate(rating: HintRating): HintFeedbackCounts {
    this.counts[rating]++
    diagnostics.record('continuous', 'hint.feedback', { code: rating, useful: this.counts.useful, distracting: this.counts.distracting })
    return this.snapshot()
  }

  snapshot(): HintFeedbackCounts {
    return { ...this.counts }
  }

  reset() {
    this.counts = { useful: 0, distracting: 0 }
  }
}

export type HintsState = {
  enabled: boolean
  paused: boolean
  minSpacingMs: number
  lastShownAt: number | undefined
  useful: number
  distracting: number
}

/** The surface the phone panel needs; a fake implements it in tests. */
export type HintsControl = {
  state: HintsState
  setEnabled(enabled: boolean): void
  setSpacing(ms: number): boolean
  pause(): void
  resume(): void
  rate(rating: HintRating): void
  statusLine(): string
  subscribe(listener: (state: HintsState) => void): () => void
}

/** Wraps the pure policy and the local feedback counters for the phone panel. */
export class HintsController implements HintsControl {
  readonly policy: HintPolicy
  private readonly feedback: HintFeedback
  private readonly listeners = new Set<(state: HintsState) => void>()

  constructor(policy = new HintPolicy(), feedback = new HintFeedback()) {
    this.policy = policy
    this.feedback = feedback
  }

  get state(): HintsState {
    const counts = this.feedback.snapshot()
    return { enabled: this.policy.enabled, paused: this.policy.paused, minSpacingMs: this.policy.minSpacingMs, lastShownAt: this.policy.lastShownAt, ...counts }
  }

  setEnabled(enabled: boolean) {
    this.policy.setEnabled(enabled)
    this.emit()
  }

  setSpacing(ms: number) {
    const accepted = this.policy.setSpacing(ms)
    this.emit()
    return accepted
  }

  pause() {
    this.policy.pause()
    this.emit()
  }

  resume() {
    this.policy.resume()
    this.emit()
  }

  rate(rating: HintRating) {
    this.feedback.rate(rating)
    this.emit()
  }

  statusLine() {
    const seconds = Math.round(this.policy.minSpacingMs / 1000)
    if (!this.policy.enabled) return 'Hints off · automatic hints are opt-in'
    if (this.policy.paused) return 'Hints on · automatic hints paused'
    return `Hints on · automatic hints at least ${seconds} s apart`
  }

  subscribe(listener: (state: HintsState) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit() {
    const state = this.state
    for (const listener of this.listeners) listener(state)
  }
}
