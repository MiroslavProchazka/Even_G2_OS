// Ordered route registry. The dispatcher calls the first module whose match(parts) accepts the path.
// A new feature adds routes/<domain>.mjs and appends it here; no other route file changes.
import * as sessions from './sessions.mjs'
import * as summaries from './summaries.mjs'

export const routes = [sessions, summaries]
