// Ordered route registry. The dispatcher calls the first module whose match(parts) accepts the path.
// A new feature adds routes/<domain>.mjs and appends it here; no other route file changes.
import * as memory from './memory.mjs'
import * as qa from './qa.mjs'
import * as search from './search.mjs'
import * as sessions from './sessions.mjs'
import * as summaries from './summaries.mjs'

// `search` comes first: routes/sessions.mjs treats parts[2] as a session id and would shadow /api/sessions/search.
// `memory` and `qa` follow it: routes/sessions.mjs treats parts[3] as an action, so /api/sessions/:id/memory and
// /api/sessions/:id/qa must win.
export const routes = [search, memory, qa, sessions, summaries]
