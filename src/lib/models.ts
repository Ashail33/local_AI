export type ModelProvider = 'gemini' | 'ollama';

export interface Model {
  id: string;
  name: string;
  provider: ModelProvider;
}

export const DEFAULT_GEMINI_MODELS: Model[] = [
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', provider: 'gemini' },
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', provider: 'gemini' },
];

/** Well-known Ollama models users can download. */
export const POPULAR_OLLAMA_MODELS: Array<{ id: string; name: string; size: string }> = [
  { id: 'llama3.2',          name: 'Llama 3.2 (3B)',        size: '~2 GB' },
  { id: 'llama3.2:1b',       name: 'Llama 3.2 (1B)',        size: '~1 GB' },
  { id: 'mistral',           name: 'Mistral 7B',            size: '~4 GB' },
  { id: 'phi3',              name: 'Phi-3 Mini',            size: '~2 GB' },
  { id: 'gemma2:2b',         name: 'Gemma 2 (2B)',          size: '~1.6 GB' },
  { id: 'qwen2.5',           name: 'Qwen 2.5 (7B)',         size: '~4.7 GB' },
  { id: 'codellama',         name: 'Code Llama 7B',         size: '~4 GB' },
  { id: 'deepseek-coder:6.7b', name: 'DeepSeek Coder 6.7B', size: '~4 GB' },
];

/** Candidate URLs to reach Ollama – Docker proxy first, then direct. */
const OLLAMA_ENDPOINTS = ['/api/ollama', 'http://localhost:11434'];

async function ollamaFetch(path: string, init?: RequestInit): Promise<Response | null> {
  for (const base of OLLAMA_ENDPOINTS) {
    try {
      const res = await fetch(`${base}${path}`, init);
      if (res.ok) return res;
    } catch {
      // try next
    }
  }
  return null;
}

/** Return all models currently available in the running Ollama instance. */
export async function listOllamaModels(): Promise<Model[]> {
  const res = await ollamaFetch('/api/tags');
  if (!res) return [];
  try {
    const data = (await res.json()) as any;
    return (data.models || []).map((m: any) => ({
      id: m.name as string,
      name: m.name as string,
      provider: 'ollama' as ModelProvider,
    }));
  } catch {
    return [];
  }
}

/** Pull (download) an Ollama model, streaming progress via the callback. */
export async function pullOllamaModel(
  modelId: string,
  onProgress?: (status: string) => void,
): Promise<void> {
  let lastError: Error = new Error('Could not reach Ollama service');

  for (const base of OLLAMA_ENDPOINTS) {
    try {
      const response = await fetch(`${base}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelId }),
      });

      if (!response.ok || !response.body) continue;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        for (const line of chunk.split('\n').filter(Boolean)) {
          try {
            const data = JSON.parse(line) as any;
            if (onProgress && data.status) onProgress(data.status);
          } catch {
            // ignore malformed lines
          }
        }
      }
      return; // success
    } catch (e) {
      lastError = e as Error;
    }
  }

  throw lastError;
}
