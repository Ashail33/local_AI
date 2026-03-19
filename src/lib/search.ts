export interface SearchResult {
  title: string;
  snippet: string;
  url: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  abstract: string;
}

/**
 * Search the web via the backend proxy (Docker mode) or directly via the
 * DuckDuckGo Instant Answer API (browser/development mode).
 */
export async function webSearch(query: string): Promise<SearchResponse> {
  // Try the server-side proxy first (available in Docker / production)
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    if (res.ok) {
      return (await res.json()) as SearchResponse;
    }
  } catch {
    // fall through to direct call
  }

  // Fallback: call DuckDuckGo directly from the browser
  const url =
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}` +
    `&format=json&no_html=1&skip_disambig=1`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Search failed with status ${res.status}`);
  }

  const data = (await res.json()) as any;

  const results: SearchResult[] = [
    ...(Array.isArray(data.Results) ? data.Results : [])
      .slice(0, 5)
      .map((r: any) => ({ title: r.Text || '', snippet: r.Text || '', url: r.FirstURL || '' })),
    ...(Array.isArray(data.RelatedTopics) ? data.RelatedTopics : [])
      .filter((t: any) => t.Text && t.FirstURL)
      .slice(0, 5)
      .map((t: any) => ({ title: t.Text || '', snippet: t.Text || '', url: t.FirstURL || '' })),
  ];

  return { query, results, abstract: data.AbstractText || '' };
}
