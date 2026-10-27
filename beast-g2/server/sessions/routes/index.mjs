// Ordered route registry. The dispatcher calls the first module whose match(parts) accepts the path.
// A new feature adds routes/<domain>.mjs and appends it here; no other route file changes.
import * as search from './search.mjs'
import * as sessions from './sessions.mjs'
import * as summaries from './summaries.mjs'

// `search` comes first: routes/sessions.mjs treats parts[2] as a session id and would shadow /api/sessions/search.
export const routes = [search, sessions, summaries]
