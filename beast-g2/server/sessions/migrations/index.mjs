// Ordered migration registry. Versions must stay in ascending order.
// A new feature adds migrations/<version>-<name>.mjs and appends it here; db.mjs does not change.
import * as initial from './001-initial.mjs'
import * as summaries from './002-summaries.mjs'
import * as search from './003-search.mjs'

export const migrations = [
  { version: initial.version, sql: initial.sql },
  { version: summaries.version, sql: summaries.sql },
  { version: search.version, sql: search.sql }
]
