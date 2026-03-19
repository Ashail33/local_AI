import { GoogleGenAI, Type, FunctionDeclaration } from '@google/genai';
import { readFile, writeFile } from './fs';
import { webSearch } from './search';
import { getOllamaUrl, getGeminiApiKey } from './models';
import type { ModelProvider } from './models';

/** Returns a GoogleGenAI client initialised with the current API key. */
function getAiClient(): GoogleGenAI {
  return new GoogleGenAI({ apiKey: getGeminiApiKey() });
}

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
    name: 'create_document',
    description:
      'Write a well-structured, human-readable document to a file in the workspace. ' +
      'Use this for reports, specifications, plans, analyses, READMEs, meeting notes, and any ' +
      'content intended for people to read — not just raw code files.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        filename: {
          type: Type.STRING,
          description: 'The filename including extension (e.g., report.md, spec.txt, README.md)',
        },
        content: {
          type: Type.STRING,
          description: 'The full document content. Markdown formatting is supported and encouraged.',
        },
        document_type: {
          type: Type.STRING,
          description:
            'The kind of document: report | specification | readme | analysis | plan | notes | other',
        },
      },
      required: ['filename', 'content'],
    },
  },
  {
    name: 'build_tool',
    description:
      'Create a reusable Python tool script and save it to the workspace. ' +
      'Use this to build utilities, data processors, automation helpers, or any function library ' +
      'that other agents (or the user) can run later via propose_python_script.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        tool_name: {
          type: Type.STRING,
          description:
            'The tool filename without extension (e.g., "csv_parser" saves as csv_parser.py)',
        },
        description: {
          type: Type.STRING,
          description: 'What the tool does, its inputs, and how to use it.',
        },
        script: {
          type: Type.STRING,
          description: 'The Python source code, including all function and class definitions.',
        },
      },
      required: ['tool_name', 'description', 'script'],
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

/** Tools only available to manager agents. */
const managerToolDeclarations: FunctionDeclaration[] = [
  {
    name: 'spawn_agent',
    description:
      'Create a new worker agent and give it a name and an initial task. ' +
      'Returns the new agent\'s ID so you can later message it with message_agent.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: 'A short, descriptive name for the new worker agent.' },
        task: { type: Type.STRING, description: 'The initial task or instruction for the worker agent.' },
      },
      required: ['name', 'task'],
    },
  },
  {
    name: 'message_agent',
    description:
      'Send a message or sub-task to one of your worker agents and receive their response.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        agentId: { type: Type.STRING, description: 'The ID of the worker agent to message.' },
        message: { type: Type.STRING, description: 'The message or task to send to the worker.' },
      },
      required: ['agentId', 'message'],
    },
  },
];

/** Tool available to non-manager agents to forward work to another agent in the pipeline. */
const handoffAgentTool: FunctionDeclaration = {
  name: 'handoff_to_agent',
  description:
    'Pass your completed output or the next step of a task to another agent so the pipeline can continue. ' +
    'The receiving agent will process the message using all of its own tools and capabilities, then return a result.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      agentId: {
        type: Type.STRING,
        description: 'The ID of the agent to hand off to.',
      },
      message: {
        type: Type.STRING,
        description:
          'The output, findings, or next-step task to pass to that agent. Be thorough — include all context they need.',
      },
    },
    required: ['agentId', 'message'],
  },
};

/** Tool only available to recursive manager agents to request authoriser sign-off. */
const requestSignoffTool: FunctionDeclaration = {
  name: 'request_signoff',
  description:
    'Request authorisation that the assigned task is complete. Submit a detailed summary of ' +
    'the work completed and results achieved. Returns APPROVED or REJECTED with feedback.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      summary: {
        type: Type.STRING,
        description: 'A detailed summary of the work completed, decisions made, and results achieved.',
      },
    },
    required: ['summary'],
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

/** A lightweight reference to an agent used in tool callbacks. */
export interface AgentRef {
  id: string;
  name: string;
}

export interface ProcessChatOptions {
  /** Full model identifier, e.g. "gemini-3.1-pro-preview" or "llama3.2". */
  modelId?: string;
  provider?: ModelProvider;
  enableWebSearch?: boolean;
  agentName?: string;
  /** When true the agent receives spawn_agent + message_agent tools (Gemini only). */
  isManager?: boolean;
  /** Worker agents this manager has already spawned – included in the system prompt. */
  spawnedAgents?: AgentRef[];
  /** Called when the manager invokes spawn_agent. Returns the new agent's ref. */
  onSpawnAgent?: (name: string, task: string) => Promise<AgentRef>;
  /** Called when the manager invokes message_agent. Returns the worker's reply. */
  onMessageAgent?: (agentId: string, message: string) => Promise<string>;
  /** Custom user-defined context / task framing appended to the system instruction. */
  customSystemPrompt?: string;
  /** When true (recursive manager), the agent receives the request_signoff tool. */
  isRecursive?: boolean;
  /** Called when a recursive manager invokes request_signoff. Returns APPROVED/REJECTED string. */
  onRequestSignoff?: (summary: string) => Promise<string>;
  /** Agents this agent can hand off work to (non-manager agents only). */
  handoffAgents?: AgentRef[];
  /** Called when the agent invokes handoff_to_agent. Returns the target agent's reply. */
  onHandoffToAgent?: (agentId: string, message: string) => Promise<string>;
}

function buildSystemInstruction(
  agentName: string,
  enableWebSearch: boolean,
  isManager: boolean = false,
  spawnedAgents: AgentRef[] = [],
  isRecursive: boolean = false,
  customSystemPrompt: string = '',
  handoffAgents: AgentRef[] = [],
): string {
  const lines = [
    `You are ${agentName}, an intelligent AI copilot.`,
    'You help users think through problems, write code, create documents, build tools, and accomplish real-world tasks end-to-end.',
    'You have access to a local workspace folder and a rich set of tools. Think step-by-step, choose the right tool for each sub-task, and produce high-quality, actionable output.',
    'Use \'create_document\' to write reports, plans, specifications, analyses, READMEs, and any other human-readable documents.',
    'Use \'build_tool\' to create reusable Python utilities or scripts that can be used by you or other agents later.',
    'Use \'read_file\' and \'write_file\' for direct file read/write access.',
    'If the user asks you to process complex binary files (Excel, Word, PDF, PowerPoint, images),',
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

  if (isManager) {
    lines.push(
      'You are a MANAGER AGENT. You can break complex tasks down and delegate them to worker agents.',
      "Use 'spawn_agent' to create a new worker agent, giving it a name and an initial task description.",
      "Use 'message_agent' to send instructions to a worker agent and receive its response.",
      'Synthesise the workers\' responses and provide a final answer to the user.',
    );
    if (spawnedAgents.length > 0) {
      lines.push(
        `Your worker agents: ${spawnedAgents.map(a => `${a.name} (ID: ${a.id})`).join(', ')}.`,
      );
    } else {
      lines.push('You have no worker agents yet. Use spawn_agent to create them when needed.');
    }
  }

  if (isManager && isRecursive) {
    lines.push(
      'You are also a RECURSIVE MANAGER. Keep working autonomously until the task is fully complete.',
      "When you believe the task is done, call 'request_signoff' with a detailed summary of the work and results.",
      'If the authoriser REJECTS your work, carefully analyse their feedback and continue working to address every point.',
      'Keep iterating — spawning more agents, gathering more information, revising outputs — until you receive APPROVED status.',
    );
  }

  if (!isManager && handoffAgents.length > 0) {
    lines.push(
      "You can pass completed work to another agent in the pipeline using 'handoff_to_agent'.",
      'Use handoff_to_agent when you have finished your part of a task and the next step should be handled by a different agent.',
      `Available agents for handoff: ${handoffAgents.map(a => `${a.name} (ID: ${a.id})`).join(', ')}.`,
    );
  }

  if (customSystemPrompt.trim()) {
    lines.push(`\n\nTask Context & Instructions:\n${customSystemPrompt.trim()}`);
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
    isManager = false,
    spawnedAgents = [],
    onSpawnAgent,
    onMessageAgent,
    customSystemPrompt = '',
    isRecursive = false,
    onRequestSignoff,
    handoffAgents = [],
    onHandoffToAgent,
  } = options;

  const systemInstruction = buildSystemInstruction(
    agentName,
    enableWebSearch,
    isManager,
    spawnedAgents,
    isRecursive,
    customSystemPrompt,
    handoffAgents,
  );

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
  const ai = getAiClient();
  const tools = [
    ...baseToolDeclarations,
    ...(enableWebSearch ? [webSearchTool] : []),
    ...(isManager ? managerToolDeclarations : []),
    ...(isManager && isRecursive ? [requestSignoffTool] : []),
    ...(!isManager && handoffAgents.length > 0 && onHandoffToAgent ? [handoffAgentTool] : []),
  ];

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

  // Track whether the authoriser approved (used to break recursive loop)
  let taskApproved = false;

  // Handle tool calls in a loop
  while (response.functionCalls && response.functionCalls.length > 0 && !taskApproved) {
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
    } else if (call.name === 'create_document') {
      if (!dirHandle) throw new Error('No directory selected.');
      try {
        await writeFile(dirHandle, call.args.filename as string, call.args.content as string);
        const docType = (call.args.document_type as string) || 'document';
        onLog(`Document created: ${call.args.filename} (${docType})`);
        response = await chat.sendMessage({
          message: `Tool create_document succeeded. ${docType} saved as "${call.args.filename}".`,
        });
      } catch (e: any) {
        response = await chat.sendMessage({ message: `Tool create_document failed: ${e.message}` });
      }
    } else if (call.name === 'build_tool') {
      if (!dirHandle) throw new Error('No directory selected.');
      try {
        const toolFilename = `${call.args.tool_name as string}.py`;
        const header = `# Tool: ${call.args.tool_name as string}\n# ${call.args.description as string}\n\n`;
        await writeFile(dirHandle, toolFilename, header + (call.args.script as string));
        onLog(`Tool built: ${toolFilename}`);
        response = await chat.sendMessage({
          message:
            `Tool build_tool succeeded. Python tool saved as "${toolFilename}". ` +
            'Other agents can use it via propose_python_script.',
        });
      } catch (e: any) {
        response = await chat.sendMessage({ message: `Tool build_tool failed: ${e.message}` });
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
    } else if (call.name === 'spawn_agent') {
      if (!onSpawnAgent) {
        response = await chat.sendMessage({ message: 'spawn_agent is not available in this context.' });
      } else {
        try {
          onLog(`Manager spawning agent: ${call.args.name}`);
          const newAgent = await onSpawnAgent(
            call.args.name as string,
            call.args.task as string,
          );
          response = await chat.sendMessage({
            message: `spawn_agent succeeded. New agent "${newAgent.name}" created with ID: ${newAgent.id}. Use message_agent with this ID to communicate with it.`,
          });
        } catch (e: any) {
          response = await chat.sendMessage({ message: `spawn_agent failed: ${e.message}` });
        }
      }
    } else if (call.name === 'message_agent') {
      if (!onMessageAgent) {
        response = await chat.sendMessage({ message: 'message_agent is not available in this context.' });
      } else {
        try {
          onLog(`Manager messaging agent ID: ${call.args.agentId}`);
          const reply = await onMessageAgent(
            call.args.agentId as string,
            call.args.message as string,
          );
          response = await chat.sendMessage({
            message: `message_agent response from agent ${call.args.agentId}: ${reply}`,
          });
        } catch (e: any) {
          response = await chat.sendMessage({ message: `message_agent failed: ${e.message}` });
        }
      }
    } else if (call.name === 'request_signoff') {
      const summary = call.args.summary as string;
      onLog('Manager requesting authoriser sign-off…');
      try {
        const result = onRequestSignoff
          ? await onRequestSignoff(summary)
          : 'APPROVED: No authoriser configured — task marked as complete.';
        if (result.startsWith('APPROVED')) {
          taskApproved = true;
        }
        response = await chat.sendMessage({ message: `request_signoff result: ${result}` });
      } catch (e: any) {
        response = await chat.sendMessage({ message: `request_signoff failed: ${e.message}` });
      }
    } else if (call.name === 'handoff_to_agent') {
      if (!onHandoffToAgent) {
        response = await chat.sendMessage({
          message: 'handoff_to_agent is not available in this context.',
        });
      } else {
        try {
          onLog(`Handing off to agent: ${call.args.agentId}`);
          const reply = await onHandoffToAgent(
            call.args.agentId as string,
            call.args.message as string,
          );
          response = await chat.sendMessage({
            message: `handoff_to_agent succeeded. Agent ${call.args.agentId} responded: ${reply}`,
          });
        } catch (e: any) {
          response = await chat.sendMessage({ message: `handoff_to_agent failed: ${e.message}` });
        }
      }
    } else {
      // Unknown tool – break to avoid infinite loop
      break;
    }
  }

  return { role: 'assistant', content: response.text ?? '' };
}
