import type { SessionsDeps } from '../../sessions'
import { newSessionPanel } from './new-session'

/**
 * A sessions panel owns one block of the sessions section. It receives the element it may fill and the deps that
 * `initSessions` was given, including the host handle that creates sessions and gates controls.
 */
export type SessionPanel = { id: string; mount(section: HTMLElement, deps: SessionsDeps): void }

const panels: SessionPanel[] = []

/**
 * Adds a panel to the sessions section. Registering the same id again replaces the earlier panel, so a reload or a test
 * cannot mount the same panel twice. Panels mount in registration order.
 */
export function registerSessionPanel(panel: SessionPanel): void {
  const index = panels.findIndex((existing) => existing.id === panel.id)
  if (index === -1) panels.push(panel)
  else panels[index] = panel
}

/** Mounts every registered panel. `initSessions` calls this once with the panel container it built. */
export function mountSessionPanels(section: HTMLElement, deps: SessionsDeps): void {
  for (const panel of panels) panel.mount(section, deps)
}

registerSessionPanel(newSessionPanel)
