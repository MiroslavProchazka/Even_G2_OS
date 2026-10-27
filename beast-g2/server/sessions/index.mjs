import { transcribeAudio } from '../stt.mjs'
import { demoSummary, generateSummary } from '../summary-provider.mjs'
import { openDatabase } from './db.mjs'
import { QaService, extractiveAnswer } from './qa.mjs'
import { Repository } from './repository.mjs'
import { SessionService } from './service.mjs'
import { SummaryService } from './summary.mjs'
import { TranscriptionWorker } from './worker.mjs'

export function demoTranscribe({ sequence }) {
  return `Demo přepis segmentu ${sequence}.`
}

export function createSessions({ config, transcribe, summarize, answer, logger = () => {} }) {
  const db = openDatabase(config.databasePath)
  const repo = new Repository(db)
  const service = new SessionService({
    repo,
    dataDir: config.dataDir,
    logger,
    limits: {
      sessionRetentionDays: config.sessionRetentionDays,
      audioRetentionMs: config.audioRetentionHours * 60 * 60 * 1000,
      audioQuotaBytes: config.audioQuotaBytes,
      maxSessionMs: config.maxSessionMs,
      maxTranscriptChars: config.maxTranscriptChars,
      maxImportBytes: config.maxImportBytes,
      segmentMs: config.segmentMs,
      writerLeaseMs: config.writerLeaseMs,
      workerMaxAttempts: config.workerMaxAttempts,
      diskReserveBytes: config.diskReserveBytes
    }
  })
  const transcribeFn = transcribe ?? (config.demo ? demoTranscribe : (args) => transcribeAudio(config, args.audio, { language: args.language, signal: args.signal }))
  const worker = new TranscriptionWorker({
    service,
    repo,
    transcribe: transcribeFn,
    pollMs: config.workerPollMs,
    backoffMs: config.workerBackoffMs,
    timeoutMs: config.workerTimeoutMs,
    logger
  })
  const summary = new SummaryService({
    repo,
    generate: summarize ?? (config.demo ? demoSummary : (args) => generateSummary(config, args)),
    generator: config.chatModel,
    limits: {
      summaryMaxChars: config.summaryMaxChars,
      summaryChunkChars: config.summaryChunkChars,
      summaryMaxChunks: config.summaryMaxChunks,
      summaryMaxItems: config.summaryMaxItems,
      summaryTimeoutMs: config.timeout
    },
    logger
  })
  service.attachSummaryService(summary)
  const qa = new QaService({
    repo,
    answer: answer ?? extractiveAnswer,
    limits: { qaTimeoutMs: config.timeout },
    logger
  })
  // The frozen gateway signature passes only `sessions` and `summaries`, so the QA service rides on the
  // session service that every route already receives as `ctx.service`. See routes/qa.mjs.
  service.qa = qa
  summary.recoverPending()
  return { db, repo, service, worker, summary, qa }
}
