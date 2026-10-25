import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];

/**
 * Validate the parts of an Even Hub manifest that make a packaged app unusable.
 * Returns a list of human-readable errors; an empty list means the manifest is packable.
 */
export function checkManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') return ['manifest is not an object'];
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    errors.push(`version must be a semantic version, got ${JSON.stringify(manifest.version)}`);
  }
  if (manifest.entrypoint !== 'index.html') {
    errors.push(`entrypoint must be index.html, got ${JSON.stringify(manifest.entrypoint)}`);
  }
  const network = (manifest.permissions || []).find(permission => permission && permission.name === 'network');
  if (!network) return errors;
  const whitelist = network.whitelist;
  if (!Array.isArray(whitelist) || whitelist.length === 0) {
    errors.push('network permission needs a non-empty whitelist');
    return errors;
  }
  for (const entry of whitelist) {
    let url;
    try {
      url = new URL(entry);
    } catch {
      errors.push(`whitelist entry is not an absolute URL: ${JSON.stringify(entry)}`);
      continue;
    }
    if (url.protocol !== 'https:') {
      errors.push(`whitelist entry must use https: ${entry}`);
    }
    if (url.username || url.password) {
      errors.push(`whitelist entry must not embed credentials: ${url.origin}`);
    }
    if (url.search || url.hash) {
      errors.push(`whitelist entry must not carry a query or fragment: ${url.origin}`);
    }
    if (RESERVED_DOMAINS.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
      errors.push(`whitelist entry is a reserved example host, replace it with your real origin: ${entry}`);
    }
  }
  return errors;
}

function main(argv) {
  const file = argv[0];
  if (!file) {
    console.error('usage: node scripts/check-manifest.mjs <manifest.json>');
    return 2;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`cannot read ${file}: ${error.message}`);
    return 2;
  }
  const errors = checkManifest(manifest);
  if (errors.length > 0) {
    console.error(`${file} is not packable:`);
    for (const error of errors) console.error(`  - ${error}`);
    return 1;
  }
  console.log(`${file}: manifest ok`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
