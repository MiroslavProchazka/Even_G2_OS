export const WAV_HEADER_BYTES = 44
export const SAMPLE_RATE = 16000
export const BYTES_PER_MS = 32

export class WavError extends Error {
  constructor(message) {
    super(message)
    this.name = 'WavError'
  }
}

export function parseWavHeader(header, { maxBytes = 134217728, maxDurationMs = 3600000 } = {}) {
  if (header.length < WAV_HEADER_BYTES) throw new WavError('Audio is too short.')
  if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') throw new WavError('Expected a RIFF/WAVE container.')
  if (header.toString('ascii', 12, 16) !== 'fmt ' || header.readUInt32LE(16) !== 16) throw new WavError('Expected a PCM fmt chunk.')
  if (header.readUInt16LE(20) !== 1 || header.readUInt16LE(22) !== 1) throw new WavError('Expected mono PCM.')
  if (header.readUInt32LE(24) !== SAMPLE_RATE || header.readUInt32LE(28) !== SAMPLE_RATE * 2) throw new WavError('Expected 16 kHz sample rate.')
  if (header.readUInt16LE(32) !== 2 || header.readUInt16LE(34) !== 16) throw new WavError('Expected 16-bit samples.')
  if (header.toString('ascii', 36, 40) !== 'data') throw new WavError('Expected one data chunk.')
  const dataBytes = header.readUInt32LE(40)
  if (header.readUInt32LE(4) !== 36 + dataBytes) throw new WavError('RIFF size does not match the declared audio length.')
  if (dataBytes <= 0) throw new WavError('Audio contains no samples.')
  if (dataBytes % 2) throw new WavError('PCM16 data must have an even length.')
  if (dataBytes > maxBytes) throw new WavError('Audio exceeds the configured size limit.')
  const durationMs = dataBytes / BYTES_PER_MS
  if (durationMs > maxDurationMs) throw new WavError('Audio exceeds the configured duration limit.')
  return { dataBytes, durationMs }
}

export function validateWavBuffer(buffer, limits = {}) {
  const info = parseWavHeader(buffer, limits)
  if (buffer.length !== WAV_HEADER_BYTES + info.dataBytes) throw new WavError('Audio length does not match the declared data chunk.')
  return info
}

export function makeWavHeader(dataBytes) {
  const header = Buffer.alloc(WAV_HEADER_BYTES)
  header.write('RIFF')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataBytes, 40)
  return header
}

export function makeWav(durationMs, fill = 0) {
  const dataBytes = Math.round(durationMs * BYTES_PER_MS)
  return Buffer.concat([makeWavHeader(dataBytes), Buffer.alloc(dataBytes, fill)])
}

export class ByteReader {
  constructor(iterable) {
    this.iterator = iterable[Symbol.asyncIterator]()
    this.buffer = Buffer.alloc(0)
    this.done = false
  }

  async read(size) {
    while (this.buffer.length < size && !this.done) {
      const { value, done } = await this.iterator.next()
      if (done) {
        this.done = true
        break
      }
      const chunk = Buffer.from(value)
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    }
    const result = this.buffer.subarray(0, Math.min(size, this.buffer.length))
    this.buffer = this.buffer.subarray(result.length)
    return result
  }
}
