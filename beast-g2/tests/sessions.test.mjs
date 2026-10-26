import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { openDatabase } from '../server/sessions/db.mjs'
import { Repository } from '../server/sessions/repository.mjs'
import { SessionService } from '../server/sessions/service.mjs'
import { TranscriptionWorker } from '../server/sessions/worker.mjs'
import { makeWav } from '../server/sessions/wav.mjs'

function setup(t, { transcribe, limits = {}, pollMs = 500 } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'beast-sessions-'))
  const db = openDatabase(path.join(dir, 'sessions.sqlite'))
  const repo = new Repository(db)
  const clock = { now: 1_700_000_000_000 }
  const service = new SessionService({ repo, dataDir: dir, limits, now: () => clock.now })
  const worker = new TranscriptionWorker({
    service,
    repo,
    transcribe: transcribe ?? (async ({ sequence }) => `Segment ${sequence}`),
    pollMs,
    backoffMs: 0,
    now: () => clock.now
  })
  t.after(async () => {
    await worker.stop()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, db, repo, service, worker, clock }
}

function started(service, overrides = {}) {
  const session = service.createSession({ name: 'Test session', language: 'cs', ...overrides })
  return service.startSession(session.id, { writerId: 'test' })
}

function segment(service, session, sequence, overrides = {}) {
  return service.acceptSegment(
    session.id,
    {
      id: `seg_${String(sequence).repeat(32).slice(0, 32)}`,
      sequence,
      startMs: sequence * 1000,
      endMs: sequence * 1000 + 1000,
      audio: makeWav(1000, sequence + 1),
      ...overrides
    },
    { writerId: 'test' }
  )
}

test('session lifecycle keeps server-confirmed state and never starts listening on reload', (t) => {
  const { service } = setup(t)
  const session = service.createSession({ name: 'Pohovor', language: 'cs', goal: 'Cíl' })
  assert.equal(session.status, 'draft')
  assert.equal(session.captureState, 'off')
  const active = service.startSession(session.id, { writerId: 'cli' })
  assert.equal(active.status, 'active')
  assert.equal(active.captureState, 'starting')
  const paused = service.pauseSession(session.id, { writerId: 'cli' })
  assert.equal(paused.status, 'paused')
  assert.equal(paused.captureState, 'off')
  const resumed = service.resumeSession(session.id, { writerId: 'cli' })
  assert.equal(resumed.status, 'active')
  const ended = service.endSession(session.id, { writerId: 'cli' })
  assert.equal(ended.status, 'ended')
  assert.equal(ended.captureState, 'off')
  const detail = service.getSessionDetail(session.id)
  assert.equal(detail.session.status, 'ended')
  assert.equal(detail.session.captureState, 'off')
})

test('writer lease rejects a second writer until it becomes stale', (t) => {
  const { service, clock } = setup(t)
  const session = started(service)
  assert.throws(() => service.startSession(session.id, { writerId: 'other' }), /Another writer/)
  clock.now += 60001
  const taken = service.startSession(session.id, { writerId: 'other' })
  assert.equal(taken.writerId, 'other')
  assert.throws(() => segment(service, session, 0), /Another writer/)
})

test('segment upload is idempotent and rejects the same ID with different content', (t) => {
  const { service } = setup(t)
  const session = started(service)
  const first = segment(service, session, 0)
  assert.equal(first.duplicate, false)
  const second = segment(service, session, 0)
  assert.equal(second.duplicate, true)
  assert.equal(second.segment.id, first.segment.id)
  assert.throws(() => segment(service, session, 0, { audio: makeWav(1000, 9) }), /different content/)
})

test('sequence numbers are unique even with a different segment ID', (t) => {
  const { service } = setup(t)
  const session = started(service)
  segment(service, session, 0)
  assert.throws(() => segment(service, session, 0, { id: `seg_${'f'.repeat(32)}` }), /Sequence number/)
})

test('out-of-order transcription is ordered by the source timeline', (t) => {
  const { service, repo, clock } = setup(t)
  const session = started(service)
  const accepted0 = segment(service, session, 0)
  const accepted1 = segment(service, session, 1)
  const detailSegments = [accepted0.segment, accepted1.segment]
  const jobs = [repo.claimNextJob(clock.now), repo.claimNextJob(clock.now)]
  const job0 = jobs.find((job) => job.segmentId === detailSegments[0].id)
  const job1 = jobs.find((job) => job.segmentId === detailSegments[1].id)
  service.recordTranscription({ job: job1, text: 'second', now: clock.now })
  service.recordTranscription({ job: job0, text: 'first', now: clock.now })
  const detail = service.getSessionDetail(session.id)
  assert.deepEqual(
    detail.turns.map((turn) => turn.text),
    ['first', 'second']
  )
  assert.deepEqual(
    detail.turns.map((turn) => turn.startMs),
    [0, 1000]
  )
})

test('restart recovers a running job and stores the transcript exactly once', async (t) => {
  const { dir, repo, service, clock } = setup(t)
  const session = started(service)
  segment(service, session, 0)
  const claimed = repo.claimNextJob(clock.now)
  assert.equal(claimed.state, 'running')
  const db = openDatabase(path.join(dir, 'sessions.sqlite'))
  t.after(() => db.close())
  const reopened = new Repository(db)
  const recoveredService = new SessionService({ repo: reopened, dataDir: dir, now: () => clock.now })
  const worker = new TranscriptionWorker({
    service: recoveredService,
    repo: reopened,
    transcribe: async ({ sequence }) => `Recovered ${sequence}`,
    backoffMs: 0,
    now: () => clock.now
  })
  assert.equal(reopened.recoverRunningJobs(clock.now), 1)
  await worker.tick()
  const detail = recoveredService.getSessionDetail(session.id)
  assert.equal(detail.turns.length, 1)
  assert.equal(detail.turns[0].text, 'Recovered 0')
  assert.equal(detail.jobs[0].state, 'done')
})

test('STT failures retry with backoff and end as a visible coverage gap', async (t) => {
  let attempts = 0
  const { service, worker } = setup(t, {
    transcribe: async () => {
      attempts++
      if (attempts < 3) throw new Error('temporary timeout')
      return 'Recovered on retry'
    }
  })
  const session = started(service)
  segment(service, session, 0)
  await worker.tick()
  const detail = service.getSessionDetail(session.id)
  assert.equal(attempts, 3)
  assert.equal(detail.turns[0].text, 'Recovered on retry')
  assert.equal(detail.gaps.length, 0)
  assert.equal(detail.jobs[0].state, 'done')
})

test('a permanently failed segment becomes a visible gap and is not silently dropped', async (t) => {
  const { service, worker, repo } = setup(t, {
    transcribe: async () => {
      throw new Error('provider unavailable')
    }
  })
  const session = started(service)
  const accepted = segment(service, session, 0)
  const audioPath = service.audioPath(repo.getSegment(accepted.segment.id).audioPath)
  await worker.tick()
  const detail = service.getSessionDetail(session.id)
  assert.equal(detail.turns.length, 0)
  assert.equal(detail.segments[0].state, 'failed')
  assert.equal(detail.jobs[0].state, 'failed')
  assert.equal(detail.gaps.length, 1)
  assert.equal(detail.gaps[0].reason, 'transcription_failed')
  assert.equal(detail.gaps[0].startMs, 0)
  assert.equal(detail.gaps[0].endMs, 1000)
  assert.equal(detail.session.coverageDeclared, 'partial')
  assert.equal(existsSync(audioPath), false)
  assert.equal(repo.sumRetainedAudioBytes(), 0)
})

test('pause preserves an accepted segment while the worker finishes it', async (t) => {
  const { service, worker } = setup(t)
  const session = started(service)
  segment(service, session, 0)
  service.pauseSession(session.id, { writerId: 'test' })
  assert.throws(() => segment(service, session, 1), /paused/)
  await worker.tick()
  const detail = service.getSessionDetail(session.id)
  assert.equal(detail.turns.length, 1)
  assert.equal(detail.turns[0].text, 'Segment 0')
  const ended = service.endSession(session.id, { writerId: 'test' })
  assert.equal(ended.status, 'ended')
  assert.equal(service.getSessionDetail(session.id).turns.length, 1)
})

test('delete during inference discards the late result and removes all rows', async (t) => {
  let release
  let markStarted
  const gate = new Promise((resolve) => (release = resolve))
  const startedTranscription = new Promise((resolve) => (markStarted = resolve))
  const { service, worker, repo } = setup(t, {
    transcribe: async () => {
      markStarted()
      await gate
      return 'Late answer'
    }
  })
  const session = started(service)
  segment(service, session, 0)
  const running = worker.tick()
  await startedTranscription
  service.deleteSession(session.id)
  release()
  await running
  assert.equal(repo.getSession(session.id), null)
  assert.equal(repo.listTurns(session.id).length, 0)
})

test('90 second import is segmented, transcribed and exported with sources and revisions', async (t) => {
  const { service, worker, repo } = setup(t)
  const session = started(service)
  const result = await service.importWav(session.id, Readable.from([makeWav(90_000)]), { writerId: 'test' })
  assert.equal(result.segmentsAccepted, 3)
  assert.equal(result.segmentsDuplicate, 0)
  assert.equal(result.truncated, false)
  const audioPath = service.audioPath(repo.listSegments(session.id)[0].audioPath)
  await worker.tick()
  const detail = service.getSessionDetail(session.id)
  assert.equal(detail.turns.length, 3)
  assert.equal(existsSync(audioPath), false)
  assert.equal(repo.sumRetainedAudioBytes(), 0)
  assert.deepEqual(
    detail.turns.map((turn) => turn.startMs),
    [0, 30000, 60000]
  )
  assert.equal(detail.session.coverageDeclared, 'complete')
  const corrected = service.correctTurn(session.id, detail.turns[1].id, { text: 'Opravený text' })
  assert.equal(corrected.revision, 2)
  const other = started(service)
  assert.throws(() => service.correctTurn(other.id, detail.turns[0].id, { text: 'Cizí' }), /not found/)
  const exported = service.exportSession(session.id, 'json')
  assert.equal(exported.formatVersion, 1)
  assert.equal(exported.completeness.declared, 'complete')
  assert.equal(exported.completeness.transcribedSegments, 3)
  assert.equal(exported.turns[1].text, 'Opravený text')
  assert.equal(exported.revisions.length, 4)
  const markdown = service.exportSession(session.id, 'markdown')
  assert.match(markdown, /Opravený text/)
  assert.match(markdown, /Coverage gaps/)
  assert.match(markdown, /seg_/)
})

test('re-importing the same WAV is idempotent and a changed file conflicts', async (t) => {
  const { service, repo } = setup(t)
  const session = started(service)
  const wav = makeWav(60_000)
  const first = await service.importWav(session.id, Readable.from([wav]), { writerId: 'test' })
  const second = await service.importWav(session.id, Readable.from([wav]), { writerId: 'test' })
  assert.equal(first.segmentsAccepted, 2)
  assert.equal(second.segmentsAccepted, 0)
  assert.equal(second.segmentsDuplicate, 2)
  assert.equal(repo.countSegments(session.id), 2)
  const changed = makeWav(60_000, 7)
  await assert.rejects(() => service.importWav(session.id, Readable.from([changed]), { writerId: 'test' }), /Sequence number/)
})

test('a truncated import keeps received segments and records the unknown interval', async (t) => {
  const { service } = setup(t)
  const session = started(service)
  const full = makeWav(90_000)
  const truncated = full.subarray(0, 44 + 45_000 * 32)
  const result = await service.importWav(session.id, Readable.from([truncated]), { writerId: 'test' })
  assert.equal(result.truncated, true)
  assert.equal(result.receivedDurationMs, 45_000)
  assert.equal(result.segmentsAccepted, 2)
  const detail = service.getSessionDetail(session.id)
  assert.equal(detail.gaps.length, 1)
  assert.equal(detail.gaps[0].startMs, 45_000)
  assert.equal(detail.gaps[0].endMs, 90_000)
  assert.equal(detail.gaps[0].reason, 'import_truncated')
  assert.equal(detail.session.coverageDeclared, 'partial')
})

test('session duration and transcript limits stop receiving without truncating accepted work', async (t) => {
  const { service, clock } = setup(t, { limits: { maxTranscriptChars: 10 } })
  const session = started(service)
  assert.throws(() => segment(service, session, 0, { startMs: 0, endMs: 3_600_001, audio: makeWav(1000) }), /endMs/)
  segment(service, session, 0, { startMs: 0, endMs: 1000, audio: makeWav(1000) })
  const job = service.repo.claimNextJob(clock.now)
  service.recordTranscription({ job, text: 'Toto je příliš dlouhý přepis.', now: clock.now })
  const detail = service.getSessionDetail(session.id)
  assert.equal(detail.session.status, 'ended')
  assert.equal(detail.session.endReason, 'character_limit')
  assert.equal(detail.turns.length, 1)
})

test('retention removes ended sessions and expired audio with explicit gaps', async (t) => {
  const { service, repo, clock } = setup(t)
  const session = started(service)
  const accepted = segment(service, session, 0)
  const audioPath = service.audioPath(repo.getSegment(accepted.segment.id).audioPath)
  assert.equal(existsSync(audioPath), true)
  clock.now = accepted.segment.audioExpiresAt + 1
  const pruned = service.prune()
  assert.equal(pruned.audio, 1)
  const detail = service.getSessionDetail(session.id)
  assert.equal(detail.segments[0].state, 'expired')
  assert.equal(detail.gaps[0].reason, 'audio_expired')
  assert.equal(existsSync(audioPath), false)
  service.endSession(session.id, { writerId: 'test' })
  clock.now = service.getSessionDetail(session.id).session.expiresAt + 1
  const sessions = service.prune()
  assert.equal(sessions.sessions, 1)
  assert.equal(repo.getSession(session.id), null)
})

test('delete removes the session, its indexes and its audio files', async (t) => {
  const { service, repo } = setup(t)
  const session = started(service)
  const accepted = segment(service, session, 0)
  const audioPath = service.audioPath(repo.getSegment(accepted.segment.id).audioPath)
  assert.equal(existsSync(audioPath), true)
  assert.equal(service.deleteSession(session.id), true)
  assert.equal(existsSync(audioPath), false)
  assert.equal(repo.getSession(session.id), null)
  assert.throws(() => service.getSessionDetail(session.id), /not found/)
})

test('end reports missing sequence numbers as explicit gaps', (t) => {
  const { service } = setup(t)
  const session = started(service)
  segment(service, session, 0)
  segment(service, session, 2)
  const ended = service.endSession(session.id, { writerId: 'test', lastSequence: 3 })
  assert.equal(ended.status, 'ended')
  const detail = service.getSessionDetail(session.id)
  assert.deepEqual(
    detail.gaps.map((gap) => gap.startMs),
    [30000, 90000]
  )
  assert.equal(
    detail.gaps.every((gap) => gap.reason === 'missing_segment'),
    true
  )
  assert.equal(detail.session.coverageDeclared, 'partial')
})

test('started worker processes queued jobs without a manual tick', async (t) => {
  const { service, worker } = setup(t, { pollMs: 20 })
  const session = started(service)
  await service.importWav(session.id, Readable.from([makeWav(1000)]), { writerId: 'test' })
  worker.start()
  const deadline = Date.now() + 1000
  let detail
  do {
    await new Promise((resolve) => setTimeout(resolve, 20))
    detail = service.getSessionDetail(session.id)
  } while (detail.jobs[0].state !== 'done' && Date.now() < deadline)
  await worker.stop()
  assert.equal(detail.jobs[0].state, 'done')
  assert.equal(detail.turns[0].text, 'Segment 0')
})
