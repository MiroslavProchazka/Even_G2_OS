/** Bound caller waiting without cancelling or releasing the underlying native operation. */
export function deadline<T>(operation: Promise<T>, ms = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new DOMException('G2 operation timed out. Microphone state may be unknown; retry pause after connection recovers.', 'TimeoutError')), ms)
    operation.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}
