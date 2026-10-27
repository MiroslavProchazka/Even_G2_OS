import { deadline } from './deadline'
import { diagnostics } from './diagnostics'
import { waitForEvenAppBridge, AudioInputSource, CreateStartUpPageContainer, TextContainerProperty, TextContainerUpgrade, OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'
export type Gesture = 'tap' | 'exit' | 'previous' | 'next' | 'interrupt' | 'resume'
export function gesture(event: EvenHubEvent): Gesture | undefined {
  const sysEvent = event.sysEvent
  const sys = sysEvent?.eventType
  if (sys === OsEventTypeList.SYSTEM_EXIT_EVENT || sys === OsEventTypeList.ABNORMAL_EXIT_EVENT || sys === OsEventTypeList.FOREGROUND_EXIT_EVENT) return 'interrupt'
  if (sys === OsEventTypeList.FOREGROUND_ENTER_EVENT) return 'resume'
  // A touch from the glasses or the ring arrives as a sysEvent that names only its source, because protobuf omits the zero
  // CLICK_EVENT. Without this fallback every tap on the glasses is dropped.
  const source = sysEvent?.eventSource
  const sysType = sys ?? (source ? OsEventTypeList.CLICK_EVENT : undefined)
  // Only existing text/list envelopes may normalize omitted protobuf zero into a tap.
  const input = event.textEvent ?? event.listEvent
  const type = input ? (input.eventType ?? 0) : sysType
  if (type === 0) return 'tap'
  if (type === 3) return 'exit'
  if (type === 1) return 'previous'
  if (type === 2) return 'next'
}
export async function connectEven(initial: string, onGesture: (gesture: Gesture) => void, onPcm: (pcm: Uint8Array) => void) {
  return attachEven(await waitForEvenAppBridge(), initial, onGesture, onPcm)
}
export async function attachEven(bridge: Awaited<ReturnType<typeof waitForEvenAppBridge>>, initial: string, onGesture: (gesture: Gesture) => void, onPcm: (pcm: Uint8Array) => void, timeoutMs = 8000) {
  const rendered = new Map<number, string>()
  let disposed = false
  let poisoned = false
  let capture = false,
    operations = Promise.resolve()
  const unresponsive = () => new Error('G2 session is unresponsive. Reopen the plugin to reconnect.')
  const serialize = (operation: () => Promise<void>) => {
    if (poisoned) return Promise.reject(unresponsive())
    const result = operations.then(operation)
    operations = result.catch(() => {})
    return deadline(result, timeoutMs).catch((error) => {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        poisoned = true
        diagnostics.record('sdk', 'session.unresponsive', { phase: 'unknown' }, 'error')
      }
      throw error
    })
  }
  const unsubscribe = bridge.onEvenHubEvent((event) => {
    if (disposed) return
    if (capture && event.audioEvent?.source === AudioInputSource.Glasses) onPcm(event.audioEvent.audioPcm)
    const action = gesture(event)
    if (action) onGesture(action)
  })
  try {
    const result = await bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({
        containerTotalNum: 3,
        textObject: [
          new TextContainerProperty({ xPosition: 8, yPosition: 0, width: 340, height: 28, containerID: 2, containerName: 'status', content: '? NET --M IDLE', isEventCapture: 0 }),
          new TextContainerProperty({ xPosition: 350, yPosition: 0, width: 218, height: 28, containerID: 3, containerName: 'battery', content: 'G-- P--', isEventCapture: 0 }),
          new TextContainerProperty({ xPosition: 16, yPosition: 32, width: 544, height: 248, paddingLength: 8, containerID: 1, containerName: 'beast', content: initial, isEventCapture: 1 })
        ]
      })
    )
    if (result !== 0) throw new Error(`G2 page creation failed (${result}).`)
  } catch (error) {
    unsubscribe()
    throw error
  }
  return {
    watchStatus: (changed: (status: { battery?: number; connected?: boolean }) => void) => {
      let alive = true,
        sn: string | undefined,
        revision = 0
      const update = (status: { batteryLevel?: number; connectType?: string }) =>
        changed({ battery: status.batteryLevel, connected: status.connectType === 'connected' ? true : status.connectType && status.connectType !== 'none' ? false : undefined })
      const unsubscribeStatus = bridge.onDeviceStatusChanged((status) => {
        if (alive && sn && status.sn === sn) {
          revision++
          update(status)
        }
      })
      const poll = async () => {
        const before = revision
        try {
          const info = await deadline(bridge.getDeviceInfo(), timeoutMs)
          if (alive && info?.isGlasses()) {
            sn = info.sn
            if (before === revision) update(info.status)
          }
        } catch {
          if (alive) changed({})
        }
      }
      void poll()
      const timer = setInterval(() => {
        void poll()
      }, 30000)
      return () => {
        alive = false
        clearInterval(timer)
        unsubscribeStatus()
      }
    },
    audio: {
      start: () =>
        serialize(async () => {
          if (disposed) throw new Error('G2 session disposed.')
          capture = true
          try {
            if (!(await bridge.audioControl(true, AudioInputSource.Glasses))) throw new Error('G2 microphone unavailable. Check permission and connection.')
          } catch (error) {
            if (poisoned || (error instanceof DOMException && error.name === 'TimeoutError')) {
              capture = true
              throw error
            }
            try {
              if (await bridge.audioControl(false)) capture = false
            } catch {
              /* Leave capture set so the controller retries shutdown. */
            }
            throw error
          }
        }),
      stop: () =>
        serialize(async () => {
          if (!capture) return
          if (!(await bridge.audioControl(false))) throw new Error('G2 microphone stop was rejected.')
          capture = false
        })
    },
    async write(content: string, left = '', right = '') {
      if (disposed) return
      if (poisoned) throw unresponsive()
      for (const [containerID, containerName, text] of [
        [2, 'status', left],
        [3, 'battery', right],
        [1, 'beast', content]
      ] as const) {
        if (rendered.get(containerID) === text) continue
        if (!(await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID, containerName, content: text })))) throw new Error('G2 text update rejected.')
        rendered.set(containerID, text)
      }
    },
    exit: async () => {
      if (poisoned) throw unresponsive()
      if (!(await deadline(bridge.shutDownPageContainer(1), timeoutMs))) throw new Error('G2 exit rejected.')
    },
    dispose: () => {
      disposed = true
      unsubscribe()
      void serialize(async () => {
        if (capture) {
          if (!(await bridge.audioControl(false))) throw new Error('Microphone shutdown rejected.')
          capture = false
        }
      }).catch(() => diagnostics.record('sdk', 'dispose.stop_failed', { phase: 'unknown' }, 'error'))
    }
  }
}
