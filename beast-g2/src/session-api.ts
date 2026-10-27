/**
 * The public session contract. Every name below is re-exported from a domain module under `src/session-api/`, so a new
 * domain adds its own file and one block here without touching the existing domains.
 */
export { SessionApiError, SessionClient } from './session-api/session'
export type {
  CaptureState,
  CoverageDeclared,
  CreateSessionInput,
  SegmentUpload,
  Session,
  SessionDetail,
  SessionGap,
  SessionJob,
  SessionLanguage,
  SessionSegment,
  SessionSource,
  SessionStatus,
  SessionTurn
} from './session-api/session'
export type {
  PreparationCitation,
  PreparationContent,
  PreparationSource,
  SessionPreparation,
  SessionSummary,
  StoredActionCandidate,
  SummaryActionCandidate,
  SummaryCitation,
  SummaryContent,
  SummaryCoverage,
  SummaryItem
} from './session-api/summary'
export type { SearchResponse, SearchResult } from './session-api/search'
export type { QaAnswer, QaCitation, QaEvidence, QaResponse } from './session-api/qa'
export type {
  MemoryEvidenceState,
  MemoryItem,
  MemoryKind,
  MemoryList,
  MemoryQuery,
  MemoryResponse,
  MemoryStatus,
  ProposeMemoryInput,
  SupersedeMemoryInput,
  SupersedeMemoryResponse
} from './session-api/memory'
