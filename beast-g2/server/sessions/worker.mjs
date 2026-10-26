import { readFileSync } from 'node:fs'

function message(error) {
  return error instanceof Error && error.message ? error.message.slice(0, 500) : 'Transcription failed.'
}

export class TranscriptionWorker {
  constructor({ service, repo, transcribe, pollMs = 500, backoffMs = 1000, timeoutMs = 90000, now = Date.now, logger = () => {} }) {
    this.service = service
    this.repo = repo
    this.transcribe = transcribe
    this.pollMs = pollMs
    this.backoffMs = backoffMs
    this.timeoutMs = timeoutMs
    this.now = now
    this.logger = logger
    this.timer = null
    this.current = null
    this.running = false
  }

  tick() {
    if (this.running) return this.current
    this.running = true
    this.current = (async () => {
      try {
        while (true) {
          const job = this.repo.claimNextJob(this.now())
          if (!job) break
          await this.run(job)
        }
      } finally {
        this.running = false
      }
    })()
    return this.current
  }

  async run(job) {
    const segment = this.repo.getSegment(job.segmentId)
    const session = this.repo.getSession(job.sessionId)
    if (!session || !segment || segment.state !== 'accepted') {
      this.repo.finishJob(job.id, 'cancelled', 'Segment is no longer accepted.', this.now())
      return
    }
    let audio
    try {
      audio = readFileSync(this.service.audioPath(segment.audioPath))
    } catch {
      this.service.recordTranscriptionFailure({
        job,
        error: 'Audio file is missing.',
        retry: false,
        now: this.now()
      })
      return
    }
    try {
      const text = await this.transcribe({
        audio,
        language: session.language,
        sessionId: session.id,
        segmentId: segment.id,
        sequence: segment.sequence,
        signal: AbortSignal.timeout(this.timeoutMs)
      })
      this.service.recordTranscription({ job, text, now: this.now() })
    } catch (error) {
      const retry = job.attempts < job.maxAttempts
      const retryAt = this.now() + this.backoffMs * 2 ** Math.max(0, job.attempts - 1)
      this.service.recordTranscriptionFailure({
        job,
        error: message(error),
        retry,
        retryAt,
        now: this.now()
      })
    }
  }

  start() {
    if (this.timer) return
    const recovered = this.repo.recoverRunningJobs(this.now())
    if (recovered) this.logger({ event: 'worker.recovered', jobs: recovered })
    this.timer = setInterval(() => {
      this.tick().catch((error) => this.logger({ event: 'worker.tick_failed', error: message(error) }))
    }, this.pollMs)
    this.timer.unref?.()
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.running) await this.current
  }
}
