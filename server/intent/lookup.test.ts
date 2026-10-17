import { describe, expect, it, vi } from 'vitest';
import { createWikipediaLookup, readJsonBounded, type Fetch } from './lookup.ts';

const signal = () => new AbortController().signal;
describe('fixed-host bounded reference lookup', () => {
  it('uses only Wikipedia query API, filters disambiguation, and caches detached sources', async () => {
    const fetcher = vi.fn<Fetch>().mockResolvedValueOnce(Response.json({ query: { search: [{ pageid: 42 }, { pageid: 99 }] } }))
      .mockResolvedValueOnce(Response.json({ query: { pages: [
        { pageid: 42, title: 'Example song', extract: 'A song in the jazz genre.' },
        { pageid: 99, title: 'Example', extract: 'May refer to...', pageprops: { disambiguation: '' } },
      ] } }));
    const lookup = createWikipediaLookup(fetcher);
    const sources = await lookup('Example song artist', signal());
    expect(sources).toEqual([{ id: 'wiki:42', title: 'Example song', url: 'https://en.wikipedia.org/?curid=42', extract: 'A song in the jazz genre.' }]);
    for (const [url, init] of fetcher.mock.calls) {
      expect(new URL(String(url)).origin).toBe('https://en.wikipedia.org');
      expect(init?.redirect).toBe('error');
    }
    sources[0]!.title = 'mutated';
    expect((await lookup('EXAMPLE song artist', signal()))[0]!.title).toBe('Example song');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects URLs and oversized queries without fetching', async () => {
    const fetcher = vi.fn<Fetch>();
    const lookup = createWikipediaLookup(fetcher);
    expect(await lookup('https://internal.test', signal())).toEqual([]);
    expect(await lookup('x'.repeat(161), signal())).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('bounds actual streamed response bytes', async () => {
    await expect(readJsonBounded(new Response(' '.repeat(21)), 20)).rejects.toThrow('limit');
  });
  it('expires entries rather than claiming stale metadata is current', async () => {
    let now = 0;
    const fetcher = vi.fn<Fetch>().mockImplementation(async (url) => new URL(String(url)).searchParams.has('list')
      ? Response.json({ query: { search: [{ pageid: 42 }] } }) : Response.json({ query: { pages: [{ pageid: 42, title: 'Song', extract: 'A song.' }] } }));
    const lookup = createWikipediaLookup(fetcher, () => now);
    await lookup('Song', signal()); now = 600_001; await lookup('Song', signal());
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
