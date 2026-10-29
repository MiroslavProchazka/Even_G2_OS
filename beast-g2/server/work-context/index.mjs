import path from 'node:path'
import { CredentialStore } from '../integrations/notion/credentials.mjs'
import { NotionConnection } from '../integrations/notion/connection.mjs'
import { WorkContextService } from './service.mjs'

export function createWorkContext(config, env = process.env) {
  if (env.WORK_CONTEXT_ENABLED !== '1') return undefined
  if (config.demo) throw new Error('Work context requires live gateway mode; demo must never contact providers.')
  const store = new CredentialStore(path.join(config.dataDir, 'notion-credentials.enc'), env.NOTION_TOKEN_ENCRYPTION_KEY || '')
  const connection = new NotionConnection({ store, redirectUri: env.NOTION_REDIRECT_URI, workspaceId: env.NOTION_WORKSPACE_ID || '' })
  return new WorkContextService({ connection, config })
}
