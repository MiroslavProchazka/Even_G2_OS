import { StatusMonitor } from './status'
import { diagnostics, errorCode } from './diagnostics'
import './style.css'
import { BeastClient, beastUrl } from './beast'
import { gatewayUrl, GatewayClient, type Settings } from './api'
import { AssistantController, type AudioPort } from './controller'
import { hud, continuousHud, LatestDisplay } from './display'
import { ContinuousController } from './continuous'
import { createContinuousDemo, simulateUtterance } from './continuous-demo'
import { connectEven } from './even'

const root = document.querySelector<HTMLDivElement>('#app')!
root.innerHTML = `<header><span>BEAST / G2</span><span class="tag">DEVICE TEST · 0.5.0</span></header>
<main><section><p class="eyebrow">YOUR VOICE. YOUR BEAST.</p><h1>A question away.</h1><p>Ask from your glasses. Read the answer in your eyeline.</p>
<div class="lens"><div class="lens-status"><span id="status-left"></span><span id="status-right"></span></div><pre id="hud" aria-live="polite"></pre></div><button id="retry-display" class="secondary">Retry display</button><p id="bridge" role="status">Connecting to Even G2…</p>
<div class="actions"><button id="record">Start question</button><button id="cancel" class="secondary">Cancel</button><button id="previous" aria-label="Previous answer page" class="secondary">↑</button><button id="next" aria-label="Next answer page" class="secondary">↓</button></div>
<p class="hint">G2: tap to record, tap again to send · double tap to exit · swipe to read</p>
<section aria-label="Listening mode"><label for="mode">Listening mode</label><select id="mode"><option value="manual">Manual · tap to ask</option><option value="continuous">Continuous G2 · live transcript + hints</option><option value="simulation">Continuous demo · synthetic PCM, no microphone</option></select><label for="speech-threshold">Speech sensitivity</label><select id="speech-threshold"><option value="300">Quiet speech</option><option value="600" selected>Normal</option><option value="1000">Noisy room</option></select><div class="actions"><button id="listen">Resume listening</button><button id="pause" class="secondary">Pause listening</button><button id="inject" class="secondary">Simulate speech segment</button></div><p id="listening" role="status"></p><p class="hint">Live transcript appears while speaking. After 2 seconds of silence, the final transcript goes to Beast. Hints appear automatically for 10 seconds each, then disappear. Keep each utterance under 30 seconds. Tap pauses/resumes; double tap exits.</p></section><form id="ask"><label for="question">Text question · also works without glasses</label><div class="row"><input id="question" maxlength="4000" placeholder="Co umí Beast G2?" required><button>Ask Beast</button></div></form>
<section><h2>Continuous conversation setup</h2><label for="conversation-mode">Reply style</label><select id="conversation-mode"><option value="direct">Answer every utterance</option><option value="context">Contextual cues · experimental</option></select><label for="prep-notes">Prep notes · people, topic, goal</label><textarea id="prep-notes" maxlength="1500" placeholder="Who am I meeting? What do we need to decide? Relevant names and facts."></textarea><label><input id="web-enabled" type="checkbox"> Enable web commands (custom gateway only)</label><p>Say “vyhledej …” or “search …”. Only that query goes to Brave Search, without prep notes or conversation history. Requires a configured gateway; direct Beast cannot search.</p><button id="apply-conversation" class="secondary">Apply conversation setup</button><p id="conversation-status">Session only. Apply while paused; changing setup resets model context.</p></section>
<section><h2>Continuous hint history</h2><p>Last 20 completed answers in this session. Survives hint expiry and pause; closing/reloading clears it. Demo history is separate.</p><button id="export-history" class="secondary">Export conversation JSON</button><button id="clear-history" class="secondary">Delete hint history</button><div id="hint-history"></div><textarea id="history-json" hidden readonly aria-label="Conversation export"></textarea></section>
<div class="detail"><h2>Transcript</h2><p id="transcript">Your spoken question will appear here.</p><h2>Answer</h2><p id="answer">Waiting for your first question.</p><p id="error" role="alert"></p></div></section>
<aside><h2>Connection</h2><p>Direct Beast requires the company VPN on this phone. Keep Tailscale or WireGuard connected. Credentials stay in memory for this session.</p><form id="settings"><label for="transport">API connection</label><select id="transport"><option value="direct">Direct Beast API</option><option value="gateway">Custom gateway</option></select><label for="gateway">API base URL / gateway origin</label><input id="gateway" type="url" required placeholder="https://your-gateway.example.com"><label for="token">API key / gateway token</label><input id="token" type="password" autocomplete="off" required placeholder="Kept in memory for this session"><label for="chat-model">Chat model</label><input id="chat-model" value="beast/big" required><label for="stt-model">Speech model</label><input id="stt-model" value="whisper-live" required><label for="stt-prompt">Names / vocabulary (direct Beast only, optional)</label><input id="stt-prompt" maxlength="300" placeholder="Beast, Slush, names and technical terms"><label for="language">Speech language</label><select id="language"><option value="cs">Čeština</option><option value="en">English</option><option value="auto">Automatic</option></select><button>Apply connection</button></form><div class="actions"><button id="health" class="secondary">Test connection</button><button id="demo" class="secondary">Use local demo</button></div><p id="connection" role="status">Not tested</p><button id="clear" class="secondary">Clear conversation context</button><button id="exit" class="secondary">Exit on glasses</button><p class="hint">Demo uses a loopback gateway and simulated answers. It makes no Beast requests. Real G2 audio and Beast compatibility still require device testing.</p></aside></main>`
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const transport = element<HTMLSelectElement>('transport'), chatModel = element<HTMLInputElement>('chat-model'), sttModel = element<HTMLInputElement>('stt-model')
const gateway = element<HTMLInputElement>('gateway'), token = element<HTMLInputElement>('token'), language = element<HTMLSelectElement>('language')
let preferences: Partial<Settings> = {}
try { preferences = JSON.parse(localStorage.getItem('beast-g2-settings') || '{}') } catch { /* First run or unavailable storage. */ }
gateway.value = typeof preferences.gateway === 'string' ? preferences.gateway : (import.meta.env.VITE_BEAST_URL || 'https://beast.example.com/v1')
transport.value = preferences.transport === 'gateway' ? 'gateway' : 'direct'
chatModel.value = preferences.chatModel || 'beast/big'; sttModel.value = preferences.sttModel || 'whisper-live'
element<HTMLInputElement>('stt-prompt').value = preferences.sttPrompt || ''
language.value = ['cs', 'en', 'auto'].includes(preferences.language || '') ? preferences.language! : 'cs'
let settings: Settings = { gateway: gateway.value, token: '', language: language.value as Settings['language'], transport: transport.value as Settings['transport'], chatModel: chatModel.value.trim(), sttModel: sttModel.value.trim(), sttPrompt: element<HTMLInputElement>('stt-prompt').value.trim().slice(0,300) }
const gatewayApi = new GatewayClient(() => settings), beastApi = new BeastClient(() => settings)
const currentApi = () => settings.transport === 'direct' ? beastApi : gatewayApi
const api = { health: () => currentApi().health(), transcribe: (...args: Parameters<GatewayClient['transcribe']>) => currentApi().transcribe(...args), chat: (...args: Parameters<GatewayClient['chat']>) => currentApi().chat(...args) }
let port: AudioPort = { async start() { throw new Error('G2 microphone not connected. Use a text question to test the gateway.') }, async stop() {} }
const measuredAudio: AudioPort = {
  async start() { const trace = diagnostics.span('mic'); try { await port.start(); trace.end('info', { phase: 'on' }) } catch (error) { trace.end('error', { code: errorCode(error) }); throw error } },
  async stop() { const trace = diagnostics.span('mic'); try { await port.stop(); trace.end('info', { phase: 'off' }) } catch (error) { trace.end('error', { phase: 'unknown' }); throw error } }
}
let display: LatestDisplay | undefined, page = 0
let pageClosed = false
let even: Awaited<ReturnType<typeof connectEven>> | undefined
let mode: 'manual' | 'continuous' | 'simulation' = 'manual'
let switchingMode = false
const continuous = new ContinuousController(measuredAudio, api, paint, { requireDisplayAck: true })
const simulation = createContinuousDemo(paint)
const activeContinuous = () => mode === 'simulation' ? simulation : continuous
const controller = new AssistantController(measuredAudio, api, paint)
const statusMonitor = new StatusMonitor()
let stopDeviceStatus: (() => void) | undefined
let historyRevision = ''
let lastDiagnosticState = ''
function paint() {
  const state = mode === 'manual' ? controller.state : activeContinuous().viewState(), view = hud(state, page); page = Math.min(page, view.count - 1)
  const listening = activeContinuous().state
  const status = mode === 'manual' ? 'Manual mode · microphone starts on tap.' : `${mode === 'simulation' ? 'SIMULATED MIC' : 'G2 MIC'}: ${listening.microphone.toUpperCase()} · ${listening.phase} · queue ${listening.queued}/2 · dropped ${listening.dropped} · skipped ${listening.ignored} · unread ${listening.unread}/3 · replies dropped ${listening.repliesDropped}. ${listening.notice}`
  const diagnosticState = `${mode}:${state.phase}:${listening.phase}:${listening.microphone}:${listening.queued}:${listening.dropped}:${listening.ignored}:${Boolean(state.error)}`
  if (diagnosticState !== lastDiagnosticState) { lastDiagnosticState = diagnosticState; diagnostics.record(mode === 'manual' ? 'app' : 'continuous', 'state.changed', { phase: mode === 'manual' ? state.phase : listening.phase, queued: listening.queued, dropped: listening.dropped, ignored: listening.ignored }, state.error ? 'error' : 'info') }
  element('listening').textContent = status
  const displayText = mode === 'manual' ? view.text : continuousHud(listening)
  element('previous').hidden = element('next').hidden = mode !== 'manual'
  const header = statusMonitor.header(mode === 'manual' ? ['starting','recording','transcribing','answering'].includes(state.phase) : listening.microphone === 'on')
  element('status-left').textContent = header.left; element('status-right').textContent = header.right
  element('hud').textContent = displayText; display?.update(JSON.stringify({ content: displayText, ...header, mode, hintId: mode !== 'manual' ? listening.reply?.id : undefined }))
  element('transcript').textContent = state.transcript || 'Your spoken question will appear here.'
  element('answer').textContent = state.answer || 'Waiting for your first question.'
  element('error').textContent = state.error
  renderHistory()
  const busy = switchingMode || (mode === 'manual' ? ['starting', 'recording', 'transcribing', 'answering'].includes(state.phase) : !['paused', 'interrupted', 'error'].includes(listening.phase) || listening.microphone !== 'off')
  for (const id of ['conversation-mode','prep-notes','web-enabled','apply-conversation']) (element(id) as HTMLInputElement).disabled = busy
  element<HTMLSelectElement>('speech-threshold').disabled = busy
  element<HTMLButtonElement>('listen').disabled = mode === 'manual' || busy
  element<HTMLButtonElement>('pause').disabled = mode === 'manual' || switchingMode
  element<HTMLButtonElement>('inject').disabled = mode !== 'simulation' || listening.microphone !== 'on'
  element<HTMLButtonElement>('record').textContent = state.phase === 'recording' ? `Send question · ${state.seconds}s` : 'Start question'
  element<HTMLButtonElement>('record').disabled = mode !== 'manual' || switchingMode || ['starting', 'transcribing', 'answering'].includes(state.phase)
  element<HTMLButtonElement>('health').disabled = busy
  for (const control of element<HTMLFormElement>('settings').querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button')) control.disabled = busy
  element<HTMLButtonElement>('demo').disabled = busy
  element<HTMLInputElement>('question').disabled = busy || mode !== 'manual'
  element<HTMLSelectElement>('mode').disabled = switchingMode
}
function apply() {
  if (transport.value === 'direct') beastUrl(gateway.value.trim(), 'models'); else gatewayUrl(gateway.value.trim(), '/api/health')
  settings = { gateway: gateway.value.trim(), token: token.value.trim(), language: language.value as Settings['language'], transport: transport.value as Settings['transport'], chatModel: chatModel.value.trim(), sttModel: sttModel.value.trim(), sttPrompt: element<HTMLInputElement>('stt-prompt').value.trim().slice(0,300) }
  try { localStorage.setItem('beast-g2-settings', JSON.stringify({ gateway: settings.gateway, language: settings.language, transport: settings.transport, chatModel: settings.chatModel, sttModel: settings.sttModel, sttPrompt: settings.sttPrompt })) } catch { /* Optional preferences only. */ }
  element('connection').textContent = 'Connection applied. Test it before recording.'
}
element('settings').addEventListener('submit', event => { event.preventDefault(); try { apply() } catch (error) { element('connection').textContent = String(error) } })
element('demo').addEventListener('click', () => { transport.value = 'gateway'; gateway.value = 'http://127.0.0.1:8787'; token.value = 'local-demo-token-only'; apply(); element('connection').textContent = 'Run npm run gateway:demo on this computer, then test. Demo answers are simulated.' })
element('health').addEventListener('click', async () => {
  if (['starting', 'recording', 'transcribing', 'answering'].includes(controller.state.phase)) return
  element('connection').textContent = 'Testing gateway…'
  try { apply(); const result = await api.health(); element('connection').textContent = `${result.mode.toUpperCase()} · chat: ${result.models.chat} · speech: ${result.models.stt}. ${result.mode !== 'demo' ? 'Gateway reachable; provider inference still needs a real question.' : 'Simulated answers only.'}` }
  catch (error) { element('connection').textContent = String(error) }
})
element('retry-display').addEventListener('click', () => { if (!display?.retry()) element('bridge').textContent = 'Display unavailable or timed out. Reopen the plugin to reconnect.' })
element('record').addEventListener('click', () => { page = 0; void controller.tap() })
const pauseAll = async (interrupted = false) => { await Promise.all([controller.cancel(interrupted), continuous.pause(interrupted), simulation.pause(interrupted)]) }
element('cancel').addEventListener('click', () => { void pauseAll() })
element('mode').addEventListener('change', async () => {
  switchingMode = true; paint()
  await pauseAll()
  if (continuous.state.microphone !== 'off') { element<HTMLSelectElement>('mode').value = mode; switchingMode = false; paint(); return }
  mode = element<HTMLSelectElement>('mode').value as typeof mode; page = 0; switchingMode = false; paint()
})
function renderHistory() {
  const archive = activeContinuous().archive, revision = `${mode}:${archive.revision}`
  if (historyRevision === revision) return
  historyRevision = revision
  const list = element('hint-history'); list.replaceChildren()
  for (const row of archive.snapshot().reverse()) {
    const item = document.createElement('details'), summary = document.createElement('summary'), text = document.createElement('p')
    summary.textContent = `${new Date(row.at).toLocaleTimeString()} · ${row.transcript.slice(0,90)}`
    text.textContent = row.answer; item.append(summary, text)
    if (row.evidence) {
      const label = document.createElement('p'); label.textContent = `Web snippets retrieved ${row.evidence.retrievedAt}`; item.append(label)
      for (const source of row.evidence.sources) { const link = document.createElement('a'); link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = `[${source.id}] ${source.title}${source.published ? ' · ' + source.published : ''}`; const line = document.createElement('p'); line.append(link); item.append(line) }
    }
    list.append(item)
  }
}
element('apply-conversation').addEventListener('click', () => {
  const config = { mode: element<HTMLSelectElement>('conversation-mode').value as 'direct' | 'context', notes: element<HTMLTextAreaElement>('prep-notes').value.trim(), web: element<HTMLInputElement>('web-enabled').checked }
  if (config.web && (settings.transport !== 'gateway' || mode === 'simulation')) { element('conversation-status').textContent = 'Web commands require Custom gateway with search configured; simulation cannot search.'; return }
  const ok = continuous.configureConversation(config) && simulation.configureConversation(config)
  element('conversation-status').textContent = ok ? 'Applied for continuous mode. Notes stay in this session and go to the selected model with each final utterance.' : 'Pause listening before changing setup.'
})
element('clear-history').addEventListener('click', () => { activeContinuous().archive.clear(); element<HTMLTextAreaElement>('history-json').value = ''; element('history-json').hidden = true; renderHistory() })
element('export-history').addEventListener('click', () => {
  const value = activeContinuous().archive.export(), field = element<HTMLTextAreaElement>('history-json')
  field.value = value; field.hidden = false
  const url = URL.createObjectURL(new Blob([value], { type: 'application/json' })), link = document.createElement('a')
  link.href = url; link.download = 'beast-conversation.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000)
})
element('speech-threshold').addEventListener('change', () => { const threshold = Number(element<HTMLSelectElement>('speech-threshold').value); continuous.setSpeechThreshold(threshold); simulation.setSpeechThreshold(threshold) })
element('listen').addEventListener('click', () => { if (!switchingMode && mode !== 'manual') void activeContinuous().start() })
element('pause').addEventListener('click', () => { void activeContinuous().pause() })
element('inject').addEventListener('click', () => { if (mode === 'simulation') simulateUtterance(simulation) })
element('previous').addEventListener('click', () => { page = Math.max(0, page - 1); paint() })
element('next').addEventListener('click', () => { page++; paint() })
element('clear').addEventListener('click', () => { controller.clearHistory(); continuous.clearHistory(); simulation.clearHistory(); element('connection').textContent = 'Conversation context cleared.' })
let exiting = false
async function exitApp() {
  if (!even || exiting) return
  exiting = true
  try { await pauseAll(); await even.exit() }
  catch (error) { element('bridge').textContent = `Exit failed: ${String(error)}` }
  finally { exiting = false }
}
element('exit').addEventListener('click', () => { void exitApp() })
element('ask').addEventListener('submit', event => { event.preventDefault(); page = 0; if (mode === 'manual') void controller.ask(element<HTMLInputElement>('question').value) })
// A persisted page keeps its SDK subscription and display for bfcache restoration.
window.addEventListener('pagehide', event => { void pauseAll(true); if (!event.persisted) { pageClosed = true; stopDeviceStatus?.(); clearInterval(statusTimer); display?.dispose(); even?.dispose() } })
document.addEventListener('visibilitychange', () => { if (document.hidden) void pauseAll(true) })
let audioFrames = 0, audioBytes = 0, lastAudioLog = 0, audioEnergy = 0, audioSamples = 0, audioPeak = 0
diagnostics.record('sdk', 'bridge.waiting')
paint()
void connectEven(hud(controller.state, 0).text, action => {
  if (action === 'tap') { if (mode === 'manual') { page = 0; void controller.tap() } else if (activeContinuous().state.microphone === 'on') void activeContinuous().pause(); else void activeContinuous().start() }
  if (action === 'exit') void exitApp()
  if (action === 'interrupt') { void pauseAll(true); element('bridge').textContent = 'G2 session interrupted. Start a fresh recording after reconnecting.' }
  if (action === 'resume') { element('bridge').textContent = 'G2 resumed · tap to start a fresh question'; paint() }
  if (action === 'previous' && mode === 'manual') { page = Math.max(0, page - 1); paint() }
  if (action === 'next' && mode === 'manual') { page++; paint() }
}, pcm => { const samples = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength); for (let i = 0; i + 1 < pcm.byteLength; i += 2) { const value = samples.getInt16(i, true); audioEnergy += value * value; audioSamples++; audioPeak = Math.max(audioPeak, Math.abs(value)) } audioFrames++; audioBytes += pcm.byteLength; if (Date.now() - lastAudioLog >= 1000) { diagnostics.record('audio', 'pcm.received', { frames: audioFrames, bytes: audioBytes, rms: audioSamples ? Math.sqrt(audioEnergy / audioSamples) : 0, peak: audioPeak }); lastAudioLog = Date.now(); audioFrames = audioBytes = audioEnergy = audioSamples = audioPeak = 0 } if (mode === 'manual') controller.onPcm(pcm); else if (mode === 'continuous') continuous.onPcm(pcm) }).then(connected => {
  if (pageClosed) { connected.dispose(); return }
  even = connected; port = connected.audio; diagnostics.record('sdk', 'bridge.connected')
  display = new LatestDisplay(async text => { const trace = diagnostics.span('display', { chars: text.length }); try { const frame = JSON.parse(text); await connected.write(frame.content, frame.left, frame.right); trace.end() } catch (error) { trace.end('error'); throw error } }, error => { element('bridge').textContent = `Display error: ${String(error)} Reopen the plugin to reconnect the display.` }, 300, 8000, text => { const frame = JSON.parse(text); if (frame.mode === 'continuous' && mode === 'continuous' && frame.hintId !== undefined) continuous.acknowledgeHint(frame.hintId) })
  stopDeviceStatus = connected.watchStatus(status => { statusMonitor.glasses = status.battery; statusMonitor.connected = status.connected; paint() })
  element('bridge').textContent = 'Even bridge connected · microphone starts only on request'; paint()
}).catch(error => { diagnostics.record('sdk', 'bridge.failed', { code: errorCode(error) }, 'error'); element('bridge').textContent = `Browser preview · G2 unavailable: ${String(error)}` })

const panel = document.createElement('section')
panel.className = 'debug-panel'
panel.innerHTML = `<details><summary>Diagnostics · local metadata only</summary><p>No audio, transcript, answer, API key, URL or request headers are recorded. Network errors from a WebView may combine DNS, TLS and CORS failures; an export alone cannot separate them.</p><div class="actions"><button id="debug-export" class="secondary">Export diagnostic JSON</button><button id="debug-clear" class="secondary">Clear logs</button></div><p id="debug-count" role="status"></p><pre id="debug-events"></pre><textarea id="debug-json" hidden readonly aria-label="Diagnostic JSON fallback"></textarea></details>`
root.append(panel)
let debugTimer: ReturnType<typeof setTimeout> | undefined
function renderDiagnostics() {
  debugTimer = undefined
  const events = diagnostics.snapshot()
  element('debug-count').textContent = `${events.length}/400 events · in memory only`
  element('debug-events').textContent = events.slice(-30).map(e => `${e.at.slice(11,23)} ${e.level.toUpperCase()} ${e.stage} ${e.event} ${e.traceId || ''} ${JSON.stringify(e.details)}`).join('\n')
}
diagnostics.subscribe(() => { if (!debugTimer) debugTimer = setTimeout(renderDiagnostics, 500) })
element('debug-clear').addEventListener('click', () => diagnostics.clear())
element('debug-export').addEventListener('click', () => {
  const text = diagnostics.export(), fallback = element<HTMLTextAreaElement>('debug-json')
  fallback.hidden = false; fallback.value = text
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' })), link = document.createElement('a')
  link.href = url; link.download = `beast-g2-diagnostics-${Date.now()}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000)
})
window.addEventListener('error', () => diagnostics.record('app', 'runtime.error', { code: 'uncaught_error' }, 'error'))
window.addEventListener('unhandledrejection', () => diagnostics.record('app', 'runtime.rejection', { code: 'unhandled_rejection' }, 'error'))
document.addEventListener('visibilitychange', () => diagnostics.record('app', 'visibility.changed', { phase: document.hidden ? 'hidden' : 'visible' }))
diagnostics.record('app', 'session.started'); renderDiagnostics()

// Optional WebView capabilities: unavailable values stay unknown, never invented.
type Battery = EventTarget & { level: number }
const hostNavigator = navigator as Navigator & { getBattery?: () => Promise<Battery>; connection?: { downlink?: number } }
const refreshStatus = () => { statusMonitor.online = navigator.onLine; statusMonitor.downlink = hostNavigator.connection?.downlink; statusMonitor.consume(diagnostics.snapshot()); paint() }
const statusTimer = setInterval(refreshStatus, 5000)
window.addEventListener('online', refreshStatus); window.addEventListener('offline', refreshStatus)
void hostNavigator.getBattery?.().then(battery => {
  const changed = () => { if (!pageClosed) { statusMonitor.phone = battery.level * 100; paint() } }
  changed(); battery.addEventListener('levelchange', changed)
  window.addEventListener('pagehide', event => { if (!event.persisted) battery.removeEventListener('levelchange', changed) })
}).catch(() => { /* Unsupported or denied by host policy. */ })
refreshStatus()
