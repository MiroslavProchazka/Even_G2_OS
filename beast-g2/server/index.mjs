import { createGateway, loadConfig } from './gateway.mjs';
const demo = process.argv.includes('--demo');
const config = loadConfig(demo ? { ...process.env, DEMO_MODE: '1' } : process.env);
const host = process.env.HOST || '127.0.0.1', port = Number(process.env.PORT || 8787);
if (demo && !['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Demo binds to loopback only. Configure a live gateway for phone access.');
const server = createGateway({ ...config, log: entry => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry })) });
server.listen(port, host, () => console.log(`Beast G2 gateway: http://${host}:${port} (${config.demo ? 'DEMO — no provider requests' : 'live — provider compatibility unverified until tested'})`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(); server.closeAllConnections(); });
