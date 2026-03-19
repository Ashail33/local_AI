import { GoogleGenAI, Type, FunctionDeclaration } from '@google/genai';
import { readFile, writeFile } from './fs';
import { webSearch } from './search';
import { getOllamaUrl } from './models';
import type { ModelProvider } from './models';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

// ── Tool declarations ─────────────────────────────────────────────────────────

const baseToolDeclarations: FunctionDeclaration[] = [
  {
    name: 'read_file',
    description: "Read the contents of a text-based file from the user's local workspace folder.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        filename: { type: Type.STRING, description: 'The name of the file to read (e.g., data.txt)' },
      },
      required: ['filename'],
    },
  },
  {
    name: 'write_file',
    description: "Write text content to a file in the user's local workspace folder.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        filename: { type: Type.STRING, description: 'The name of the file to write' },
        content: { type: Type.STRING, description: 'The text content to write to the file' },
      },
      required: ['filename', 'content'],
    },
  },
  {
    name: 'propose_python_script',
    description:
      'Propose a Python script to automate a task, process data, or edit complex files (Excel, Word, PDF). The script will be shown to the user for review before execution.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        script: { type: Type.STRING, description: 'The Python code to execute.' },
        explanation: { type: Type.STRING, description: 'Explanation of what the script does.' },
      },
      required: ['script', 'explanation'],
    },
  },
];

const webSearchTool: FunctionDeclaration = {
  name: 'web_search',
  description: 'Search the internet for up-to-date information on a topic.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: { type: Type.STRING, description: 'The search query' },
    },
    required: ['query'],
  },
};

// ── Ollama helper ─────────────────────────────────────────────────────────────

async function ollamaChat(
  model: string,
  messages: Array<{ role: string; content: string }>,
  systemPrompt: string,
): Promise<string> {
  const body = JSON.stringify({
    model,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
    stream: false,
  });

  const res = await fetch(`${getOllamaUrl()}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!res.ok) {
    throw new Error(
      `Ollama returned ${res.status}. Make sure Ollama is running and the selected model has been downloaded.`,
    );
  }

  const data = (await res.json()) as any;
  return (data.message?.content as string) || '';
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface ProcessChatOptions {
  /** Full model identifier, e.g. "gemini-3.1-pro-preview" or "llama3.2". */
  modelId?: string;
  provider?: ModelProvider;
  enableWebSearch?: boolean;
  agentName?: string;
}

function buildSystemInstruction(agentName: string, enableWebSearch: boolean): string {
  const lines = [
    `You are ${agentName}, a powerful Local AI Assistant.`,
    "You have access to a local folder on the user's computer.",
    'You can read and write files directly using tools.',
    'If the user asks you to process complex files (Excel, Word, PDF, PowerPoint, images),',
    'you MUST write a Python script to do it because you cannot read binary files directly.',
    "Propose Python scripts using the 'propose_python_script' tool; the user will review and run them.",
    'In your Python scripts you can install packages with micropip',
    '(e.g. `await micropip.install("openpyxl")`).',
    'Use `content = await read_file("file.txt")` and `await write_file("file.txt", content)`',
    'in scripts for workspace file access.',
  ];
  if (enableWebSearch) {
    lines.push("You can search the internet for current information using the 'web_search' tool.");
  }
  return lines.join(' ');
}

export async function processChatTurn(
  prompt: string,
  chatHistory: Array<{ role: string; content: string }>,
  dirHandle: FileSystemDirectoryHandle | null,
  onProposeScript: (script: string, explanation: string) => void,
  onLog: (msg: string) => void,
  options: ProcessChatOptions = {},
): Promise<{ role: string; content: string }> {
  const {
    modelId = 'gemini-3.1-pro-preview',
    provider = 'gemini',
    enableWebSearch = false,
    agentName = 'AI Assistant',
  } = options;

  const systemInstruction = buildSystemInstruction(agentName, enableWebSearch);

  // ── Ollama path (straightforward chat, no tool calling) ───────────────────
  if (provider === 'ollama') {
    const messages = chatHistory
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }));
    messages.push({ role: 'user', content: prompt });

    onLog(`Using Ollama model: ${modelId}`);
    const text = await ollamaChat(modelId, messages, systemInstruction);
    return { role: 'assistant', content: text };
  }

  // ── Gemini path (with tool calling) ──────────────────────────────────────
  const tools = enableWebSearch
    ? [...baseToolDeclarations, webSearchTool]
    : [...baseToolDeclarations];

  const chat = ai.chats.create({
    model: modelId,
    config: {
      systemInstruction,
      tools: [{ functionDeclarations: tools }],
      temperature: 0.2,
    },
  });

  // Replay history so the model has context
  for (const msg of chatHistory) {
    if (msg.role === 'user') {
      await chat.sendMessage({ message: msg.content });
    }
  }

  onLog('AI is thinking...');
  let response = await chat.sendMessage({ message: prompt });

  // Handle tool calls in a loop
  while (response.functionCalls && response.functionCalls.length > 0) {
    const call = response.functionCalls[0];
    onLog(`AI called tool: ${call.name}`);

    if (call.name === 'read_file') {
      if (!dirHandle) throw new Error('No directory selected.');
      try {
        const content = await readFile(dirHandle, call.args.filename as string);
        const preview =
          content.substring(0, 2000) + (content.length > 2000 ? '... (truncated)' : '');
        response = await chat.sendMessage({ message: `Tool read_file result: ${preview}` });
      } catch (e: any) {
        response = await chat.sendMessage({ message: `Tool read_file failed: ${e.message}` });
      }
    } else if (call.name === 'write_file') {
      if (!dirHandle) throw new Error('No directory selected.');
      try {
        await writeFile(dirHandle, call.args.filename as string, call.args.content as string);
        response = await chat.sendMessage({ message: 'Tool write_file succeeded.' });
      } catch (e: any) {
        response = await chat.sendMessage({ message: `Tool write_file failed: ${e.message}` });
      }
    } else if (call.name === 'propose_python_script') {
      onProposeScript(call.args.script as string, call.args.explanation as string);
      return {
        role: 'assistant',
        content: `I have proposed a Python script: ${call.args.explanation}. Please review and run it in the code panel.`,
      };
    } else if (call.name === 'web_search') {
      try {
        onLog(`Searching web for: ${call.args.query}`);
        const sr = await webSearch(call.args.query as string);
        const lines: string[] = [];
        if (sr.abstract) lines.push(`Summary: ${sr.abstract}`);
        for (const r of sr.results) {
          lines.push(`- ${r.title}\n  ${r.snippet}\n  URL: ${r.url}`);
        }
        const resultsText = lines.join('\n') || 'No results found.';
        response = await chat.sendMessage({
          message: `Web search results for "${call.args.query}":\n${resultsText}`,
        });
      } catch (e: any) {
        response = await chat.sendMessage({ message: `Web search failed: ${e.message}` });
      }
    } else {
      // Unknown tool – break to avoid infinite loop
      break;
    }
  }

  return { role: 'assistant', content: response.text ?? '' };
}
