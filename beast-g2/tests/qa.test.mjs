import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase } from '../server/sessions/db.mjs'
import { QaService, candidatePassages, contextTurns, extractiveAnswer, validateAnswer } from '../server/sessions/qa.mjs'
import { Repository } from '../server/sessions/repository.mjs'

const now = 1_700_000_000_000
let counter = 0

function setup(t, { answer, limits = {} } = {}) {
  const db = openDatabase(':memory:')
  const repo = new Repository(db)
  repo.ensureWorkspace()
  const calls = []
  const qa = new QaService({
    repo,
    answer:
      answer ??
      (async (input) => {
        calls.push(input)
        return { text: 'Rozpočet je 120 tisíc korun.', citations: [{ turnId: input.turns[0].id, revision: input.turns[0].revision }] }
      }),
    limits,
    logger: () => {}
  })
  t.after(() => db.close())
  return { db, repo, qa, calls }
}

function createSession(repo, name = 'Rozpočet', overrides = {}) {
  counter += 1
  return repo.createSession({
    id: `ses_${String(counter).padStart(32, '0')}`,
    workspaceId: 'default',
    name,
    source: 'import',
    language: 'cs',
    goal: '',
    prep: '',
    timezone: 'Europe/Prague',
    status: 'ended',
    captureState: 'off',
    transcriptRevision: 1,
    coverageDeclared: 'complete',
    retentionDays: 30,
    createdAt: now,
    expiresAt: now + 86_400_000,
    ...overrides
  })
}

let sequence = 0

function addTurn(repo, sessionId, text, startMs, revision = 1) {
  counter += 1
  const id = `trn_${String(counter).padStart(32, '0')}`
  const segmentId = `seg_${String(counter).padStart(32, '0')}`
  sequence += 1
  repo.insertSegment({
    id: segmentId,
    sessionId,
    sequence,
    startMs,
    endMs: startMs + 1000,
    contentHash: 'hash',
    audioPath: '',
    audioBytes: 0,
    state: 'transcribed',
    createdAt: now,
    audioExpiresAt: now
  })
  const inserted = repo.insertTurn({ id, sessionId, segmentId, text, revision, source: 'stt', startMs, endMs: startMs + 1000, createdAt: now, updatedAt: now })
  return inserted.turn
}

function budgetSession(repo) {
  const session = createSession(repo)
  const first = addTurn(repo, session.id, 'Rozpočet na projekt je 120 tisíc korun.', 0)
  const second = addTurn(repo, session.id, 'Termín schůzky je v pátek odpoledne.', 60_000)
  const third = addTurn(repo, session.id, 'Dohodli jsme se, že rozpočet schválíme příští týden.', 120_000)
  return { session, first, second, third }
}

function insertSummary(repo, sessionId, { id, transcriptRevision = 1, createdAt = now + 1, content = {} } = {}) {
  counter += 1
  return repo.insertSummary({
    id: id ?? `sum_${String(counter).padStart(32, '0')}`,
    sessionId,
    transcriptRevision,
    generator: 'test',
    promptVersion: 'summary-v1',
    contentJson: JSON.stringify(content),
    coverageJson: '{}',
    status: 'ready',
    reviewStatus: 'unreviewed',
    staleReason: null,
    lastError: null,
    supersedesId: null,
    idempotencyKey: `key-${counter}`,
    createdAt,
    updatedAt: createdAt
  })
}

test('a cited answer is returned with the cited turn time and quote', async (t) => {
  const { repo, qa, calls } = setup(t)
  const { session, first, third } = budgetSession(repo)

  const answer = await qa.ask(session.id, { question: 'rozpočet' })

  assert.equal(answer.evidence, 'sufficient')
  assert.equal(answer.text, 'Rozpočet je 120 tisíc korun.')
  assert.equal(answer.citations.length, 1)
  assert.equal(answer.citations[0].turnId, first.id)
  assert.equal(answer.citations[0].revision, 1)
  assert.equal(answer.citations[0].startMs, 0)
  assert.equal(answer.citations[0].endMs, 1000)
  assert.equal(answer.citations[0].quote, first.text)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].question, 'rozpočet')
  assert.equal(calls[0].session.id, session.id)
  assert.equal(calls[0].summary, null)
  assert.deepEqual(
    calls[0].turns.map((turn) => turn.id),
    [first.id, third.id]
  )
})

test('a question with no candidate passage returns insufficient_evidence without calling the provider', async (t) => {
  const { repo, qa, calls } = setup(t)
  const { session } = budgetSession(repo)

  const answer = await qa.ask(session.id, { question: 'kvantová fyzika' })

  assert.equal(answer.evidence, 'insufficient')
  assert.deepEqual(answer.citations, [])
  assert.match(answer.text, /enough evidence/i)
  assert.equal(calls.length, 0)
})

test('a provider answer without a valid citation is dropped to insufficient_evidence', async (t) => {
  const { repo, qa } = setup(t, {
    answer: async ({ turns }) => ({ text: `Rozpočet je ${turns[0].text.length} znaků.`, citations: [] })
  })
  const { session } = budgetSession(repo)

  const answer = await qa.ask(session.id, { question: 'rozpočet' })

  assert.equal(answer.evidence, 'insufficient')
  assert.deepEqual(answer.citations, [])
  assert.match(answer.text, /enough evidence/i)
})

test('a citation for a turn that does not exist in the session is rejected', async (t) => {
  const { repo, qa } = setup(t, {
    answer: async () => ({ text: 'Rozpočet je 120 tisíc korun.', citations: [{ turnId: `trn_${'f'.repeat(32)}`, revision: 1 }] })
  })
  const { session } = budgetSession(repo)

  const answer = await qa.ask(session.id, { question: 'rozpočet' })

  assert.equal(answer.evidence, 'insufficient')
  assert.deepEqual(answer.citations, [])
})

test('a citation with a stale revision is rejected', async (t) => {
  const { repo, qa } = setup(t, {
    answer: async ({ turns }) => ({ text: 'Rozpočet je 120 tisíc korun.', citations: [{ turnId: turns[0].id, revision: 2 }] })
  })
  const { session } = budgetSession(repo)

  const answer = await qa.ask(session.id, { question: 'rozpočet' })

  assert.equal(answer.evidence, 'insufficient')
  assert.deepEqual(answer.citations, [])
})

test('an answer that shares no content word with its citation is treated as unsupported', async (t) => {
  const { repo, qa } = setup(t, {
    answer: async ({ turns }) => ({ text: 'Zítra bude slunečné počasí.', citations: [{ turnId: turns[0].id, revision: 1 }] })
  })
  const { session } = budgetSession(repo)

  const answer = await qa.ask(session.id, { question: 'rozpočet' })

  assert.equal(answer.evidence, 'insufficient')
  assert.deepEqual(answer.citations, [])
})

test('a provider timeout fails with 502 qa_failed instead of a partial answer', async (t) => {
  const { repo, qa } = setup(t, {
    limits: { qaTimeoutMs: 20 },
    answer: ({ signal }) =>
      new Promise((_resolve, reject) => {
        // The provider keeps the event loop alive; AbortSignal.timeout alone is unref'd and would let the
        // test process exit before the service timeout fires.
        const timer = setTimeout(() => reject(new Error('provider did not time out')), 1000)
        signal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new DOMException('Aborted', 'AbortError'))
        })
      })
  })
  const { session } = budgetSession(repo)

  await assert.rejects(
    () => qa.ask(session.id, { question: 'rozpočet' }),
    (error) => error.status === 502 && error.code === 'qa_failed'
  )
})

test('a provider failure fails with 502 qa_failed', async (t) => {
  const { repo, qa } = setup(t, {
    answer: async () => {
      throw new Error('provider down')
    }
  })
  const { session } = budgetSession(repo)

  await assert.rejects(
    () => qa.ask(session.id, { question: 'rozpočet' }),
    (error) => error.status === 502 && error.code === 'qa_failed' && /provider/i.test(error.message)
  )
})

test('a malformed provider answer fails with 502 qa_failed', async (t) => {
  const { repo, qa } = setup(t, { answer: async () => ({ text: 42, citations: [] }) })
  const { session } = budgetSession(repo)

  await assert.rejects(
    () => qa.ask(session.id, { question: 'rozpočet' }),
    (error) => error.status === 502 && error.code === 'qa_failed'
  )
})

test('the context is capped at 20 turns', async (t) => {
  const { repo, qa, calls } = setup(t)
  const session = createSession(repo, 'Dlouhá')
  for (let index = 0; index < 30; index += 1) addTurn(repo, session.id, `rozpočet ${index} a ještě nějaké slovo navíc`, index * 1000)

  const answer = await qa.ask(session.id, { question: 'rozpočet' })

  assert.equal(answer.evidence, 'sufficient')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].turns.length, 20)
  assert.ok(calls[0].turns.every((turn, index, list) => index === 0 || list[index - 1].startMs <= turn.startMs))
})

test('the context is capped at 12 000 characters of turn text', async (t) => {
  const { repo, qa, calls } = setup(t)
  const session = createSession(repo, 'Dlouhé turny')
  for (let index = 0; index < 5; index += 1) addTurn(repo, session.id, `rozpočet ${index} ${'x'.repeat(4000)}`, index * 1000)

  const answer = await qa.ask(session.id, { question: 'rozpočet' })

  assert.equal(answer.evidence, 'sufficient')
  assert.equal(calls.length, 1)
  assert.ok(calls[0].turns.length < 5)
  assert.ok(calls[0].turns.reduce((sum, turn) => sum + turn.text.length, 0) <= 12_000)
})

test('a question is answered from the transcript only when the summary is ready for the current revision', async (t) => {
  const { repo, qa, calls } = setup(t)
  const { session } = budgetSession(repo)
  insertSummary(repo, session.id, {
    content: {
      schemaVersion: 1,
      overview: { text: 'Rozpočet 120 tisíc.', citations: [] },
      decisions: [{ text: 'Rozpočet schválen.', citations: [] }],
      actionCandidates: [],
      openQuestions: []
    }
  })

  await qa.ask(session.id, { question: 'rozpočet' })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].summary.overview, 'Rozpočet 120 tisíc.')
  assert.deepEqual(calls[0].summary.decisions, ['Rozpočet schválen.'])

  const stale = insertSummary(repo, session.id, { transcriptRevision: 0, createdAt: now + 2, content: { overview: { text: 'Starý souhrn.' } } })
  assert.equal(stale.transcriptRevision, 0)
  await qa.ask(session.id, { question: 'rozpočet' })
  assert.equal(calls.length, 2)
  assert.equal(calls[1].summary, null)
})

test('a question never changes the transcript, the summary or the session revision', async (t) => {
  const { db, repo, qa } = setup(t)
  const { session, first } = budgetSession(repo)
  insertSummary(repo, session.id, { content: { overview: { text: 'Rozpočet 120 tisíc.', citations: [] } } })
  const beforeSession = repo.getSession(session.id)
  const beforeTurns = repo.listTurns(session.id)
  const beforeSummaries = repo.listSummaries(session.id)
  const beforeRevisions = db.prepare('SELECT COUNT(*) AS count FROM transcript_revisions').get().count

  await qa.ask(session.id, { question: 'rozpočet' })

  assert.deepEqual(repo.getSession(session.id), beforeSession)
  assert.deepEqual(repo.listTurns(session.id), beforeTurns)
  assert.deepEqual(repo.listSummaries(session.id), beforeSummaries)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM transcript_revisions').get().count, beforeRevisions)
  assert.equal(repo.getTurn(first.id).text, beforeTurns[0].text)
})

test('the default provider quotes the best matching passage and cites it', async (t) => {
  const { repo } = setup(t)
  const { session, first } = budgetSession(repo)
  const qa = new QaService({ repo, answer: extractiveAnswer })

  const answer = await qa.ask(session.id, { question: 'rozpočet' })

  assert.equal(answer.evidence, 'sufficient')
  assert.equal(answer.text, first.text)
  assert.deepEqual(
    answer.citations.map((citation) => citation.turnId),
    [first.id]
  )
})

test('a question that only matches after dropping function words still finds the passage', async (t) => {
  const { repo, qa, calls } = setup(t)
  const { session, third } = budgetSession(repo)

  const answer = await qa.ask(session.id, { question: 'Co jsme se dohodli o rozpočtu?' })

  assert.equal(answer.evidence, 'sufficient')
  assert.equal(calls.length, 1)
  assert.deepEqual(
    calls[0].turns.map((turn) => turn.id),
    [third.id]
  )
})

test('an empty or oversized question is rejected with 400', async (t) => {
  const { repo, qa } = setup(t)
  const { session } = budgetSession(repo)

  for (const question of ['', '   ', undefined, null, 42]) {
    await assert.rejects(
      () => qa.ask(session.id, { question }),
      (error) => error.status === 400 && error.code === 'question_required'
    )
  }
  await assert.rejects(
    () => qa.ask(session.id, { question: 'x'.repeat(501) }),
    (error) => error.status === 400 && error.code === 'invalid_question'
  )
})

test('an unknown session or invalid id is rejected', async (t) => {
  const { qa } = setup(t)

  await assert.rejects(
    () => qa.ask(`ses_${'f'.repeat(32)}`, { question: 'rozpočet' }),
    (error) => error.status === 404 && error.code === 'not_found'
  )
  await assert.rejects(
    () => qa.ask('search', { question: 'rozpočet' }),
    (error) => error.status === 400 && error.code === 'invalid_session'
  )
})

test('candidate passages are scoped to one session and ranked', (t) => {
  const { repo } = setup(t)
  const { session, first } = budgetSession(repo)
  const other = createSession(repo, 'Jiná')
  addTurn(repo, other.id, 'Rozpočet jiné schůzky.', 0)

  const passages = candidatePassages(repo, session.id, 'rozpočet')

  assert.ok(passages.length >= 1)
  assert.ok(passages.every((passage) => passage.sessionId === session.id))
  assert.equal(passages[0].turnId, first.id)
})

test('validateAnswer rejects an unknown turn, a stale revision and a missing citation', () => {
  const turns = [{ id: 'trn_1', revision: 3, startMs: 0, endMs: 1000, text: 'Rozpočet je 120 tisíc korun.' }]

  assert.deepEqual(validateAnswer({ text: 'Rozpočet je 120 tisíc.', citations: [{ turnId: 'trn_2', revision: 3 }] }, turns), { ok: false, reason: 'unknown_turn' })
  assert.deepEqual(validateAnswer({ text: 'Rozpočet je 120 tisíc.', citations: [{ turnId: 'trn_1', revision: 2 }] }, turns), { ok: false, reason: 'stale_revision' })
  assert.deepEqual(validateAnswer({ text: 'Rozpočet je 120 tisíc.', citations: [] }, turns), { ok: false, reason: 'no_citation' })
  assert.equal(validateAnswer({ text: 'Rozpočet je 120 tisíc.', citations: [{ turnId: 'trn_1', revision: 3 }] }, turns).ok, true)
})

test('contextTurns keeps transcript order and skips a turn that does not fit', () => {
  const turns = [
    { id: 'trn_2', revision: 1, startMs: 2000, endMs: 3000, text: 'b'.repeat(6000) },
    { id: 'trn_1', revision: 1, startMs: 1000, endMs: 2000, text: 'a'.repeat(6000) },
    { id: 'trn_3', revision: 1, startMs: 3000, endMs: 4000, text: 'c'.repeat(100) }
  ]
  const context = contextTurns(
    turns.map((turn) => ({ turnId: turn.id })),
    turns
  )

  assert.deepEqual(
    context.map((turn) => turn.id),
    ['trn_1', 'trn_2']
  )
})
