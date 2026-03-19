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
  { id: 'llama3.2',             name: 'Llama 3.2 (3B)',         size: '~2 GB' },
  { id: 'llama3.2:1b',          name: 'Llama 3.2 (1B)',         size: '~1 GB' },
  { id: 'mistral',              name: 'Mistral 7B',             size: '~4 GB' },
  { id: 'phi3',                 name: 'Phi-3 Mini',             size: '~2 GB' },
  { id: 'gemma2:2b',            name: 'Gemma 2 (2B)',           size: '~1.6 GB' },
  { id: 'qwen2.5',              name: 'Qwen 2.5 (7B)',          size: '~4.7 GB' },
  { id: 'codellama',            name: 'Code Llama 7B',          size: '~4 GB' },
  { id: 'deepseek-coder:6.7b',  name: 'DeepSeek Coder 6.7B',   size: '~4 GB' },
];

const OLLAMA_URL_KEY = 'ollamaUrl';
const OLLAMA_URL_DEFAULT = 'http://localhost:11434';

const GEMINI_API_KEY_STORAGE_KEY = 'geminiApiKey';

/**
 * Get the Ollama base URL. Users can change this in the app settings to point
 * at a remote EC2 instance, e.g. "http://1.2.3.4:11434".
 */
export function getOllamaUrl(): string {
  try {
    return localStorage.getItem(OLLAMA_URL_KEY) || OLLAMA_URL_DEFAULT;
  } catch {
    return OLLAMA_URL_DEFAULT;
  }
}

/** Persist the Ollama base URL (strips trailing slash). */
export function setOllamaUrl(url: string): void {
  try {
    localStorage.setItem(OLLAMA_URL_KEY, url.replace(/\/+$/, ''));
  } catch {
    // localStorage unavailable (e.g. private browsing) – ignore
  }
}

/**
 * Get the Gemini API key. Returns the key stored by the user at runtime,
 * falling back to the build-time environment variable if set.
 */
export function getGeminiApiKey(): string {
  try {
    return localStorage.getItem(GEMINI_API_KEY_STORAGE_KEY) || process.env.GEMINI_API_KEY || '';
  } catch {
    return process.env.GEMINI_API_KEY || '';
  }
}

/** Persist the Gemini API key entered by the user. */
export function setGeminiApiKey(key: string): void {
  try {
    if (key.trim()) {
      localStorage.setItem(GEMINI_API_KEY_STORAGE_KEY, key.trim());
    } else {
      localStorage.removeItem(GEMINI_API_KEY_STORAGE_KEY);
    }
  } catch {
    // localStorage unavailable – ignore
  }
}

/** Return all models currently available in the running Ollama instance. */
export async function listOllamaModels(): Promise<Model[]> {
  try {
    const res = await fetch(`${getOllamaUrl()}/api/tags`);
    if (!res.ok) return [];
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

/**
 * Test whether Ollama is reachable at the current URL.
 * Returns true on success.
 */
export async function testOllamaConnection(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Pull (download) an Ollama model, streaming progress updates via the callback. */
export async function pullOllamaModel(
  modelId: string,
  onProgress?: (status: string) => void,
): Promise<void> {
  const response = await fetch(`${getOllamaUrl()}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: modelId }),
  });

  if (!response.ok || !response.body) {
    throw new Error(`Ollama pull request failed: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value).split('\n').filter(Boolean)) {
      try {
        const data = JSON.parse(line) as any;
        if (onProgress && data.status) onProgress(data.status);
      } catch {
        // ignore malformed lines
      }
    }
  }
}
