import { gatewayUrl, type Settings } from '../api'
import { diagnostics, errorCode } from '../diagnostics'
import { linkAbort } from '../transport'

export type RequestOptions = { signal?: AbortSignal; timeoutMs?: number }

type FailureBody = { error?: string; message?: string; requestId?: string }

/**
 * The gateway answers every session route with `{ error, message, requestId }` on failure. The error lives next to the
 * transport that throws it and is re-exported from `session.ts`, so the public contract still exposes one error type.
 */
export class SessionApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string
  ) {
    super(message)
    this.name = 'SessionApiError'
  }
}

/**
 * Shared HTTP plumbing for the session contract. Every domain module adds its routes by extending this class, so a new
 * domain only needs its own file and one link in the class chain.
 */
export abstract class SessionClientBase {
  constructor(private readonly settings: () => Settings) {}

  protected async request(path: string, init: RequestInit = {}, options: RequestOptions = {}) {
    const s = this.settings()
    const trace = diagnostics.span('session', { transport: 'gateway' })
    if (!s.token) {
      trace.end('error', { code: 'operation_failed' })
      throw new SessionApiError(401, 'unauthorized', 'Enter the API key or gateway token first.')
    }
    const link = linkAbort(options.signal, options.timeoutMs ?? 20000)
    try {
      const response = await fetch(gatewayUrl(s.gateway, path), {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${s.token}` },
        signal: link.signal,
        cache: 'no-store'
      })
      trace.mark('response.headers', { status: response.status })
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as FailureBody
        throw new SessionApiError(response.status, body.error || 'http_error', body.message || `Gateway HTTP ${response.status}`, body.requestId)
      }
      return {
        response,
        fail: (error: unknown) => trace.end('error', { code: link.timeout.aborted ? 'timeout' : errorCode(error, options.signal) }),
        release: () => {
          link.release()
          trace.end()
        }
      }
    } catch (error) {
      trace.end('error', { code: link.timeout.aborted ? 'timeout' : errorCode(error, options.signal) })
      link.release()
      throw error
    }
  }

  protected async json<T>(path: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<T> {
    const { response, release, fail } = await this.request(path, init, options)
    try {
      return (await response.json()) as T
    } catch (error) {
      fail(error)
      throw error
    } finally {
      release()
    }
  }

  protected post<T>(path: string, body: unknown, options?: RequestOptions) {
    return this.json<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, options)
  }
}
