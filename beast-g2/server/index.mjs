import { createGateway, loadConfig } from './gateway.mjs'
const demo = process.argv.includes('--demo')
const config = loadConfig(demo ? { ...process.env, DEMO_MODE: '1' } : process.env)
const host = process.env.HOST || '127.0.0.1',
  port = Number(process.env.PORT || 8787)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT: use an integer between 1 and 65535.')
if (demo && !['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Demo binds to loopback only. Configure a live gateway for phone access.')
if (!config.demo && !['127.0.0.1', 'localhost', '::1'].includes(host)) console.warn(`Gateway is bound to ${host} over plain HTTP. Put it behind a TLS tunnel before sending real tokens.`)
const server = createGateway({ ...config, log: (entry) => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry })) })
server.listen(port, host, () => console.log(`Beast G2 gateway: http://${host}:${port} (${config.demo ? 'DEMO — no provider requests' : 'live — provider compatibility unverified until tested'})`))
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    server.close()
    server.closeAllConnections()
  })
