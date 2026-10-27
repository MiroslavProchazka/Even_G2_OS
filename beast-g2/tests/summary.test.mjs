import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDatabase } from '../server/sessions/db.mjs'
import { Repository } from '../server/sessions/repository.mjs'
import { SessionService } from '../server/sessions/service.mjs'
import { SummaryService } from '../server/sessions/summary.mjs'
import { TranscriptionWorker } from '../server/sessions/worker.mjs'
import { makeWav } from '../server/sessions/wav.mjs'

function setup(t, { generate, limits = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'beast-summary-'))
  const db = openDatabase(path.join(dir, 'sessions.sqlite'))
  const repo = new Repository(db)
  const clock = { now: 1_700_000_000_000 }
  const service = new SessionService({ repo, dataDir: dir, limits, now: () => clock.now })
  const worker = new TranscriptionWorker({
    service,
    repo,
    transcribe: async ({ sequence }) => `Přepis ${sequence}`,
    backoffMs: 0,
    now: () => clock.now
  })
  const summary = new SummaryService({
    repo,
    generate:
      generate ??
      (async ({ turns }) => ({
        overview: { text: 'Stručné shrnutí.', citations: [turns[0].id] },
        decisions: [{ text: 'Bylo rozhodnuto.', citations: [turns[0].id] }],
        actionCandidates: [],
        openQuestions: []
      })),
    limits,
    now: () => clock.now
  })
  service.attachSummaryService(summary)
  t.after(async () => {
    await worker.stop()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, db, repo, service, worker, summary, clock }
}

function started(service) {
  const session = service.createSession({ name: 'Summary test', language: 'cs' })
  return service.startSession(session.id, { writerId: 'test' })
}

function segment(service, session, sequence) {
  return service.acceptSegment(
    session.id,
    {
      id: `seg_${String(sequence).repeat(32).slice(0, 32)}`,
      sequence,
      startMs: sequence * 1000,
      endMs: sequence * 1000 + 1000,
      audio: makeWav(1000, sequence + 1)
    },
    { writerId: 'test' }
  )
}

async function transcribed(service, worker, count = 3) {
  const session = started(service)
  for (let sequence = 0; sequence < count; sequence++) segment(service, session, sequence)
  await worker.tick()
  return { session, detail: service.getSessionDetail(session.id) }
}

test('summary is generated from a concrete transcript revision with valid citations', async (t) => {
  const { service, worker, summary } = setup(t)
  const { session, detail } = await transcribed(service, worker)
  const ended = service.endSession(session.id, { writerId: 'test' })
  const requested = summary.requestSummary(session.id)
  assert.equal(requested.summary.status, 'pending')
  assert.equal(requested.summary.transcriptRevision, ended.transcriptRevision)
  const ready = await summary.run(requested.summary.id)
  assert.equal(ready.status, 'ready')
  assert.equal(ready.reviewStatus, 'unreviewed')
  assert.equal(ready.content.overview.text, 'Stručné shrnutí.')
  assert.deepEqual(ready.content.decisions[0].citations, [detail.turns[0].id])
  assert.equal(ready.content.actionCandidates.length, 0)
  assert.equal(ready.content.coverage.declared, 'complete')
  assert.equal(ready.content.coverage.turns, 3)
  assert.equal(ready.citations.length, 1)
  assert.equal(ready.citations[0].turnId, detail.turns[0].id)
  assert.equal(summary.listSummaries(session.id).length, 1)
})

test('summary requires an ended transcript unless the caller explicitly accepts partial coverage', async (t) => {
  const { service, worker, summary } = setup(t)
  const { session } = await transcribed(service, worker, 1)
  assert.throws(() => summary.requestSummary(session.id), /ended/i)
  const partial = summary.requestSummary(session.id, { allowPartial: true })
  const ready = await summary.run(partial.summary.id)
  assert.equal(ready.status, 'ready')
  assert.equal(ready.content.coverage.declared, 'partial')
})

test('summary rejects citations that do not belong to the session', async (t) => {
  const { service, worker, summary } = setup(t, {
    generate: async ({ turns }) => ({
      overview: { text: 'Shrnutí.', citations: [`turn_${'f'.repeat(32)}`] },
      decisions: [{ text: 'Rozhodnutí.', citations: [turns[0].id] }],
      actionCandidates: [],
      openQuestions: []
    })
  })
  const { session } = await transcribed(service, worker, 1)
  service.endSession(session.id, { writerId: 'test' })
  const requested = summary.requestSummary(session.id)
  await assert.rejects(() => summary.run(requested.summary.id), /citation/i)
  const failed = summary.getSummary(session.id, requested.summary.id)
  assert.equal(failed.status, 'failed')
  assert.match(failed.lastError, /citation/i)
})

test('a failed summary can be requested again without force', async (t) => {
  let calls = 0
  const { service, worker, summary } = setup(t, {
    generate: async ({ turns }) => {
      calls++
      if (calls === 1) throw new Error('provider down')
      return {
        overview: { text: 'Obnovené shrnutí.', citations: [turns[0].id] },
        decisions: [],
        actionCandidates: [],
        openQuestions: []
      }
    }
  })
  const { session } = await transcribed(service, worker, 1)
  service.endSession(session.id, { writerId: 'test' })
  const requested = summary.requestSummary(session.id)
  await assert.rejects(() => summary.run(requested.summary.id), /provider down/)
  const failed = summary.getSummary(session.id, requested.summary.id)
  assert.equal(failed.status, 'failed')
  const retried = summary.requestSummary(session.id)
  assert.equal(retried.created, false)
  assert.equal(retried.summary.id, failed.id)
  const ready = await summary.run(retried.summary.id)
  assert.equal(ready.status, 'ready')
  assert.equal(ready.content.overview.text, 'Obnovené shrnutí.')
})

test('a transcript correction marks the summary and its preparation stale', async (t) => {
  const { service, worker, summary } = setup(t)
  const { session, detail } = await transcribed(service, worker, 2)
  service.endSession(session.id, { writerId: 'test' })
  const requested = summary.requestSummary(session.id)
  const ready = await summary.run(requested.summary.id)
  const preparation = summary.createPreparation(session.id, {
    sourceSummaryId: ready.id,
    focus: 'Navázat na rozhodnutí'
  })
  assert.equal(preparation.status, 'ready')
  service.correctTurn(session.id, detail.turns[0].id, { text: 'Opravený přepis' })
  assert.equal(summary.getSummary(session.id, ready.id).status, 'stale')
  assert.equal(summary.getLatestPreparation(session.id).status, 'stale')
})

test('regeneration does not overwrite a manual summary edit without an explicit force', async (t) => {
  const { service, worker, summary } = setup(t)
  const { session } = await transcribed(service, worker, 2)
  service.endSession(session.id, { writerId: 'test' })
  const requested = summary.requestSummary(session.id)
  const ready = await summary.run(requested.summary.id)
  const edited = summary.updateSummary(session.id, ready.id, {
    content: {
      ...ready.content,
      overview: { text: 'Ručně upravené shrnutí.', citations: [ready.content.overview.citations[0]] }
    }
  })
  assert.equal(edited.reviewStatus, 'edited')
  assert.equal(edited.content.coverage.declared, 'complete')
  assert.throws(() => summary.requestSummary(session.id), /manual edit/i)
  const forced = summary.requestSummary(session.id, { force: true })
  assert.notEqual(forced.summary.id, ready.id)
  assert.equal(summary.getSummary(session.id, ready.id).status, 'stale')
  const regenerated = await summary.run(forced.summary.id)
  assert.equal(regenerated.status, 'ready')
  assert.equal(regenerated.content.overview.text, 'Stručné shrnutí.')
  const reused = summary.requestSummary(session.id)
  assert.equal(reused.created, false)
  assert.equal(reused.summary.id, regenerated.id)
})

test('long transcripts are summarized in chunks without dropping turns', async (t) => {
  const chunks = []
  const { service, worker, summary } = setup(t, {
    limits: { summaryChunkChars: 40, summaryMaxChars: 1000 },
    generate: async ({ turns }) => {
      chunks.push(turns.map((turn) => turn.id))
      return {
        overview: { text: `Část ${chunks.length}.`, citations: [turns[0].id] },
        decisions: [],
        actionCandidates: [],
        openQuestions: []
      }
    }
  })
  const { session } = await transcribed(service, worker, 3)
  service.endSession(session.id, { writerId: 'test' })
  const requested = summary.requestSummary(session.id)
  const ready = await summary.run(requested.summary.id)
  assert.equal(chunks.length, 3)
  assert.equal(ready.content.overview.citations.length, 3)
  assert.match(ready.content.overview.text, /Část 1/)
  assert.match(ready.content.overview.text, /Část 3/)
})

test('a stale summary cannot be used as preparation', async (t) => {
  const { service, worker, summary } = setup(t)
  const { session, detail } = await transcribed(service, worker, 2)
  service.endSession(session.id, { writerId: 'test' })
  const requested = summary.requestSummary(session.id)
  const ready = await summary.run(requested.summary.id)
  service.correctTurn(session.id, detail.turns[0].id, { text: 'Opravený přepis' })
  assert.throws(() => summary.createPreparation(session.id, { sourceSummaryId: ready.id }), /ready summary/i)
  assert.throws(() => summary.requestSummary(session.id, { allowPartial: 'yes' }), /booleans/i)
})

test('a new coverage does not bypass a manual summary edit without force', async (t) => {
  const { service, worker, summary } = setup(t)
  const { session } = await transcribed(service, worker, 2)
  service.endSession(session.id, { writerId: 'test' })
  const requested = summary.requestSummary(session.id)
  const ready = await summary.run(requested.summary.id)
  summary.updateSummary(session.id, ready.id, {
    content: {
      ...ready.content,
      overview: { text: 'Ručně upravené shrnutí.', citations: [ready.content.overview.citations[0]] }
    }
  })
  service.addGap(session.id, { startMs: 5000, endMs: 6000, reason: 'network' })
  assert.throws(() => summary.requestSummary(session.id), /manual edit/i)
  const forced = summary.requestSummary(session.id, { force: true })
  assert.notEqual(forced.summary.id, ready.id)
  const regenerated = await summary.run(forced.summary.id)
  assert.equal(regenerated.status, 'ready')
})

test('a correction only stales summaries that cite the corrected turn', async (t) => {
  const { service, worker, summary } = setup(t, {
    generate: async ({ turns }) => ({
      overview: { text: 'Shrnutí.', citations: [turns[1].id] },
      decisions: [],
      actionCandidates: [],
      openQuestions: []
    })
  })
  const { session, detail } = await transcribed(service, worker, 2)
  service.endSession(session.id, { writerId: 'test' })
  const requested = summary.requestSummary(session.id)
  const ready = await summary.run(requested.summary.id)
  const preparation = summary.createPreparation(session.id, { sourceSummaryId: ready.id })
  service.correctTurn(session.id, detail.turns[0].id, { text: 'Opravený přepis' })
  assert.equal(summary.getSummary(session.id, ready.id).status, 'ready')
  assert.equal(summary.getPreparation(session.id, preparation.id).status, 'ready')
})

test('ending a partially summarized session creates a complete summary for the same transcript revision', async (t) => {
  const { service, worker, summary } = setup(t)
  const { session } = await transcribed(service, worker, 1)
  const partial = summary.requestSummary(session.id, { allowPartial: true })
  const partialReady = await summary.run(partial.summary.id)
  assert.equal(partialReady.content.coverage.declared, 'partial')
  service.endSession(session.id, { writerId: 'test' })
  const complete = summary.requestSummary(session.id)
  assert.notEqual(complete.summary.id, partialReady.id)
  const completeReady = await summary.run(complete.summary.id)
  assert.equal(completeReady.content.coverage.declared, 'complete')
  assert.equal(summary.getSummary(session.id, partialReady.id).status, 'ready')
})

test('accepting a new segment marks a ready summary stale', async (t) => {
  const { service, worker, summary } = setup(t)
  const { session } = await transcribed(service, worker, 1)
  const ready = await summary.run(summary.requestSummary(session.id, { allowPartial: true }).summary.id)
  segment(service, session, 1)
  const stale = summary.getSummary(session.id, ready.id)
  assert.equal(stale.status, 'stale')
  assert.equal(stale.staleReason, 'transcript_extended')
})

test('adding a coverage gap marks a ready summary stale', async (t) => {
  const { service, worker, summary } = setup(t)
  const { session } = await transcribed(service, worker, 1)
  const ready = await summary.run(summary.requestSummary(session.id, { allowPartial: true }).summary.id)
  service.addGap(session.id, { startMs: 5000, endMs: 6000, reason: 'network' })
  const stale = summary.getSummary(session.id, ready.id)
  assert.equal(stale.status, 'stale')
  assert.equal(stale.staleReason, 'transcript_incomplete')
})

test('ending with a missing segment marks a ready summary stale', async (t) => {
  const { service, worker, summary } = setup(t)
  const { session } = await transcribed(service, worker, 1)
  const ready = await summary.run(summary.requestSummary(session.id, { allowPartial: true }).summary.id)
  service.endSession(session.id, { writerId: 'test', lastSequence: 1 })
  const stale = summary.getSummary(session.id, ready.id)
  assert.equal(stale.status, 'stale')
  assert.equal(stale.staleReason, 'transcript_incomplete')
})

test('an ended session with a coverage gap still produces a partial summary', async (t) => {
  const { service, worker, summary } = setup(t)
  const { session } = await transcribed(service, worker, 1)
  service.endSession(session.id, { writerId: 'test', lastSequence: 1 })
  const requested = summary.requestSummary(session.id)
  const ready = await summary.run(requested.summary.id)
  assert.equal(ready.status, 'ready')
  assert.equal(ready.content.coverage.declared, 'partial')
  assert.ok(ready.content.coverage.gaps.length > 0)
})

test('a partial summary of an ended session is replaced by a complete summary after pending transcription', async (t) => {
  const { service, worker, summary } = setup(t)
  const session = started(service)
  segment(service, session, 0)
  await worker.tick()
  segment(service, session, 1)
  service.endSession(session.id, { writerId: 'test' })
  const partial = summary.requestSummary(session.id, { allowPartial: true })
  const partialReady = await summary.run(partial.summary.id)
  assert.equal(partialReady.content.coverage.declared, 'partial')
  await worker.tick()
  const complete = summary.requestSummary(session.id)
  assert.notEqual(complete.summary.id, partialReady.id)
  const completeReady = await summary.run(complete.summary.id)
  assert.equal(completeReady.content.coverage.declared, 'complete')
  assert.equal(summary.getSummary(session.id, partialReady.id).status, 'stale')
  assert.equal(summary.getSummary(session.id, partialReady.id).staleReason, 'transcript_extended')
})

test('expired untranscribed audio marks a partial summary stale', async (t) => {
  const { service, worker, summary, clock } = setup(t)
  const { session } = await transcribed(service, worker, 1)
  segment(service, session, 1)
  const requested = summary.requestSummary(session.id, { allowPartial: true })
  const ready = await summary.run(requested.summary.id)
  assert.equal(ready.status, 'ready')
  assert.equal(ready.content.coverage.declared, 'partial')
  clock.now += 86400001
  const pruned = service.prune()
  assert.equal(pruned.audio, 1)
  const stale = summary.getSummary(session.id, ready.id)
  assert.equal(stale.status, 'stale')
  assert.equal(stale.staleReason, 'transcript_incomplete')
})

test('a preparation is removed with its source session', async (t) => {
  const { service, worker, summary } = setup(t)
  const { session: source } = await transcribed(service, worker, 1)
  service.endSession(source.id, { writerId: 'test' })
  const ready = await summary.run(summary.requestSummary(source.id).summary.id)
  const target = service.createSession({ name: 'Next conversation' })
  const preparation = summary.createPreparation(target.id, { sourceSummaryId: ready.id })
  service.deleteSession(source.id)
  assert.throws(() => summary.getPreparation(target.id, preparation.id), /not found/i)
})

test('deleting a session removes its summaries, citations and preparations', async (t) => {
  const { db, service, worker, summary } = setup(t)
  const { session } = await transcribed(service, worker, 2)
  service.endSession(session.id, { writerId: 'test' })
  const requested = summary.requestSummary(session.id)
  const ready = await summary.run(requested.summary.id)
  summary.createPreparation(session.id, { sourceSummaryId: ready.id })
  service.deleteSession(session.id)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM summaries').get().count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM summary_citations').get().count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM action_candidates').get().count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM preparations').get().count, 0)
})
