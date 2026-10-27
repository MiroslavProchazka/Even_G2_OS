import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrate, migrations, openDatabase } from '../server/sessions/db.mjs'
import { Repository } from '../server/sessions/repository.mjs'
import { clampLimit, searchSessions, tokenizeQuery } from '../server/sessions/search.mjs'

const now = 1_700_000_000_000
let counter = 0

function setup(t) {
  const db = openDatabase(':memory:')
  const repo = new Repository(db)
  repo.ensureWorkspace()
  t.after(() => db.close())
  return { db, repo }
}

function createSession(repo, name, overrides = {}) {
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

test('search finds Czech text with and without diacritics', (t) => {
  const { repo } = setup(t)
  const session = createSession(repo, 'Rozpočet')
  const turn = addTurn(repo, session.id, 'Zrušit schůzku kvůli rozpočtu', 5000)

  const withoutDiacritics = searchSessions(repo, { query: 'zrusit' })
  assert.equal(withoutDiacritics.length, 1)
  assert.equal(withoutDiacritics[0].turnId, turn.id)
  assert.equal(withoutDiacritics[0].sessionId, session.id)
  assert.equal(withoutDiacritics[0].sessionName, 'Rozpočet')
  assert.equal(withoutDiacritics[0].revision, 1)
  assert.equal(withoutDiacritics[0].startMs, 5000)
  assert.equal(withoutDiacritics[0].endMs, 6000)
  assert.match(withoutDiacritics[0].snippet, /\[Zrušit\]/)

  const withDiacritics = searchSessions(repo, { query: 'zrušit' })
  assert.deepEqual(
    withDiacritics.map((result) => result.turnId),
    [turn.id]
  )
})

test('search ranks the better bm25 hit first and falls back to the transcript order', (t) => {
  const { repo } = setup(t)
  const session = createSession(repo, 'Rozpočet')
  const long = addTurn(repo, session.id, 'Dlouhý text o všem možném a taky rozpočet a ještě něco navíc kolem dokola', 1000)
  const short = addTurn(repo, session.id, 'Rozpočet', 2000)
  const middle = addTurn(repo, session.id, 'Zrušit schůzku kvůli rozpočet', 5000)

  const ranked = searchSessions(repo, { query: 'rozpocet' })
  assert.deepEqual(
    ranked.map((result) => result.turnId),
    [short.id, middle.id, long.id]
  )

  const tied = createSession(repo, 'Stejný text')
  const later = addTurn(repo, tied.id, 'rozpočet', 9000)
  const earlier = addTurn(repo, tied.id, 'rozpočet', 3000)
  assert.deepEqual(
    searchSessions(repo, { query: 'rozpocet' }).map((result) => result.turnId),
    [short.id, earlier.id, later.id, middle.id, long.id]
  )
})

test('a deleted session never appears in the results', (t) => {
  const { repo } = setup(t)
  const live = createSession(repo, 'Živá')
  const liveTurn = addTurn(repo, live.id, 'Zrušit schůzku', 1000)
  const deleted = createSession(repo, 'Smazaná', { status: 'deleted' })
  addTurn(repo, deleted.id, 'Zrušit všechno', 0)

  const results = searchSessions(repo, { query: 'zrusit' })
  assert.deepEqual(
    results.map((result) => result.sessionId),
    [live.id]
  )
  assert.equal(results[0].turnId, liveTurn.id)

  const removed = createSession(repo, 'Opravdu smazaná')
  addTurn(repo, removed.id, 'Zrušit navždy', 0)
  repo.deleteSession(removed.id)
  assert.equal(searchSessions(repo, { query: 'zrusit' }).length, 1)
})

test('an empty or punctuation-only query is rejected with 400 query_required', (t) => {
  const { repo } = setup(t)
  for (const query of ['', '   ', '!!!', undefined, null]) {
    assert.throws(
      () => searchSessions(repo, { query }),
      (error) => error.status === 400 && error.code === 'query_required'
    )
  }
})

test('the limit is clamped to 1..50 and a malformed value keeps the default', (t) => {
  const { repo } = setup(t)
  const session = createSession(repo, 'Mnoho')
  for (let index = 0; index < 55; index += 1) addTurn(repo, session.id, `rozpočet ${index}`, index * 1000)

  assert.equal(searchSessions(repo, { query: 'rozpocet', limit: 0 }).length, 1)
  assert.equal(searchSessions(repo, { query: 'rozpocet', limit: 500 }).length, 50)
  assert.equal(searchSessions(repo, { query: 'rozpocet', limit: 'abc' }).length, 50)
  assert.equal(clampLimit(-5), 1)
  assert.equal(clampLimit(500), 50)
  assert.equal(clampLimit(undefined), 50)
  assert.equal(clampLimit('7'), 7)
})

test('FTS5 operators in user input are read as text, not as syntax', (t) => {
  const { repo } = setup(t)
  const session = createSession(repo, 'Operátory')
  const either = addTurn(repo, session.id, 'Either this or that', 1000)
  addTurn(repo, session.id, 'rozpoct', 2000)

  assert.deepEqual(
    searchSessions(repo, { query: '" OR *' }).map((result) => result.turnId),
    [either.id]
  )
  assert.equal(searchSessions(repo, { query: 'rozp*' }).length, 0)
  assert.equal(searchSessions(repo, { query: 'NEAR(rozpocet)' }).length, 0)
  assert.equal(tokenizeQuery('  "Zrušit" OR *  ').length, 2)
  assert.equal(tokenizeQuery('a b c d e f g h i j').length, 8)
  assert.equal(tokenizeQuery('x'.repeat(60))[0].length, 40)
})

test('migration 3 backfills turns stored before the index existed', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)')
  for (const migration of migrations.filter((entry) => entry.version <= 2)) {
    db.exec(migration.sql)
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, now)
  }
  const repo = new Repository(db)
  repo.ensureWorkspace()
  const session = createSession(repo, 'Starý záznam')
  const turn = addTurn(repo, session.id, 'Zrušit schůzku kvůli rozpočtu', 4000)
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'transcript_search'").get(), undefined)

  migrate(db)

  const results = searchSessions(repo, { query: 'zrusit' })
  assert.equal(results.length, 1)
  assert.equal(results[0].turnId, turn.id)
  assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 5)
  db.close()
})

test('a correction and a delete keep the index in sync', (t) => {
  const { repo } = setup(t)
  const session = createSession(repo, 'Revize')
  const turn = addTurn(repo, session.id, 'Původní znění', 1000)
  assert.equal(searchSessions(repo, { query: 'puvodni' }).length, 1)

  repo.updateTurnText(turn.id, 'Opravené znění', 2, 'manual', now)
  assert.equal(searchSessions(repo, { query: 'puvodni' }).length, 0)
  const corrected = searchSessions(repo, { query: 'opravene' })
  assert.equal(corrected.length, 1)
  assert.equal(corrected[0].revision, 2)
  assert.equal(corrected[0].snippet, '[Opravené] znění')

  repo.db.prepare('DELETE FROM transcript_turns WHERE id = ?').run(turn.id)
  assert.equal(searchSessions(repo, { query: 'opravene' }).length, 0)
  assert.equal(repo.db.prepare('SELECT COUNT(*) AS count FROM transcript_search').get().count, 0)
})
