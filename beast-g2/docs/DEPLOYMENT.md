# Personal gateway deployment checklist

One self-hosted `beast-g2` instance, one workspace. This repository does not host,
provision, or pay for anything. Work through every box on the target host before
storing real sessions.

## 1. Build and verify

- [ ] Node 20.18+ on the host; install dependencies from the lockfile.
- [ ] From `beast-g2/`, run `npm test`, `npm run typecheck`, `npm run lint`, `npx prettier --check .` and `npm run build`.
- [ ] Keep `dist/` (static client) and the Node gateway as separate services. `dist/` must never contain `.env`, provider keys, or the gateway token.
- [ ] Rebuild and repack the client with the existing `npm run pack` script whenever `app.json` or the manifest changes.

## 2. HTTPS and network

- [ ] Bind the gateway to loopback: `HOST=127.0.0.1`, `PORT=8787`. Do not bind `0.0.0.0` or a LAN address.
- [ ] Terminate TLS in an existing HTTPS reverse proxy on the same host and proxy to `http://127.0.0.1:8787`. Use a certificate valid for the public name; the phone must not trust a self-signed certificate.
- [ ] Forward `Authorization` and `Origin` unchanged. Disable proxy response buffering and support client cancellation so chat streaming works.
- [ ] Set proxy read/send timeouts above `UPSTREAM_TIMEOUT_MS` (default `90000`) and above the client's 95-second request budget. A longer server timeout cannot extend the client budget.
- [ ] Expose only 443 to the intended networks. Keep 8787 loopback-only in the host firewall. A private network or VPN can reduce exposure but does not replace token authentication.
- [ ] Never expose demo mode: it binds loopback only and uses a public demo token.

## 3. Secrets

- [ ] Create `.env` in the deployment directory, untracked and git-ignored, outside `dist/`, owned by the service account, mode `0600`.
- [ ] Set `GATEWAY_TOKEN` to a random value of at least 16 characters; `openssl rand -hex 32` is sufficient. The gateway refuses shorter tokens.
- [ ] Keep `BEAST_API_KEY` and `BEAST_STT_API_KEY` in the server environment only. Never put them in `VITE_*`, the manifest, the `.ehpk`, a QR code, screenshots, or tickets.
- [ ] The client keeps the gateway token in memory; preferences store only origin and language. Do not bake the token into the bundle.
- [ ] Rotate the token by editing `.env` and restarting the gateway. Old clients receive `401` and must re-enter it.

## 4. Client origin and manifest

- [ ] `ALLOWED_ORIGINS` must list the real client origin exactly: scheme, host, and port, comma separated, with no path, query, or fragment. Example: `https://app.example.com`.
- [ ] The `localhost` defaults are for development only. Any other `Origin` receives `403 origin_denied`; preflight for an allowed origin returns `204`. Verify with the actual Even WebView, not a guessed origin.
- [ ] Put the exact HTTPS gateway origin in the manifest whitelist and repack the client. A wildcard or example origin is not a deployment target.
- [ ] Enter the gateway origin and token at runtime on the device. Tokens stay in memory; preferences contain only origin and language.

## 5. Data volume, quota, and retention

- [ ] `SESSION_DATA_DIR` must be an absolute path on a dedicated, protected volume: not the repository, not `dist/`, not a public webroot, and not a synced consumer folder.
- [ ] The gateway creates the directory `0700` and audio files `0600`. Run the service with umask `077` (or `chmod 600` the database and its `-wal`/`-shm` files) so the database is not group- or world-readable. Full-volume encryption is required because SQLite does not encrypt data.
- [ ] `SESSION_DB_PATH` defaults to `$SESSION_DATA_DIR/sessions.sqlite`. If overridden, protect and back up that path instead.
- [ ] Set a volume quota in the host/volume layer. Size it as: database size + `AUDIO_QUOTA_BYTES` (512 MiB) + `DISK_RESERVE_BYTES` (64 MiB) + seven database backups + growth headroom. The gateway enforces the audio quota and reserve, not an OS disk quota.
- [ ] `AUDIO_QUOTA_BYTES=536870912`, `DISK_RESERVE_BYTES=67108864`, `MAX_IMPORT_BYTES=134217728`, `MAX_SESSION_MS=3600000`.
- [ ] `SESSION_RETENTION_DAYS=30` for ended sessions, revisions, summaries, and preparations; `AUDIO_RETENTION_HOURS=24` for audio. Deleting a session removes its rows and audio immediately in the live database.
- [ ] Gateway stdout is JSON operational metadata (event, stage, status, duration, request ID, error). Treat it as diagnostics, not as a transcript store. Rotate it on the host and keep seven days.
- [ ] Tell users that deletion removes live data but an existing backup can retain a copy until that backup rotates out.

## 6. Backup schedule and encryption

- [ ] Back up only the SQLite database; audio is temporary and is never copied by the script.
- [ ] Run daily at a low-traffic hour as the service account:

```sh
node scripts/backup.mjs \
  --source "$SESSION_DATA_DIR/sessions.sqlite" \
  --out "/srv/backups/beast/sessions-$(date +%F).sqlite"
```

- [ ] The script opens the source read-only, uses SQLite's online backup API, runs `PRAGMA integrity_check` on the copy, and writes `<out>.manifest.json` with `createdAt`, `sourceBytes`, `backupBytes`, `sha256`, `schemaVersion`, and `integrity`. It refuses to replace an existing file without `--force`.
- [ ] Keep seven daily copies and delete an old copy only after a newer verified copy exists. Do not reuse a filename without `--force`; `--force` replaces the backup only after the new copy passes its check.
- [ ] The script writes a plain SQLite file. The destination must be encrypted at rest, for example on an encrypted volume or by encrypting with age or GPG before the file leaves the host. The manifest is plain metadata and needs the same protection.
- [ ] Store backups on a different disk or host from the live volume, with directory `0700` and files `0600`. Do not use `cp`, `scp`, or a file-sync client on a live WAL database; the copy can be inconsistent.
- [ ] Backups contain transcripts, summaries, and preparations. Treat them as sensitive even though they contain no audio.

## 7. Restore drill

Run this before the first real session, after every upgrade, and monthly. It restores into a temporary directory, opens the copy read-only, checks the manifest and schema, counts records, and removes the copy.

1. Run `node scripts/restore-check.mjs --backup /srv/backups/beast/sessions-2026-10-27.sqlite`.
2. Expect a report like this verified synthetic drill:

```text
Restore check OK
  bytes: 192512
  sha256: de7c4d28ce497b633edb9334749d255d48efe971f9cef2ce88ad1690ab48420c
  schema version: 2
  integrity: ok
  sessions: 2
  segments: 3
  turns: 2
  summaries: 1
  preparations: 1
  temp copy removed: yes
```

3. For a real restore: stop the gateway, keep the current database and its `-wal`/`-shm` files aside, copy the verified backup to `SESSION_DB_PATH`, set ownership and mode `0600`, then start the gateway.
4. Check `/api/health`, open one session, and compare counts with the drill. Do not restore over a running gateway or leave old `-wal`/`-shm` files beside the replacement.
5. Restoring an older backup can resurrect sessions deleted after that backup. Keep an independent deletion list of IDs and expiry timestamps (no text) and re-delete those sessions through the API before exposing the instance.
6. If the check fails, keep the failing copy and the last known-good backup; do not delete the only good copy while investigating.

## 8. Smoke test

- [ ] Start the gateway under the host supervisor with `npm run gateway`; it reads `.env` and logs JSON to stdout.
- [ ] `curl -sS -H "Authorization: Bearer $GATEWAY_TOKEN" https://gateway.example.com/api/health` returns `ok:true`, `mode:live`, `sessions:true`, `summaries:true`.
- [ ] A request without a token returns `401`; a request from an origin outside `ALLOWED_ORIGINS` returns `403`.
- [ ] Health proves reachability only. Test a known Czech WAV, both chat models, and G2 audio/display before relying on inference compatibility.
- [ ] Confirm phone access over Wi-Fi, mobile data, and any VPN before the pilot.

## 9. Not covered

- No hosting, DNS, certificate issuance, reverse proxy, process supervisor, volume, quota enforcement, encryption, off-host replication, monitoring, or paging is provided or configured here.
- No paid resource, provider account, or credential is created. Provider compatibility and cost remain unverified until tested on the target account.
- No backup scheduler or retention job ships with the repository; the daily run and seven-day rotation are operator tasks.
- No audio is backed up, and no encryption is performed by the scripts. A database restore does not recover audio that expired or was deleted.
- No deletion journal is implemented. Re-deleting sessions after a restore is manual.
- One workspace per instance only. Separate personal and work use with separate instances, volumes, tokens, and provider profiles.
- No forensic erasure of storage blocks is promised.
