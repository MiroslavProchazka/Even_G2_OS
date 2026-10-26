import { createGateway, loadConfig } from './gateway.mjs'
import { createSessions } from './sessions/index.mjs'
const demo = process.argv.includes('--demo')
const config = loadConfig(demo ? { ...process.env, DEMO_MODE: '1' } : process.env)
const host = process.env.HOST || '127.0.0.1',
  port = Number(process.env.PORT || 8787)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT: use an integer between 1 and 65535.')
if (demo && !['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Demo binds to loopback only. Configure a live gateway for phone access.')
if (!config.demo && !['127.0.0.1', 'localhost', '::1'].includes(host)) console.warn(`Gateway is bound to ${host} over plain HTTP. Put it behind a TLS tunnel before sending real tokens.`)
const log = (entry) => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }))
const sessions = createSessions({ config, logger: log })
const server = createGateway({ ...config, sessions: sessions.service, log })
server.on('close', () => sessions.db.close())
server.listen(port, host, () => {
  sessions.worker.start()
  try {
    const pruned = sessions.service.prune()
    if (pruned.audio || pruned.sessions) log({ event: 'sessions.pruned', ...pruned })
  } catch (error) {
    log({ event: 'sessions.prune_failed', error: error.message })
  }
  console.log(`Beast G2 gateway: http://${host}:${port} (${config.demo ? 'DEMO — no provider requests' : 'live — provider compatibility unverified until tested'})`)
  console.log(`Stored sessions: ${config.databasePath}`)
})
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, async () => {
    await sessions.worker.stop()
    server.close()
    server.closeAllConnections()
  })
