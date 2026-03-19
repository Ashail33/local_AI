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
 * Search the web using the DuckDuckGo Instant Answer API.
 * No API key required; results are available without sign-up.
 */
export async function webSearch(query: string): Promise<SearchResponse> {
  const url =
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}` +
    `&format=json&no_html=1&skip_disambig=1`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Search request failed with status ${res.status}`);
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
