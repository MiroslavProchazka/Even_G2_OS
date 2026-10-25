// Fixed search endpoint; retrieved links are evidence, never fetched by this gateway.
export async function searchWeb(query, key, signal, fetchImpl = fetch) {
  if (!key) throw new Error('Web search is not configured on this gateway.');
  if (typeof query !== 'string' || !query.trim() || query.length > 600 || query.trim().split(/\s+/).length > 75) throw new Error('Web query must fit 600 characters and 75 words.');
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query.trim()); url.searchParams.set('count', '5');
  const response = await fetchImpl(url, { headers: { 'X-Subscription-Token': key, Accept: 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]), redirect: 'error' });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Web search provider failed.'); }
  const reader = response.body?.getReader(); if (!reader) throw new Error('Empty web response.');
  let text = '', size = 0; const decoder = new TextDecoder();
  try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 262144) throw new Error('Web response exceeds limit.'); text += decoder.decode(value, { stream: true }); } text += decoder.decode(); }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const data = JSON.parse(text), sources = [];
  for (const item of (Array.isArray(data.web?.results) ? data.web.results : []).slice(0, 5)) {
    try {
      const link = new URL(item.url);
      if (!['https:', 'http:'].includes(link.protocol) || link.username || link.password || link.href.length > 2048 || typeof item.title !== 'string' || typeof item.description !== 'string' || !item.description.trim()) continue;
      sources.push({ id: sources.length + 1, title: item.title.slice(0, 200), url: link.href, snippet: item.description.slice(0, 1200), published: typeof item.page_age === 'string' ? item.page_age.slice(0, 100) : undefined });
    } catch { /* Ignore invalid result URLs. */ }
  }
  if (!sources.length) throw new Error('No usable web evidence found.');
  return { sources, retrievedAt: new Date().toISOString() };
}
