import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StatusMonitor, percent } from '../src/status'
import { Diagnostics } from '../src/diagnostics'
import { attachEven, gesture } from '../src/even'
test('status distinguishes unavailable, stale, offline and failed API; zero battery is valid', () => {
  assert.equal(percent(0), '0%'); assert.equal(percent(NaN), '--'); assert.equal(percent(101), '--')
  const status = new StatusMonitor(), log = new Diagnostics()
  assert.match(status.header(false).left, /\? NET/); assert.equal(status.header(false).right, 'G-- P--')
  log.span('health').end(); status.consume(log.snapshot()); assert.match(status.header(true).left, /\+ API.*RUN/)
  log.span('chat').end('error', { code: 'network' }); status.consume(log.snapshot()); assert.match(status.header(true).left, /! API/)
  log.span('stt').end(); status.consume(log.snapshot()); assert.match(status.header(true).left, /~ API/)
  assert.match(status.header(false, Date.now() + 61000).left, /\? NET/)
  status.online = false; assert.match(status.header(false).left, /x OFF/)
})
test('double tap invokes exit gesture and native exit dialog, with errors surfaced', async () => {
  assert.equal(gesture({ textEvent: { eventType: 3 } } as any), 'exit')
  let mode: number | undefined, ok = true, layout: any
  const connection = await attachEven({ onEvenHubEvent() { return () => {} }, async createStartUpPageContainer(value: any) { layout = value; return 0 }, async shutDownPageContainer(value: number) { mode = value; return ok } } as any, '', () => {}, () => {})
  assert.equal(layout.containerTotalNum, 3)
  assert.equal(layout.textObject.filter((x: any) => x.isEventCapture === 1).length, 1)
  await connection.exit(); assert.equal(mode, 1)
  ok = false; await assert.rejects(connection.exit(), /rejected/); connection.dispose()
})
test('device battery ignores ring events and unsubscribes cleanly', async () => {
  let callback: any, removed = false, latest: any
  const connection = await attachEven({ onEvenHubEvent() { return () => {} }, async createStartUpPageContainer() { return 0 }, onDeviceStatusChanged(cb: any) { callback = cb; return () => { removed = true } }, async getDeviceInfo() { return { sn: 'glasses', isGlasses: () => true, status: { batteryLevel: 75, connectType: 'connected' } } } } as any, '', () => {}, () => {})
  const stop = connection.watchStatus(value => { latest = value })
  await new Promise(resolve => setImmediate(resolve)); assert.equal(latest.battery, 75)
  callback({ sn: 'ring', batteryLevel: 1 }); assert.equal(latest.battery, 75)
  callback({ sn: 'glasses', batteryLevel: 74, connectType: 'connected' }); assert.equal(latest.battery, 74)
  stop(); assert.equal(removed, true); connection.dispose()
})
