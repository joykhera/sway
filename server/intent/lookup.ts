import type { IntentReference } from '../../src/shared/intent.ts';

export type LookupSource = IntentReference & { extract: string };
export type SongLookup = (query: string, signal: AbortSignal) => Promise<LookupSource[]>;
export type Fetch = typeof globalThis.fetch;

// Streaming limit applies even if Content-Length is absent or dishonest.
export async function readJsonBounded(response: Response, maxBytes = 64 * 1024): Promise<unknown> {
  if (!response.body) throw new Error('Empty response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('Response limit exceeded');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Fixed-host MediaWiki search + introductory plain-text extracts, never a user URL. */
export function createWikipediaLookup(fetcher: Fetch = fetch, now = Date.now): SongLookup {
  const cache = new Map<string, { until: number; sources: LookupSource[] }>();
  const clone = (sources: LookupSource[]) => sources.map((source) => ({ ...source }));
  return async (query, signal) => {
    const normalized = query.trim().replace(/\s+/g, ' ');
    if (!normalized || normalized.length > 160 || /https?:\/\//i.test(normalized)) return [];
    signal.throwIfAborted();
    const cached = cache.get(normalized.toLowerCase());
    if (cached && cached.until > now()) return clone(cached.sources);
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(6000)]);
    const get = async (params: Record<string, string>) => {
      const url = new URL('https://en.wikipedia.org/w/api.php');
      url.search = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', ...params }).toString();
      const response = await fetcher(url, { signal: bounded, redirect: 'error', headers: { accept: 'application/json', 'user-agent': 'SwayMusicIntent/1.0 (background music reference lookup)' } });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Reference lookup unavailable'); }
      return record(await readJsonBounded(response));
    };
    const search = await get({ list: 'search', srsearch: normalized, srnamespace: '0', srlimit: '3', srprop: '' });
    const hits = record(search?.query)?.search;
    const pageIds = Array.isArray(hits) ? hits.slice(0, 3).map((hit) => record(hit)?.pageid).filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0) : [];
    if (pageIds.length === 0) return [];
    const result = await get({ prop: 'extracts|pageprops', pageids: pageIds.join('|'), exintro: '1', explaintext: '1', exchars: '1200', exlimit: '3', ppprop: 'disambiguation' });
    const pages = record(result?.query)?.pages;
    const sources: LookupSource[] = [];
    for (const value of Array.isArray(pages) ? pages.slice(0, 3) : []) {
      const page = record(value);
      if (!page || !pageIds.includes(page.pageid as number) || record(page.pageprops)?.disambiguation !== undefined
        || typeof page.title !== 'string' || page.title.length > 160 || typeof page.extract !== 'string' || !page.extract.trim()) continue;
      sources.push({ id: `wiki:${page.pageid}`, title: page.title, url: `https://en.wikipedia.org/?curid=${page.pageid}`, extract: page.extract.slice(0, 1200) });
    }
    if (cache.size >= 64) cache.delete(cache.keys().next().value!);
    cache.set(normalized.toLowerCase(), { until: now() + 10 * 60_000, sources: clone(sources) });
    return sources;
  };
}
