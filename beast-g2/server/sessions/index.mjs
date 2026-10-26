import { transcribeAudio } from '../stt.mjs'
import { openDatabase } from './db.mjs'
import { Repository } from './repository.mjs'
import { SessionService } from './service.mjs'
import { TranscriptionWorker } from './worker.mjs'

export function demoTranscribe({ sequence }) {
  return `Demo přepis segmentu ${sequence}.`
}

export function createSessions({ config, transcribe, logger = () => {} }) {
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
  return { db, repo, service, worker }
}
