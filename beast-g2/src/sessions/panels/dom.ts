/** Small DOM helpers shared by the sessions section and its panels. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

export function button(label: string, className = '', type: 'button' | 'submit' = 'button'): HTMLButtonElement {
  const element = el('button', className, label)
  element.type = type
  return element
}
