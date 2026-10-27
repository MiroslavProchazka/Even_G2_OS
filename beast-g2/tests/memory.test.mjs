import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDatabase } from '../server/sessions/db.mjs'
import { Repository } from '../server/sessions/repository.mjs'
import { SessionService } from '../server/sessions/service.mjs'
import { MEMORY_KINDS, deleteMemoryForSession, foldText, getMemoryItem, listMemoryItems, memoryItemId, proposeMemoryItem, setMemoryStatus, supersedeMemoryItem } from '../server/sessions/memory.mjs'

const NOW = 1_800_000_000_000
const HEX = () => randomUUID().replaceAll('-', '')

function rejects(fn, status, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.status, status, `${error.code}: ${error.message}`)
    assert.equal(error.code, code)
    return true
  })
}

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'beast-memory-'))
  const dataDir = path.join(dir, 'data')
  const db = openDatabase(path.join(dataDir, 'sessions.sqlite'))
  const repo = new Repository(db, { now: () => NOW })
  const service = new SessionService({ repo, dataDir, now: () => NOW })
  t.after(() => {
    if (db.open) db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, dataDir, db, repo, service, workspaceId: service.workspace.id }
}

function addTurn(repo, sessionId, text, sequence = 0) {
  const segment = repo.insertSegment({
    id: `seg_${HEX()}`,
    sessionId,
    sequence,
    startMs: sequence * 30_000,
    endMs: sequence * 30_000 + 30_000,
    contentHash: `hash-${sequence}`,
    audioPath: '',
    audioBytes: 0,
    state: 'transcribed',
    createdAt: NOW,
    audioExpiresAt: NOW + 86_400_000
  })
  return repo.insertTurn({
    id: `turn_${HEX()}`,
    sessionId,
    segmentId: segment.id,
    text,
    revision: 1,
    source: 'stt',
    startMs: segment.startMs,
    endMs: segment.endMs,
    createdAt: NOW,
    updatedAt: NOW
  }).turn
}

function sessionWithTurn(fx, name = 'Synthetic memory') {
  const session = fx.service.createSession({ name })
  const turn = addTurn(fx.repo, session.id, 'Rozpočet na projekt je 120 tisíc korun.', 0)
  return { session, turn }
}

function propose(fx, session, turn, overrides = {}) {
  return proposeMemoryItem({
    repo: fx.repo,
    workspaceId: fx.workspaceId,
    sessionId: session.id,
    turnId: turn.id,
    revision: turn.revision,
    kind: 'decision',
    text: 'Rozpočet je 120 tisíc korun.',
    now: NOW,
    ...overrides
  })
}

test('a proposal is stored as proposed with the exact source quote', (t) => {
  const fx = fixture(t)
  const { session, turn } = sessionWithTurn(fx)

  const item = propose(fx, session, turn, { text: '  Rozpočet je 120 tisíc korun.  ' })

  assert.match(item.id, /^mem_[a-f0-9]{32}$/)
  assert.equal(item.workspaceId, fx.workspaceId)
  assert.equal(item.sessionId, session.id)
  assert.equal(item.turnId, turn.id)
  assert.equal(item.turnRevision, 1)
  assert.equal(item.kind, 'decision')
  assert.equal(item.text, 'Rozpočet je 120 tisíc korun.')
  assert.equal(item.sourceQuote, turn.text)
  assert.equal(item.status, 'proposed')
  assert.equal(item.supersedesId, null)
  assert.equal(item.sourceDeleted, false)
  assert.equal(item.evidenceState, 'present')
  assert.equal(item.createdAt, NOW)
  assert.equal(item.updatedAt, NOW)
  assert.equal(item.approvedAt, null)
  assert.equal(item.rejectedAt, null)
  assert.equal(item.supersededAt, null)

  const row = fx.db.prepare('SELECT source_deleted AS sourceDeleted, evidence_state AS evidenceState, status FROM memory_items WHERE id = ?').get(item.id)
  assert.deepEqual(row, { sourceDeleted: 0, evidenceState: 'present', status: 'proposed' })
  assert.deepEqual(listMemoryItems({ repo: fx.repo, sessionId: session.id }), [], 'a proposal is never returned by default retrieval')
  assert.deepEqual(
    listMemoryItems({ repo: fx.repo, sessionId: session.id, status: 'proposed' }).map((entry) => entry.id),
    [item.id]
  )
})

test('a proposal must name a turn of this session at its current revision', (t) => {
  const fx = fixture(t)
  const { session, turn } = sessionWithTurn(fx)
  const other = sessionWithTurn(fx, 'Other session')

  rejects(() => propose(fx, session, turn, { turnId: other.turn.id }), 404, 'not_found')
  rejects(() => propose(fx, session, turn, { turnId: `turn_${'a'.repeat(32)}` }), 404, 'not_found')
  rejects(() => propose(fx, session, turn, { turnId: 'not-a-turn' }), 400, 'invalid_turn')
  rejects(() => propose(fx, session, turn, { revision: 2 }), 409, 'stale_revision')
  rejects(() => propose(fx, session, turn, { revision: '1' }), 400, 'invalid_revision')
  rejects(() => propose(fx, session, turn, { kind: 'other' }), 400, 'invalid_kind')
  rejects(() => propose(fx, session, turn, { text: '   ' }), 400, 'invalid_text')
  rejects(() => propose(fx, session, turn, { text: 'x'.repeat(501) }), 400, 'invalid_text')
  rejects(() => propose(fx, session, turn, { text: 42 }), 400, 'invalid_text')
  rejects(() => propose(fx, { id: `ses_${'b'.repeat(32)}` }, turn), 404, 'not_found')

  const corrected = fx.repo.updateTurnText(turn.id, 'Opravený přepis.', 2, 'manual', NOW + 1)
  rejects(() => propose(fx, session, turn), 409, 'stale_revision')
  const current = propose(fx, session, corrected, { revision: 2 })
  assert.equal(current.turnRevision, 2)
  assert.equal(current.sourceQuote, 'Opravený přepis.')

  assert.equal(fx.db.prepare('SELECT COUNT(*) AS count FROM memory_items').get().count, 1)
})

test('every kind is accepted and the text limit is 500 characters', (t) => {
  const fx = fixture(t)
  const { session, turn } = sessionWithTurn(fx)

  for (const kind of MEMORY_KINDS) {
    const item = propose(fx, session, turn, { kind, text: `${kind} claim` })
    assert.equal(item.kind, kind)
  }
  const longest = propose(fx, session, turn, { text: 'x'.repeat(500) })
  assert.equal(longest.text.length, 500)
  assert.equal(fx.db.prepare('SELECT COUNT(*) AS count FROM memory_items').get().count, MEMORY_KINDS.length + 1)
})

test('approval and rejection are idempotent and reject other transitions', (t) => {
  const fx = fixture(t)
  const { session, turn } = sessionWithTurn(fx)
  const first = propose(fx, session, turn)
  const second = propose(fx, session, turn, { text: 'Druhá položka.' })

  const approved = setMemoryStatus({ repo: fx.repo, sessionId: session.id, memoryId: first.id, status: 'approved', now: NOW + 10 })
  assert.equal(approved.status, 'approved')
  assert.equal(approved.approvedAt, NOW + 10)
  assert.equal(approved.rejectedAt, null)
  assert.equal(approved.updatedAt, NOW + 10)
  const again = setMemoryStatus({ repo: fx.repo, sessionId: session.id, memoryId: first.id, status: 'approved', now: NOW + 20 })
  assert.equal(again.approvedAt, NOW + 10, 'the original approval time is kept')
  assert.equal(again.updatedAt, NOW + 10)

  const rejected = setMemoryStatus({ repo: fx.repo, sessionId: session.id, memoryId: second.id, status: 'rejected', now: NOW + 30 })
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.rejectedAt, NOW + 30)
  assert.equal(rejected.approvedAt, null)

  rejects(() => setMemoryStatus({ repo: fx.repo, sessionId: session.id, memoryId: second.id, status: 'approved', now: NOW + 40 }), 409, 'invalid_transition')
  rejects(() => setMemoryStatus({ repo: fx.repo, sessionId: session.id, memoryId: first.id, status: 'rejected', now: NOW + 40 }), 409, 'invalid_transition')
  rejects(() => setMemoryStatus({ repo: fx.repo, sessionId: session.id, memoryId: first.id, status: 'proposed', now: NOW + 40 }), 400, 'invalid_status')
  rejects(() => setMemoryStatus({ repo: fx.repo, sessionId: session.id, memoryId: `mem_${'a'.repeat(32)}`, status: 'approved', now: NOW }), 404, 'not_found')

  const other = sessionWithTurn(fx, 'Other session')
  const foreign = propose(fx, other.session, other.turn)
  rejects(() => setMemoryStatus({ repo: fx.repo, sessionId: session.id, memoryId: foreign.id, status: 'approved', now: NOW }), 404, 'not_found')
  assert.equal(getMemoryItem({ repo: fx.repo, sessionId: session.id, memoryId: foreign.id }), null)
})

test('a replacement keeps the old row and marks it superseded', (t) => {
  const fx = fixture(t)
  const { session, turn } = sessionWithTurn(fx)
  const old = propose(fx, session, turn)
  setMemoryStatus({ repo: fx.repo, sessionId: session.id, memoryId: old.id, status: 'approved', now: NOW + 10 })

  const { item, superseded } = supersedeMemoryItem({
    repo: fx.repo,
    sessionId: session.id,
    memoryId: old.id,
    kind: 'commitment',
    text: 'Rozpočet schválíme do pátku.',
    now: NOW + 20
  })

  assert.equal(item.status, 'proposed')
  assert.equal(item.kind, 'commitment')
  assert.equal(item.text, 'Rozpočet schválíme do pátku.')
  assert.equal(item.supersedesId, old.id)
  assert.equal(item.turnId, old.turnId)
  assert.equal(item.turnRevision, old.turnRevision)
  assert.equal(item.sourceQuote, old.sourceQuote)
  assert.equal(item.createdAt, NOW + 20)
  assert.equal(superseded.status, 'superseded')
  assert.equal(superseded.supersededAt, NOW + 20)
  assert.equal(superseded.updatedAt, NOW + 20)
  assert.equal(superseded.text, old.text, 'the replaced text is preserved')

  assert.deepEqual(listMemoryItems({ repo: fx.repo, sessionId: session.id }), [], 'neither the superseded nor the replacement is approved')
  assert.deepEqual(
    listMemoryItems({ repo: fx.repo, sessionId: session.id, status: 'all' })
      .map((entry) => entry.status)
      .sort(),
    ['proposed', 'superseded']
  )

  const replacement = supersedeMemoryItem({ repo: fx.repo, sessionId: session.id, memoryId: item.id, text: 'Třetí znění.', now: NOW + 30 })
  assert.equal(replacement.item.kind, 'commitment', 'the kind is inherited when it is not given')
  assert.equal(replacement.item.supersedesId, item.id)

  const rejected = propose(fx, session, turn, { text: 'Zamítnutá položka.' })
  setMemoryStatus({ repo: fx.repo, sessionId: session.id, memoryId: rejected.id, status: 'rejected', now: NOW + 40 })
  rejects(() => supersedeMemoryItem({ repo: fx.repo, sessionId: session.id, memoryId: rejected.id, text: 'Nová verze.', now: NOW + 50 }), 409, 'invalid_transition')
  rejects(() => supersedeMemoryItem({ repo: fx.repo, sessionId: session.id, memoryId: superseded.id, text: 'Nová verze.', now: NOW + 50 }), 409, 'invalid_transition')
  const fresh = sessionWithTurn(fx, 'Fresh session')
  const pending = propose(fx, fresh.session, fresh.turn)
  rejects(() => supersedeMemoryItem({ repo: fx.repo, sessionId: fresh.session.id, memoryId: pending.id, text: '  ', now: NOW + 50 }), 400, 'invalid_text')
  rejects(() => supersedeMemoryItem({ repo: fx.repo, sessionId: fresh.session.id, memoryId: pending.id, kind: 'other', text: 'Nová verze.', now: NOW + 50 }), 400, 'invalid_kind')
})

test('default retrieval returns approved items only and folds Czech diacritics', (t) => {
  const fx = fixture(t)
  const { session, turn } = sessionWithTurn(fx)
  const approved = propose(fx, session, turn, { text: 'Zrušit schůzku kvůli rozpočtu.' })
  setMemoryStatus({ repo: fx.repo, sessionId: session.id, memoryId: approved.id, status: 'approved', now: NOW + 1 })
  propose(fx, session, turn, { kind: 'open_question', text: 'Kdo schválí rozpočet?' })
  const rejected = propose(fx, session, turn, { text: 'Příprava je hotová.' })
  setMemoryStatus({ repo: fx.repo, sessionId: session.id, memoryId: rejected.id, status: 'rejected', now: NOW + 2 })
  const old = propose(fx, session, turn, { text: 'Staré znění.' })
  supersedeMemoryItem({ repo: fx.repo, sessionId: session.id, memoryId: old.id, text: 'Nové znění.', now: NOW + 3 })

  assert.deepEqual(
    listMemoryItems({ repo: fx.repo, sessionId: session.id }).map((item) => item.id),
    [approved.id]
  )
  assert.equal(listMemoryItems({ repo: fx.repo, sessionId: session.id, status: 'proposed' }).length, 2)
  assert.equal(listMemoryItems({ repo: fx.repo, sessionId: session.id, status: 'rejected' }).length, 1)
  assert.equal(listMemoryItems({ repo: fx.repo, sessionId: session.id, status: 'superseded' }).length, 1)
  assert.equal(listMemoryItems({ repo: fx.repo, sessionId: session.id, status: 'all' }).length, 5)

  assert.deepEqual(
    listMemoryItems({ repo: fx.repo, sessionId: session.id, query: 'ZRUSIT SCHUZKU' }).map((item) => item.id),
    [approved.id]
  )
  assert.deepEqual(
    listMemoryItems({ repo: fx.repo, sessionId: session.id, query: 'schuzku' }).map((item) => item.id),
    [approved.id],
    'a partially folded query still matches'
  )
  assert.deepEqual(
    listMemoryItems({ repo: fx.repo, sessionId: session.id, query: 'rozpoctu' }).map((item) => item.id),
    [approved.id]
  )
  assert.deepEqual(listMemoryItems({ repo: fx.repo, sessionId: session.id, query: 'nerozpoznane' }), [])
  rejects(() => listMemoryItems({ repo: fx.repo, sessionId: session.id, query: 'x'.repeat(201) }), 400, 'invalid_query')
  rejects(() => listMemoryItems({ repo: fx.repo, sessionId: session.id, status: 'deleted' }), 400, 'invalid_status')

  const other = sessionWithTurn(fx, 'Other session')
  const foreign = propose(fx, other.session, other.turn, { text: 'Cizí položka.' })
  setMemoryStatus({ repo: fx.repo, sessionId: other.session.id, memoryId: foreign.id, status: 'approved', now: NOW + 4 })
  assert.deepEqual(
    listMemoryItems({ repo: fx.repo, sessionId: session.id, status: 'all' }).map((item) => item.id),
    listMemoryItems({ repo: fx.repo, sessionId: session.id, status: 'all' })
      .map((item) => item.id)
      .filter((id) => id !== foreign.id)
  )
  assert.ok(!listMemoryItems({ repo: fx.repo, sessionId: session.id, status: 'all' }).some((item) => item.id === foreign.id))
  rejects(() => listMemoryItems({ repo: fx.repo, sessionId: `ses_${'c'.repeat(32)}` }), 404, 'not_found')
})

test('deleting the source session deletes derived items unless they are kept', (t) => {
  const fx = fixture(t)
  const kept = sessionWithTurn(fx, 'Kept session')
  const keptItem = propose(fx, kept.session, kept.turn)
  setMemoryStatus({ repo: fx.repo, sessionId: kept.session.id, memoryId: keptItem.id, status: 'approved', now: NOW + 1 })
  const dropped = sessionWithTurn(fx, 'Dropped session')
  const droppedItem = propose(fx, dropped.session, dropped.turn)
  const droppedReplacement = supersedeMemoryItem({ repo: fx.repo, sessionId: dropped.session.id, memoryId: droppedItem.id, text: 'Náhradní znění.', now: NOW + 2 })

  assert.equal(fx.service.deleteSession(kept.session.id, { keepMemory: true }), true)
  const survivor = getMemoryItem({ repo: fx.repo, sessionId: kept.session.id, memoryId: keptItem.id })
  assert.equal(survivor.status, 'approved')
  assert.equal(survivor.text, keptItem.text)
  assert.equal(survivor.sourceQuote, keptItem.sourceQuote)
  assert.equal(survivor.sourceDeleted, true)
  assert.equal(survivor.evidenceState, 'lost')
  assert.equal(survivor.updatedAt, NOW)
  assert.equal(fx.db.prepare('SELECT id FROM sessions WHERE id = ?').get(kept.session.id), undefined)

  assert.equal(fx.service.deleteSession(dropped.session.id), true)
  assert.equal(getMemoryItem({ repo: fx.repo, sessionId: dropped.session.id, memoryId: droppedItem.id }), null)
  assert.equal(getMemoryItem({ repo: fx.repo, sessionId: dropped.session.id, memoryId: droppedReplacement.item.id }), null, 'a supersede chain is removed in one statement')

  const retention = sessionWithTurn(fx, 'Retention session')
  const retentionItem = propose(fx, retention.session, retention.turn)
  fx.repo.deleteSession(retention.session.id)
  assert.equal(getMemoryItem({ repo: fx.repo, sessionId: retention.session.id, memoryId: retentionItem.id }), null, 'a plain session delete removes derived items too')
})

test('deleteMemoryForSession reports what it removed and keeps the rest', (t) => {
  const fx = fixture(t)
  const { session, turn } = sessionWithTurn(fx)
  propose(fx, session, turn)

  assert.deepEqual(deleteMemoryForSession(fx.db, session.id, { keep: true, now: NOW + 5 }), { deleted: 0, kept: 1 })
  assert.deepEqual(deleteMemoryForSession(fx.db, session.id, { keep: true, now: NOW + 6 }), { deleted: 0, kept: 0 })
  assert.deepEqual(deleteMemoryForSession(fx.db, session.id), { deleted: 1, kept: 0 })
})

test('the schema rejects an unknown kind, status and evidence state', (t) => {
  const fx = fixture(t)
  const { session, turn } = sessionWithTurn(fx)
  const insert = fx.db.prepare(`INSERT INTO memory_items (
    id, workspace_id, session_id, turn_id, turn_revision, kind, text, source_quote, status,
    source_deleted, evidence_state, created_at, updated_at
  ) VALUES (?, ?, ?, ?, 1, ?, 'claim', 'quote', ?, ?, ?, ?, ?)`)

  assert.throws(() => insert.run(memoryItemId(), fx.workspaceId, session.id, turn.id, 'other', 'proposed', 0, 'present', NOW, NOW), /CHECK/)
  assert.throws(() => insert.run(memoryItemId(), fx.workspaceId, session.id, turn.id, 'fact', 'pending', 0, 'present', NOW, NOW), /CHECK/)
  assert.throws(() => insert.run(memoryItemId(), fx.workspaceId, session.id, turn.id, 'fact', 'proposed', 0, 'unknown', NOW, NOW), /CHECK/)
  assert.throws(() => insert.run(memoryItemId(), fx.workspaceId, session.id, turn.id, 'fact', 'proposed', 2, 'present', NOW, NOW), /CHECK/)
})

test('foldText removes Czech diacritics and case', () => {
  assert.equal(foldText('Zrušit schůzku kvůli rozpočtu'), 'zrusit schuzku kvuli rozpoctu')
  assert.equal(foldText('PŘÍPRAVA'), 'priprava')
  assert.equal(foldText(''), '')
  assert.equal(foldText(undefined), '')
})
