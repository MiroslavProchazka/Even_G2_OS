export const SAMPLE_RATE = 16000
export const MAX_PCM_BYTES = SAMPLE_RATE * 2 * 30
export class PcmBuffer {
  private chunks: Uint8Array[] = []
  bytes = 0
  add(chunk: Uint8Array) {
    const remaining = MAX_PCM_BYTES - this.bytes
    const take = Math.min(remaining, chunk.byteLength)
    if (take > 0) {
      this.chunks.push(chunk.slice(0, take))
      this.bytes += take
    }
    return this.bytes >= MAX_PCM_BYTES
  }
  clear() {
    this.chunks = []
    this.bytes = 0
  }
  wav(): Uint8Array<ArrayBuffer> {
    const size = this.bytes - (this.bytes % 2)
    const bytes = new Uint8Array(44 + size),
      view = new DataView(bytes.buffer)
    const ascii = (offset: number, text: string) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)))
    ascii(0, 'RIFF')
    view.setUint32(4, 36 + size, true)
    ascii(8, 'WAVE')
    ascii(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, SAMPLE_RATE, true)
    view.setUint32(28, SAMPLE_RATE * 2, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    ascii(36, 'data')
    view.setUint32(40, size, true)
    let offset = 44
    for (const chunk of this.chunks) {
      const n = Math.min(chunk.length, bytes.length - offset)
      bytes.set(chunk.subarray(0, n), offset)
      offset += n
    }
    return bytes
  }
}
