import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Hashes every file under `directory` recursively, including the relative path, so a new domain directory or a moved file
 * changes the build id instead of breaking the pack. `extra` is appended for manifest and build inputs.
 */
export function sourceFingerprint(directory, extra = '') {
  const hash = createHash('sha256')
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const file = path.join(current, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (entry.isFile()) hash.update(path.relative(directory, file)).update(readFileSync(file))
    }
  }
  walk(directory)
  hash.update(extra)
  return hash.digest('hex').slice(0, 16)
}
