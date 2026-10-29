import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'

export class CredentialStore {
  constructor(file, key) {
    if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('NOTION_TOKEN_ENCRYPTION_KEY must be 64 hexadecimal characters.')
    this.file = file
    this.key = Buffer.from(key, 'hex')
  }
  read() {
    let value
    try {
      value = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw new Error('Cannot read encrypted Notion credentials.')
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(value.iv, 'hex'))
    decipher.setAuthTag(Buffer.from(value.tag, 'hex'))
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data, 'hex')), decipher.final()]).toString('utf8'))
  }
  write(value) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${randomBytes(8).toString('hex')}.tmp`
    writeFileSync(temporary, JSON.stringify({ iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('hex') }), { mode: 0o600, flag: 'wx' })
    renameSync(temporary, this.file)
  }
  clear() {
    rmSync(this.file, { force: true })
  }
}
