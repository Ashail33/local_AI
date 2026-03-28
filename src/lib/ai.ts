import { GoogleGenAI, Type, FunctionDeclaration } from '@google/genai';
import { readFile, writeFile, listFiles } from './fs';
import { webSearch } from './search';
import { getOllamaUrl, getGeminiApiKey } from './models';
import type { ModelProvider } from './models';

/** Returns a GoogleGenAI client initialised with the current API key. */
function getAiClient(): GoogleGenAI {
  return new GoogleGenAI({ apiKey: getGeminiApiKey() });
}

/** Encode a string to base64 in a UTF-8 safe way (no deprecated unescape). */
function toBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Generate a Python script that creates a Word (.docx) document via python-docx. */
function buildDocxScript(filename: string, content: string): string {
  const b64 = toBase64(content);
  return `await micropip.install("python-docx")
from docx import Document
import io, base64

content = base64.b64decode("${b64}").decode("utf-8")
doc = Document()
for line in content.split("\\n"):
    doc.add_paragraph(line)

buf = io.BytesIO()
doc.save(buf)
await write_binary_file("${filename}", buf.getvalue())
`;
}

/** Generate a Python script that creates a PDF document via reportlab. */
function buildPdfScript(filename: string, content: string): string {
  const b64 = toBase64(content);
  return `await micropip.install("reportlab")
from reportlab.lib.pagesizes import A4
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet
import io, base64

content = base64.b64decode("${b64}").decode("utf-8")
buf = io.BytesIO()
doc = SimpleDocTemplate(buf, pagesize=A4)
styles = getSampleStyleSheet()
story = []
for line in content.split("\\n"):
    if line.strip():
        safe = line.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;").replace("'", "&#39;")
        story.append(Paragraph(safe, styles["Normal"]))
    else:
        story.append(Spacer(1, 12))
doc.build(story)
await write_binary_file("${filename}", buf.getvalue())
`;
}

// ── Tool declarations ─────────────────────────────────────────────────────────

const createFolderTool: FunctionDeclaration = {
  name: 'create_folder',
  description:
    'Create a subfolder (or nested subfolder path) inside the workspace. ' +
    'Use this to organise outputs into directories before writing files. ' +
    'Supports nested paths, e.g. "reports/2024/q1".',
  parameters: {
    type: Type.OBJECT,
    properties: {
      folder_path: {
        type: Type.STRING,
        description: 'Folder path relative to workspace root (e.g., "reports" or "reports/2024").',
      },
    },
    required: ['folder_path'],
  },
};

const writeDocumentTool: FunctionDeclaration = {
  name: 'write_document',
  description:
    'Write a document to the workspace in the specified format. ' +
    'Supports plain text (.txt), Microsoft Word (.docx), and PDF (.pdf). ' +
    'Subfolder paths are supported (e.g., "reports/summary.docx"). ' +
    'Intermediate folders are created automatically.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      filename: {
        type: Type.STRING,
        description:
          'Filename with extension, optionally with a subfolder path relative to the workspace root ' +
          '(e.g., "report.txt", "docs/summary.docx", "output/results.pdf"). Must NOT be an absolute path.',
      },
      content: {
        type: Type.STRING,
        description: 'The document content. Plain text or Markdown is accepted for all formats.',
      },
      format: {
        type: Type.STRING,
        description: 'Document format: "txt" | "docx" | "pdf".',
      },
    },
    required: ['filename', 'content', 'format'],
  },
};

const readFileTool: FunctionDeclaration = {
  name: 'read_file',
  description: "Read the contents of a text-based file from the user's local workspace folder.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      filename: { type: Type.STRING, description: 'The name of the file to read (e.g., data.txt). Supports subfolder paths like "reports/data.csv".' },
    },
    required: ['filename'],
  },
};

const listFilesTool: FunctionDeclaration = {
  name: 'list_files',
  description: "List all files currently in the user's local workspace folder. Returns a flat list of relative file paths.",
  parameters: {
    type: Type.OBJECT,
    properties: {},
    required: [],
  },
};

const writeFileTool: FunctionDeclaration = {
  name: 'write_file',
  description: "Write text content to a file in the user's local workspace folder. Supports subfolder paths like \"reports/summary.txt\" — intermediate folders are created automatically.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      filename: { type: Type.STRING, description: 'The file path to write, relative to the workspace root (e.g., "file.txt" or "reports/summary.txt"). Must NOT be an absolute path.' },
      content: { type: Type.STRING, description: 'The text content to write to the file' },
    },
    required: ['filename', 'content'],
  },
};

const createDocumentTool: FunctionDeclaration = {
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
};

const buildToolTool: FunctionDeclaration = {
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
};

const proposePythonScriptTool: FunctionDeclaration = {
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
};

const baseToolDeclarations: FunctionDeclaration[] = [
  readFileTool,
  writeFileTool,
  listFilesTool,
  createDocumentTool,
  buildToolTool,
  proposePythonScriptTool,
  createFolderTool,
  writeDocumentTool,
];

/**
 * Restricted tool set for manager agents.
 * Managers may read files for context and write final summary documents,
 * but they must NOT write code, build tools, or propose scripts — all
 * implementation work must be delegated to worker agents.
 */
const managerBaseToolDeclarations: FunctionDeclaration[] = [
  readFileTool,
  listFilesTool,
  createDocumentTool,
  createFolderTool,
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
    name: 'list_agents',
    description:
      'List all currently available agents in the system. Returns each agent\'s name, ID, and role. ' +
      'ALWAYS call this first before messaging or connecting agents so you know their exact IDs.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
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
      'Send a message or sub-task to one of your worker agents and receive their response. ' +
      'Use the agent ID returned by list_agents or spawn_agent.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        agentId: { type: Type.STRING, description: 'The ID of the worker agent to message.' },
        message: { type: Type.STRING, description: 'The message or task to send to the worker.' },
      },
      required: ['agentId', 'message'],
    },
  },
  {
    name: 'connect_agents',
    description:
      'Establish a one-way communication link so that one agent (the source) can hand off work ' +
      'to another agent (the destination) using the handoff_to_agent tool. ' +
      'Use this to build pipelines between worker agents. ' +
      'For example: connect Agent A → Agent B so A can pass its completed output to B.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        fromAgentId: {
          type: Type.STRING,
          description: 'The ID of the agent that will SEND work (the source).',
        },
        toAgentId: {
          type: Type.STRING,
          description: 'The ID of the agent that will RECEIVE work (the destination).',
        },
      },
      required: ['fromAgentId', 'toAgentId'],
    },
  },
  {
    name: 'critique_output',
    description:
      'Submit a piece of work or output to a critic agent for structured quality review. ' +
      'Returns feedback on strengths, issues, and specific recommendations. ' +
      'Use this when you want an independent assessment of a worker\'s output before finalising.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        output: {
          type: Type.STRING,
          description: 'The work, document, code, or analysis to be reviewed by the critic.',
        },
      },
      required: ['output'],
    },
  },
  {
    name: 'rename_agent',
    description:
      'Rename an existing agent. The new name is immediately visible in the UI tabs and graph view.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        agentId: { type: Type.STRING, description: 'The ID of the agent to rename.' },
        newName: { type: Type.STRING, description: 'The new display name for the agent.' },
      },
      required: ['agentId', 'newName'],
    },
  },
  {
    name: 'set_agent_prompt',
    description:
      'Set or update the custom system prompt of an existing agent. ' +
      'This controls the agent\'s behaviour, personality, and task instructions. ' +
      'The prompt takes effect on the agent\'s next interaction.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        agentId: { type: Type.STRING, description: 'The ID of the agent whose prompt to set.' },
        prompt: { type: Type.STRING, description: 'The new system prompt / instructions for the agent.' },
      },
      required: ['agentId', 'prompt'],
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

/**
 * Parsed structured decision from an Ollama ReAct response.
 * The model outputs JSON with a `decision` field that drives the ReAct loop.
 */
interface OllamaReActDecision {
  decision: 'USE_TOOL' | 'THINK' | 'PLAN' | 'FINISH';
  tool?: string;
  input?: Record<string, unknown>;
  thought?: string;
  response?: string;
  /** Ordered list of steps for a PLAN decision. */
  plan?: string[];
  /**
   * Optional task-memory snapshot included in any decision.
   * The loop tracks this across steps and injects it into continuation prompts.
   */
  memory?: {
    goal?: string;
    completed?: string[];
    remaining?: string[];
  };
}

/**
 * Attempt to extract a structured OllamaReActDecision from the model's raw text.
 * Tries JSON code blocks first, then a bare JSON object anywhere in the text.
 * Returns null when no valid decision object can be found.
 */
function parseOllamaReActDecision(text: string): OllamaReActDecision | null {
  // Try fenced code block (```json … ```) first
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidates: string[] = codeBlock ? [codeBlock[1], text] : [text];

  for (const candidate of candidates) {
    const jsonMatch = candidate.match(/\{[\s\S]*\}/);
    if (!jsonMatch) continue;
    try {
      const obj = JSON.parse(jsonMatch[0]);
      if (typeof obj.decision === 'string') return obj as OllamaReActDecision;
    } catch {
      // try next candidate
    }
  }
  return null;
}

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

/** Format accumulated task memory into a short reminder string for continuation prompts. */
function formatTaskMemoryNote(memory: { goal: string; completed: string[]; remaining: string[] }): string {
  if (memory.remaining.length === 0) return '';
  return `\n\nTask memory — completed: [${memory.completed.join(', ')}]; remaining: [${memory.remaining.join(', ')}].`;
}

/** A lightweight reference to an agent used in tool callbacks. */
export interface AgentRef {
  id: string;
  name: string;
  /** Role of the agent: 'manager' | 'worker' | 'authoriser' */
  role?: string;
  /**
   * The worker's response to its initial task, populated when spawn_agent
   * auto-executes the task immediately upon creation.
   */
  initialResponse?: string;
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
  /** Called when the manager invokes list_agents. Returns all known agents. */
  onListAgents?: () => Promise<AgentRef[]>;
  /** Called when the manager invokes connect_agents. Returns a confirmation string. */
  onConnectAgents?: (fromAgentId: string, toAgentId: string) => Promise<string>;
  /** Called when the manager invokes rename_agent. Returns a confirmation string. */
  onRenameAgent?: (agentId: string, newName: string) => Promise<string>;
  /** Called when the manager invokes set_agent_prompt. Returns a confirmation string. */
  onSetAgentPrompt?: (agentId: string, prompt: string) => Promise<string>;
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
  /**
   * Called when an agent invokes write_document for docx/pdf formats.
   * Executes a Python script automatically (without user review).
   * Returns a result string.
   */
  onAutoRunScript?: (script: string) => Promise<string>;
  /** When true (manager only), the agent is running in live autonomous mode. */
  isLive?: boolean;
  /** When true, the agent is a critic whose job is to review and critique outputs. */
  isCritic?: boolean;
  /**
   * Called when a manager invokes critique_output.
   * Runs the critic agent with the provided output and returns structured feedback.
   */
  onCritiqueOutput?: (output: string) => Promise<string>;
  /**
   * Called after the agent completes a significant step (tool call, task completion).
   * The entry is appended to the agent's episodic memory progress log.
   */
  onEpisodicMemory?: (entry: string) => void;
}

/**
 * Build a system instruction for Ollama models.
 * When availableTools is non-empty the prompt describes the ReAct JSON format so
 * the model can request tool execution.  Without tools the model responds directly.
 */
export function buildOllamaSystemInstruction(
  agentName: string,
  isManager: boolean,
  customSystemPrompt: string,
  isCritic: boolean = false,
  availableTools: string[] = [],
): string {
  const lines: string[] = [];

  if (isCritic) {
    lines.push(
      '═══ AGENT SELF PROFILE ═══',
      `Name: ${agentName}`,
      'Role: CRITIC AGENT',
      'Purpose: Review and critique work submitted to you. Provide structured, honest, and actionable feedback.',
      '',
      'Tools you have access to:',
      ...availableTools.map(t => `  • ${t}`),
      ...(availableTools.length === 0 ? ['  (none)'] : []),
      '',
      'Agents you can communicate with: You receive work for review. You do not initiate communication.',
      '═══ END SELF PROFILE ═══',
      '',
      `You are ${agentName}, a CRITIC AGENT.`,
      'Your role is to review work and provide structured, actionable feedback.',
      'When reviewing, identify: what is correct and well done, what is missing or incorrect, and specific improvements.',
      'Structure your response as:',
      'STRENGTHS: <list what is good>',
      'ISSUES: <list problems or gaps>',
      'RECOMMENDATIONS: <list specific improvements>',
      'VERDICT: APPROVE | REVISE',
    );
  } else if (isManager) {
    lines.push(
      '═══ AGENT SELF PROFILE ═══',
      `Name: ${agentName}`,
      'Role: MANAGER AGENT',
      'Purpose: Orchestrate tasks by breaking them down into clear steps, providing structured plans, and summarising results. You are a coordinator.',
      '',
      'Tools you have access to:',
      ...availableTools.map(t => `  • ${t}`),
      ...(availableTools.length === 0 ? ['  (none — Ollama models operate in text-only mode)'] : []),
      '',
      'Agents you can communicate with: You can coordinate and plan tasks for the user to delegate.',
      '',
      'How to do your tasks:',
      '  1. Break the task into clear, well-defined sub-tasks.',
      '  2. Provide a structured plan the user can follow.',
      '  3. Summarise results with Markdown headings and bullet lists.',
      '═══ END SELF PROFILE ═══',
      '',
      `You are ${agentName}, an AI manager assistant.`,
      'Help the user by breaking tasks into clear steps, providing structured plans, and summarising results.',
      'Format your responses with Markdown: use ## headings, bullet lists, and **bold** for emphasis.',
      'Be concise and actionable — give the user a clear plan they can follow.',
    );
  } else {
    lines.push(
      '═══ AGENT SELF PROFILE ═══',
      `Name: ${agentName}`,
      'Role: WORKER AGENT',
      'Purpose: Help users think through problems, answer questions, write content, and accomplish tasks.',
      '',
      'Tools you have access to:',
      ...availableTools.map(t => `  • ${t}`),
      ...(availableTools.length === 0 ? ['  (none — operating in text-only mode)'] : []),
      '',
      'Agents you can communicate with: A manager may connect you to other agents later.',
      '',
      'How to do your tasks:',
      '  1. Think step-by-step about the problem.',
      '  2. Use your available tools to read files, write content, and search for information.',
      '  3. Produce high-quality, actionable output.',
      '═══ END SELF PROFILE ═══',
      '',
      `You are ${agentName}, an intelligent AI assistant.`,
      'Help users think through problems, answer questions, write content, and accomplish tasks.',
      'Format your responses with clean Markdown: use headings, bullet lists, code blocks, and bold text for clarity.',
      'Be concise, helpful, and produce high-quality, actionable output.',
      'When writing code, use fenced code blocks with the language specified.',
    );
  }

  if (availableTools.length > 0) {
    const toolDocs: Record<string, string> = {
      read_file:        'read_file — read a workspace file. Input: {"filename": "path/to/file.txt"}',
      write_file:       'write_file — write text to a workspace file. Input: {"filename": "path.txt", "content": "text"}',
      list_files:       'list_files — list all files in the workspace. Input: {}',
      web_search:       'web_search — search the internet. Input: {"query": "search terms"}',
      handoff_to_agent: 'handoff_to_agent — pass work to another agent. Input: {"agentId": "<id>", "message": "..."}',
    };

    lines.push(
      '\n\nYou have access to the following tools. Every response MUST be valid JSON (no extra text before or after the JSON object).',
      '',
      '── Decision types ──────────────────────────────────────────────────────────',
      '1. PLAN — use this FIRST for any multi-step task. Output a plan before taking action:',
      '   {"decision":"PLAN","plan":["step 1","step 2",...],"thought":"overall approach",',
      '    "memory":{"goal":"<overall goal>","completed":[],"remaining":["step 1","step 2",...]}}',
      '   (Skip PLAN only for trivial single-step queries, e.g. "list my files".)',
      '',
      '2. USE_TOOL — call a tool to gather information or take action:',
      '   {"decision":"USE_TOOL","tool":"<name>","input":{<args>},"thought":"<why>",',
      '    "memory":{"goal":"<goal>","completed":[...],"remaining":[...]}}',
      '',
      '3. THINK — reason without acting (use sparingly):',
      '   {"decision":"THINK","thought":"<reasoning>",',
      '    "memory":{"goal":"<goal>","completed":[...],"remaining":[...]}}',
      '',
      '4. FINISH — deliver your final answer:',
      '   {"decision":"FINISH","response":"<complete answer>","thought":"<brief summary>"}',
      '',
      '── Rules you MUST follow ───────────────────────────────────────────────────',
      '• For multi-step tasks, start with PLAN before taking any action.',
      '• ALWAYS call read_file before write_file on the same file. Never overwrite without reading first.',
      '• Work incrementally — edit ONE file at a time. Never rewrite an entire project in one step.',
      '• Break large tasks into small sub-tasks; tackle them one by one.',
      '• After writing a file, review it (USE_TOOL read_file) before proceeding.',
      '• Use the "memory" field in every decision to track goal / completed / remaining steps.',
      '• Iterate: write → review → fix → repeat until the task is complete.',
      '• Keep file reads focused: if a file is large, note what you need from it before reading.',
      '',
      '── Available tools ─────────────────────────────────────────────────────────',
      ...availableTools.map(t => `  • ${toolDocs[t] ?? t}`),
    );
  }

  if (customSystemPrompt.trim()) {
    lines.push(`\nTask Context & Instructions:\n${customSystemPrompt.trim()}`);
  }

  return lines.join('\n');
}

export function buildSystemInstruction(
  agentName: string,
  enableWebSearch: boolean,
  isManager: boolean = false,
  spawnedAgents: AgentRef[] = [],
  isRecursive: boolean = false,
  customSystemPrompt: string = '',
  handoffAgents: AgentRef[] = [],
  isLive: boolean = false,
  isCritic: boolean = false,
): string {
  const lines: string[] = [];

  // ── Agent Self Profile ──────────────────────────────────────────────────
  // Every agent gets a clear identity card so it always knows who it is,
  // what role it plays, what tools it has, and who it can communicate with.

  if (isCritic) {
    // ── Critic identity & self profile ──
    lines.push(
      '═══ AGENT SELF PROFILE ═══',
      `Name: ${agentName}`,
      'Role: CRITIC AGENT',
      'Purpose: Review and critique work submitted by other agents or the user. Provide structured, honest, and actionable feedback to improve quality.',
      '',
      'Tools you have access to:',
      '  • read_file — read a workspace file for context',
      '  • list_files — list all files in the workspace',
      '',
      'Agents you can communicate with: You receive work via the critique_output tool invoked by a manager. You do not initiate communication with other agents.',
      '',
      'How to do your tasks:',
      '  1. Receive work submitted for review.',
      '  2. Read any relevant workspace files if needed for context.',
      '  3. Evaluate the work thoroughly and provide structured feedback.',
      '═══ END SELF PROFILE ═══',
      '',
      'Your sole responsibility is to review and critique work submitted to you.',
      'Provide structured, honest, and actionable feedback.',
      'When reviewing any output, always address:',
      '  • STRENGTHS — what is correct, well-reasoned, or well-written',
      '  • ISSUES — what is incorrect, missing, ambiguous, or poorly done',
      '  • RECOMMENDATIONS — specific, actionable steps to improve the work',
      '  • VERDICT — either "APPROVE" (work meets the standard) or "REVISE" (needs more work)',
      'Be objective and thorough. Your feedback should help the submitter improve their work.',
    );
  } else if (isManager) {
    // ── Build the manager tool list dynamically ──
    const managerTools: string[] = [
      'read_file — read a workspace file for context',
      'list_files — list all files in the workspace',
      'create_document — write reports, plans, specifications, and other documents',
      'create_folder — create subfolders in the workspace',
      'web_search — search the internet for up-to-date information',
      'list_agents — list all currently available agents with their IDs, names, and roles',
      'spawn_agent — create a new worker agent with a name and an initial task',
      'message_agent — send a message or sub-task to a worker agent and receive their response',
      'connect_agents — establish a one-way communication link between two agents for handoff',
      'critique_output — submit work to a critic agent for structured quality review',
      'rename_agent — rename an existing agent',
      'set_agent_prompt — set or update the custom system prompt of an agent',
    ];
    if (isRecursive) {
      managerTools.push('request_signoff — submit completed work to the authoriser for approval');
    }

    // Determine which agents the manager can talk to
    const agentComms: string[] = [];
    if (spawnedAgents.length > 0) {
      agentComms.push(
        `Your current worker agents: ${spawnedAgents.map(a => `${a.name} (ID: ${a.id})`).join(', ')}.`,
      );
    }
    agentComms.push(
      'You can spawn new worker agents at any time using spawn_agent.',
      'You can discover all existing agents using list_agents.',
      'You can establish pipelines between workers using connect_agents.',
    );

    // ── Manager identity & self profile ──
    lines.push(
      '═══ AGENT SELF PROFILE ═══',
      `Name: ${agentName}`,
      'Role: MANAGER AGENT',
      'Purpose: Orchestrate tasks by breaking them down, delegating every sub-task to worker agents, and synthesising the results. You are a coordinator, NOT an implementer.',
      '',
      'Tools you have access to:',
      ...managerTools.map(t => `  • ${t}`),
      '',
      'Agents you can communicate with:',
      ...agentComms.map(c => `  ${c}`),
      '',
      'How to do your tasks:',
      "  1. Call 'list_agents' to discover all currently available agents and their exact IDs.",
      "  2. Break the task into clear, well-defined sub-tasks. For each sub-task, either call 'spawn_agent' to create a specialist worker or call 'message_agent' to delegate to an existing agent.",
      "  3. Optionally, call 'rename_agent' to give an agent a more descriptive name, or 'set_agent_prompt' to configure its behaviour and instructions.",
      "  4. Optionally, call 'connect_agents' to establish a pipeline so one worker can hand its output directly to another worker.",
      "  5. Collect results from all workers via 'message_agent', synthesise the findings, and deliver a final answer or summary to the user.",
      '═══ END SELF PROFILE ═══',
      '',
      `You are ${agentName}, a MANAGER AGENT. Your sole responsibility is to ORCHESTRATE tasks by breaking them down and delegating every sub-task to worker agents.`,
      'You are a coordinator, NOT an implementer. You must NEVER write code, scripts, or implement solutions yourself — that is always the job of your worker agents.',
      'You do NOT have access to code-writing or scripting tools. Do not attempt to write code in any form.',
      'Your only permitted actions are: reading files for context, producing final summary documents, and managing your agents.',
      '',
      'You have access to the internet and can search for up-to-date information using the web_search tool. Your worker agents also have internet access when you spawn them.',
      'Use web_search to gather information, research topics, and find resources before delegating tasks to workers.',
      '',
      'CRITICAL — You MUST use your actual tool functions to take actions. When the user asks you to create, spawn, or set up an agent, you MUST call the spawn_agent tool immediately. Do NOT simply describe or narrate what you would do — execute the tool call.',
      '',
      'Rules you must always follow:',
      '  • NEVER write or generate code, Python scripts, shell commands, or any implementation yourself.',
      '  • NEVER use write_file, build_tool, or propose_python_script — you do not have these tools.',
      '  • ALWAYS delegate implementation, data processing, file writing, and computation to worker agents.',
      '  • When asked to create or spawn agents, ALWAYS call the spawn_agent tool. Never just describe the agent creation — actually do it.',
      '  • ALL file paths MUST be relative to the workspace root. NEVER use absolute paths, drive letters (e.g. "C:/"), or user-specific paths (e.g. "Users/…/Desktop/").',
      '  • Keep your own responses to coordination decisions, task breakdowns, and final summaries only.',
      '  • Format your final response with clear Markdown sections (## headings, bullet lists). Never paste raw code blocks or script output from workers — describe results in your own words.',
      '  • When presenting results: open with a brief executive summary, then list what each worker produced, then give your synthesis and recommendations.',
      '  • IMPORTANT: Do NOT narrate or describe tool calls in your text responses. Use the actual tool functions provided to you. Your text responses should only contain summaries, plans, and results — not instructions to "call" tools.',
    );
    if (spawnedAgents.length > 0) {
      lines.push(
        `Your current worker agents (use these IDs with message_agent): ${spawnedAgents.map(a => `${a.name} (ID: ${a.id})`).join(', ')}.`,
      );
    } else {
      lines.push(
        "You have no worker agents yet. Use 'spawn_agent' to create new worker agents, or call 'list_agents' to see any existing agents.",
      );
    }
  } else {
    // ── Worker / authoriser identity & self profile ──
    const workerTools: string[] = [
      'read_file — read a workspace file',
      'write_file — write text to a workspace file',
      'list_files — list all files in the workspace',
      'create_document — write reports, plans, specifications, and other documents',
      'build_tool — create reusable Python utilities or scripts',
      'propose_python_script — propose a Python script for complex automation',
      'create_folder — create subfolders in the workspace',
      'write_document — write .txt, .docx, or .pdf files to the workspace',
    ];
    if (enableWebSearch) {
      workerTools.push('web_search — search the internet for current information');
    }
    if (handoffAgents.length > 0) {
      workerTools.push('handoff_to_agent — pass completed work to another agent in the pipeline');
    }

    const workerComms: string[] = [];
    if (handoffAgents.length > 0) {
      workerComms.push(
        `Available agents for handoff: ${handoffAgents.map(a => `${a.name} (ID: ${a.id})`).join(', ')}.`,
      );
    } else {
      workerComms.push('You do not currently have direct links to other agents. A manager may connect you to other agents later.');
    }

    const workerHowTo: string[] = [
      '  1. Think step-by-step and choose the right tool for each sub-task.',
      '  2. Read existing files before modifying them.',
      '  3. Work incrementally — edit one file at a time.',
      '  4. Produce high-quality, actionable output.',
    ];
    if (handoffAgents.length > 0) {
      workerHowTo.push('  5. When your part is complete, use handoff_to_agent to pass work to the next agent.');
    }

    lines.push(
      '═══ AGENT SELF PROFILE ═══',
      `Name: ${agentName}`,
      `Role: ${agentName.toLowerCase().includes('authoriser') ? 'AUTHORISER AGENT' : 'WORKER AGENT'}`,
      'Purpose: Help users think through problems, write code, create documents, build tools, and accomplish real-world tasks end-to-end.',
      '',
      'Tools you have access to:',
      ...workerTools.map(t => `  • ${t}`),
      '',
      'Agents you can communicate with:',
      ...workerComms.map(c => `  ${c}`),
      '',
      'How to do your tasks:',
      ...workerHowTo,
      '═══ END SELF PROFILE ═══',
      '',
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
      'Use \'write_document\' to write .txt, .docx (Word), or .pdf files to the workspace.',
      'Use \'create_folder\' to create subfolders (e.g., "reports/2024") before writing files into them.',
      'File paths support subfolders: write to "reports/summary.txt" instead of just "summary.txt".',
      'IMPORTANT: ALL file paths MUST be relative to the workspace root. NEVER use absolute paths, drive letters (e.g. "C:/"), or user-specific paths (e.g. "Users/…/Desktop/"). Only use simple relative paths like "report.txt" or "docs/summary.md".',
      'IMPORTANT: Do NOT narrate or describe tool calls in your text responses. Use the actual tool functions to perform actions. Your text responses should contain explanations, results, and summaries only.',
    );
  }

  if (enableWebSearch && !isManager) {
    lines.push("You can search the internet for current information using the 'web_search' tool.");
  }

  if (isManager && isRecursive) {
    lines.push(
      'You are also a RECURSIVE MANAGER. Keep working autonomously until the task is fully complete.',
      "When you believe the task is done, call 'request_signoff' with a detailed summary of the work and results.",
      'If the authoriser REJECTS your work, carefully analyse their feedback and continue working to address every point.',
      'Keep iterating — spawning more agents, gathering more information, revising outputs — until you receive APPROVED status.',
    );
  }

  if (isManager && isLive) {
    lines.push(
      '',
      'You are a LIVE AUTONOMOUS AGENT. You run continuously in the background while active.',
      'When you receive a "[Live Mode]" continuation prompt, check on your team, process outstanding work, and report status.',
      'If there is genuinely nothing left to do right now, respond with exactly "IDLE" on the first line so the system can back off and check again later.',
      'Otherwise, take action: spawn new workers, message existing ones, search the internet, or synthesise results.',
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
    onListAgents,
    onConnectAgents,
    onRenameAgent,
    onSetAgentPrompt,
    customSystemPrompt = '',
    isRecursive = false,
    onRequestSignoff,
    handoffAgents = [],
    onHandoffToAgent,
    onAutoRunScript,
    isLive = false,
    isCritic = false,
    onCritiqueOutput,
    onEpisodicMemory,
  } = options;

  const systemInstruction = buildSystemInstruction(
    agentName,
    enableWebSearch,
    isManager,
    spawnedAgents,
    isRecursive,
    customSystemPrompt,
    handoffAgents,
    isLive,
    isCritic,
  );

  // ── Ollama path (ReAct loop with optional tool execution) ─────────────────
  if (provider === 'ollama') {
    // Determine which text-based tools are available for the ReAct loop
    const ollamaTools: string[] = [];
    if (dirHandle) {
      ollamaTools.push('read_file', 'write_file', 'list_files');
    }
    if (enableWebSearch) ollamaTools.push('web_search');
    if (!isManager && handoffAgents.length > 0 && onHandoffToAgent) {
      ollamaTools.push('handoff_to_agent');
    }

    const ollamaSystemPrompt = buildOllamaSystemInstruction(
      agentName,
      isManager,
      customSystemPrompt,
      isCritic,
      ollamaTools,
    );

    const baseMessages = chatHistory
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }));

    // No tools: plain chat response
    if (ollamaTools.length === 0) {
      const messages = [...baseMessages, { role: 'user', content: prompt }];
      onLog(`Using Ollama model: ${modelId}`);
      const text = await ollamaChat(modelId, messages, ollamaSystemPrompt);
      return { role: 'assistant', content: text };
    }

    // With tools: ReAct loop
    onLog(`Using Ollama model: ${modelId} (ReAct mode)`);
    const reActMessages = [...baseMessages, { role: 'user', content: prompt }];
    const MAX_REACT_STEPS = 15;

    // Accumulated task memory across steps (goal / completed / remaining)
    let taskMemory: { goal: string; completed: string[]; remaining: string[] } = {
      goal: '',
      completed: [],
      remaining: [],
    };

    for (let step = 0; step < MAX_REACT_STEPS; step++) {
      const rawText = await ollamaChat(modelId, reActMessages, ollamaSystemPrompt);
      const decision = parseOllamaReActDecision(rawText);

      // No valid decision object — treat entire response as final answer
      if (!decision) {
        return { role: 'assistant', content: rawText };
      }

      // Merge any memory update carried in the decision
      if (decision.memory) {
        if (decision.memory.goal)      taskMemory.goal      = decision.memory.goal;
        if (decision.memory.completed) taskMemory.completed = decision.memory.completed;
        if (decision.memory.remaining) taskMemory.remaining = decision.memory.remaining;
      }

      if (decision.decision === 'FINISH') {
        return { role: 'assistant', content: decision.response ?? rawText };
      }

      if (decision.decision === 'PLAN') {
        const steps = (decision.plan ?? []).join('; ') || (decision.thought ?? '');
        onLog(`[Ollama] Plan: ${steps}`);
        reActMessages.push({ role: 'assistant', content: rawText });
        const memoryNote = formatTaskMemoryNote(taskMemory);
        const remainingHint = taskMemory.remaining.length > 0
          ? ` Remaining steps: ${taskMemory.remaining.join(', ')}.`
          : '';
        reActMessages.push({
          role: 'user',
          content: `Plan acknowledged.${remainingHint} Proceed with step 1 now — start with read_file or list_files if you need workspace context.${memoryNote}`,
        });
        continue;
      }

      if (decision.decision === 'THINK') {
        onLog(`[Ollama] Thinking: ${decision.thought ?? ''}`);
        reActMessages.push({ role: 'assistant', content: rawText });
        reActMessages.push({ role: 'user', content: 'Continue based on your reasoning above.' });
        continue;
      }

      if (decision.decision === 'USE_TOOL') {
        const toolName = decision.tool ?? '';
        const toolInput = decision.input ?? {};
        onLog(`[Ollama] Using tool: ${toolName}`);
        reActMessages.push({ role: 'assistant', content: rawText });

        let toolResult = '';
        try {
          if (toolName === 'read_file') {
            if (!dirHandle) throw new Error('No workspace folder selected.');
            const content = await readFile(dirHandle, toolInput.filename as string);
            const preview = content.substring(0, 2000) + (content.length > 2000 ? '... (truncated)' : '');
            toolResult = `File contents of "${toolInput.filename}":\n${preview}`;
            onEpisodicMemory?.(`Read file: ${toolInput.filename}`);
          } else if (toolName === 'write_file') {
            if (!dirHandle) throw new Error('No workspace folder selected.');
            await writeFile(dirHandle, toolInput.filename as string, toolInput.content as string);
            toolResult = `Successfully wrote to "${toolInput.filename}".`;
            onEpisodicMemory?.(`Wrote file: ${toolInput.filename}`);
          } else if (toolName === 'list_files') {
            if (!dirHandle) throw new Error('No workspace folder selected.');
            const files = await listFiles(dirHandle);
            toolResult = files.length > 0
              ? `Workspace files:\n${files.map(f => `  • ${f}`).join('\n')}`
              : 'Workspace is empty.';
          } else if (toolName === 'web_search') {
            const sr = await webSearch(toolInput.query as string);
            const resultLines: string[] = [];
            if (sr.abstract) resultLines.push(`Summary: ${sr.abstract}`);
            for (const r of sr.results) {
              resultLines.push(`- ${r.title}\n  ${r.snippet}\n  URL: ${r.url}`);
            }
            toolResult = resultLines.join('\n') || 'No results found.';
          } else if (toolName === 'handoff_to_agent' && onHandoffToAgent) {
            const reply = await onHandoffToAgent(
              toolInput.agentId as string,
              toolInput.message as string,
            );
            toolResult = `Agent ${toolInput.agentId} responded: ${reply}`;
          } else {
            toolResult = `Unknown tool: "${toolName}". Available: ${ollamaTools.join(', ')}.`;
          }
        } catch (e: any) {
          toolResult = `Tool "${toolName}" failed: ${e.message}`;
        }

        // Build a continuation prompt that includes the current task-memory state
        reActMessages.push({
          role: 'user',
          content: `Tool result for ${toolName}: ${toolResult}\n\nContinue with your task.${formatTaskMemoryNote(taskMemory)}`,
        });
      }
    }

    // Exceeded max steps — ask for a final answer
    onLog('[Ollama] Max ReAct steps reached. Requesting final answer.');
    reActMessages.push({ role: 'user', content: 'You have reached the maximum number of steps. Provide your final answer now using {"decision":"FINISH","response":"<answer>","thought":"..."}.' });
    const finalText = await ollamaChat(modelId, reActMessages, ollamaSystemPrompt);
    const finalDecision = parseOllamaReActDecision(finalText);
    return { role: 'assistant', content: finalDecision?.response ?? finalText };
  }

  // ── Gemini path (with tool calling) ──────────────────────────────────────
  const ai = getAiClient();
  const tools = [
    // Managers get a restricted base tool set (no code-writing tools).
    // Workers get the full base tool set.
    // Critics get only read-only tools (read_file, list_files).
    ...(isCritic
      ? [readFileTool, listFilesTool]
      : isManager ? managerBaseToolDeclarations : baseToolDeclarations),
    ...(enableWebSearch ? [webSearchTool] : []),
    ...(isManager && !isCritic ? managerToolDeclarations : []),
    ...(isManager && isRecursive && !isCritic ? [requestSignoffTool] : []),
    ...(!isManager && !isCritic && handoffAgents.length > 0 && onHandoffToAgent ? [handoffAgentTool] : []),
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
  // Safety guard: prevent unbounded tool-call loops
  const MAX_TOOL_ITERATIONS = 30;
  let toolIterationCount = 0;

  // Handle tool calls in a loop
  while (response.functionCalls && response.functionCalls.length > 0 && !taskApproved) {
    toolIterationCount++;
    if (toolIterationCount > MAX_TOOL_ITERATIONS) {
      onLog('Warning: Maximum tool iteration limit reached. Stopping to avoid infinite loop.');
      break;
    }
    const call = response.functionCalls[0];
    onLog(`AI called tool: ${call.name}`);

    if (call.name === 'read_file') {
      try {
        if (!dirHandle) throw new Error('No workspace folder selected. Ask the user to open a folder first.');
        const content = await readFile(dirHandle, call.args.filename as string);
        const preview =
          content.substring(0, 2000) + (content.length > 2000 ? '... (truncated)' : '');
        onEpisodicMemory?.(`Read file: ${call.args.filename}`);
        response = await chat.sendMessage({ message: `Tool read_file result: ${preview}` });
      } catch (e: any) {
        response = await chat.sendMessage({ message: `Tool read_file failed: ${e.message}` });
      }
    } else if (call.name === 'list_files') {
      try {
        if (!dirHandle) throw new Error('No workspace folder selected. Ask the user to open a folder first.');
        const files = await listFiles(dirHandle);
        const fileList = files.length > 0
          ? files.map(f => `  • ${f}`).join('\n')
          : '(empty workspace)';
        response = await chat.sendMessage({
          message: `Tool list_files result:\n${fileList}`,
        });
      } catch (e: any) {
        response = await chat.sendMessage({ message: `Tool list_files failed: ${e.message}` });
      }
    } else if (call.name === 'write_file') {
      try {
        if (!dirHandle) throw new Error('No workspace folder selected. Ask the user to open a folder first.');
        await writeFile(dirHandle, call.args.filename as string, call.args.content as string);
        onEpisodicMemory?.(`Wrote file: ${call.args.filename}`);
        response = await chat.sendMessage({ message: 'Tool write_file succeeded.' });
      } catch (e: any) {
        response = await chat.sendMessage({ message: `Tool write_file failed: ${e.message}` });
      }
    } else if (call.name === 'create_document') {
      try {
        if (!dirHandle) throw new Error('No workspace folder selected. Ask the user to open a folder first.');
        await writeFile(dirHandle, call.args.filename as string, call.args.content as string);
        const docType = (call.args.document_type as string) || 'document';
        onLog(`Document created: ${call.args.filename} (${docType})`);
        onEpisodicMemory?.(`Created document: ${call.args.filename}`);
        response = await chat.sendMessage({
          message: `Tool create_document succeeded. ${docType} saved as "${call.args.filename}".`,
        });
      } catch (e: any) {
        response = await chat.sendMessage({ message: `Tool create_document failed: ${e.message}` });
      }
    } else if (call.name === 'build_tool') {
      try {
        if (!dirHandle) throw new Error('No workspace folder selected. Ask the user to open a folder first.');
        const toolFilename = `${call.args.tool_name as string}.py`;
        const header = `# Tool: ${call.args.tool_name as string}\n# ${call.args.description as string}\n\n`;
        await writeFile(dirHandle, toolFilename, header + (call.args.script as string));
        onLog(`Tool built: ${toolFilename}`);
        onEpisodicMemory?.(`Built tool: ${toolFilename}`);
        response = await chat.sendMessage({
          message:
            `Tool build_tool succeeded. Python tool saved as "${toolFilename}". ` +
            'Other agents can use it via propose_python_script.',
        });
      } catch (e: any) {
        response = await chat.sendMessage({ message: `Tool build_tool failed: ${e.message}` });
      }
    } else if (call.name === 'create_folder') {
      try {
        if (!dirHandle) throw new Error('No workspace folder selected. Ask the user to open a folder first.');
        const { createFolder } = await import('./fs');
        await createFolder(dirHandle, call.args.folder_path as string);
        onLog(`Folder created: ${call.args.folder_path}`);
        response = await chat.sendMessage({
          message: `Tool create_folder succeeded. Folder "${call.args.folder_path}" is ready.`,
        });
      } catch (e: any) {
        response = await chat.sendMessage({ message: `Tool create_folder failed: ${e.message}` });
      }
    } else if (call.name === 'write_document') {
      const fmt = ((call.args.format as string) ?? 'txt').toLowerCase();
      const filename = call.args.filename as string;
      const content = call.args.content as string;
      try {
        if (!dirHandle) throw new Error('No workspace folder selected. Ask the user to open a folder first.');
        if (fmt === 'txt') {
          await writeFile(dirHandle, filename, content);
          onLog(`Document written: ${filename} (txt)`);
          response = await chat.sendMessage({
            message: `Tool write_document succeeded. Text document saved as "${filename}".`,
          });
        } else if (fmt === 'docx') {
          const script = buildDocxScript(filename, content);
          if (onAutoRunScript) {
            const result = await onAutoRunScript(script);
            onLog(`Document written: ${filename} (docx)`);
            response = await chat.sendMessage({
              message: `Tool write_document succeeded. Word document saved as "${filename}". ${result}`,
            });
          } else {
            onProposeScript(script, `Create Word document: ${filename}`);
            response = await chat.sendMessage({
              message: `Tool write_document: Python script proposed to create Word document "${filename}". The user must run it.`,
            });
          }
        } else if (fmt === 'pdf') {
          const script = buildPdfScript(filename, content);
          if (onAutoRunScript) {
            const result = await onAutoRunScript(script);
            onLog(`Document written: ${filename} (pdf)`);
            response = await chat.sendMessage({
              message: `Tool write_document succeeded. PDF document saved as "${filename}". ${result}`,
            });
          } else {
            onProposeScript(script, `Create PDF document: ${filename}`);
            response = await chat.sendMessage({
              message: `Tool write_document: Python script proposed to create PDF "${filename}". The user must run it.`,
            });
          }
        } else {
          response = await chat.sendMessage({
            message: `Tool write_document failed: unknown format "${fmt}". Supported: txt, docx, pdf.`,
          });
        }
      } catch (e: any) {
        response = await chat.sendMessage({ message: `Tool write_document failed: ${e.message}` });
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
          const spawnMsg = newAgent.initialResponse
            ? `spawn_agent succeeded. Agent "${newAgent.name}" (ID: ${newAgent.id}) has been created and has already completed its initial task. Worker response:\n${newAgent.initialResponse}\nUse message_agent with this ID if you need to send follow-up instructions.`
            : `spawn_agent succeeded. New agent "${newAgent.name}" created with ID: ${newAgent.id}. Use message_agent with this ID to communicate with it.`;
          response = await chat.sendMessage({ message: spawnMsg });
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
    } else if (call.name === 'list_agents') {
      try {
        const agentList = onListAgents ? await onListAgents() : [];
        const listStr =
          agentList.length > 0
            ? agentList
                .map(a => `- ${a.name} | ID: ${a.id} | role: ${a.role ?? 'worker'}`)
                .join('\n')
            : 'No agents available.';
        onLog('Manager listed available agents.');
        response = await chat.sendMessage({
          message: `list_agents result (use these IDs with message_agent / connect_agents):\n${listStr}`,
        });
      } catch (e: any) {
        response = await chat.sendMessage({ message: `list_agents failed: ${e.message}` });
      }
    } else if (call.name === 'connect_agents') {
      if (!onConnectAgents) {
        response = await chat.sendMessage({ message: 'connect_agents is not available in this context.' });
      } else {
        try {
          onLog(`Manager connecting agents: ${call.args.fromAgentId} → ${call.args.toAgentId}`);
          const result = await onConnectAgents(
            call.args.fromAgentId as string,
            call.args.toAgentId as string,
          );
          response = await chat.sendMessage({ message: `connect_agents result: ${result}` });
        } catch (e: any) {
          response = await chat.sendMessage({ message: `connect_agents failed: ${e.message}` });
        }
      }
    } else if (call.name === 'rename_agent') {
      if (!onRenameAgent) {
        response = await chat.sendMessage({ message: 'rename_agent is not available in this context.' });
      } else {
        try {
          onLog(`Manager renaming agent ${call.args.agentId} to "${call.args.newName}"`);
          const result = await onRenameAgent(
            call.args.agentId as string,
            call.args.newName as string,
          );
          response = await chat.sendMessage({ message: `rename_agent result: ${result}` });
        } catch (e: any) {
          response = await chat.sendMessage({ message: `rename_agent failed: ${e.message}` });
        }
      }
    } else if (call.name === 'set_agent_prompt') {
      if (!onSetAgentPrompt) {
        response = await chat.sendMessage({ message: 'set_agent_prompt is not available in this context.' });
      } else {
        try {
          onLog(`Manager setting system prompt for agent ${call.args.agentId}`);
          const result = await onSetAgentPrompt(
            call.args.agentId as string,
            call.args.prompt as string,
          );
          response = await chat.sendMessage({ message: `set_agent_prompt result: ${result}` });
        } catch (e: any) {
          response = await chat.sendMessage({ message: `set_agent_prompt failed: ${e.message}` });
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
    } else if (call.name === 'critique_output') {
      if (!onCritiqueOutput) {
        response = await chat.sendMessage({
          message: 'critique_output is not available — no critic agent is configured.',
        });
      } else {
        try {
          onLog('Sending output to critic agent for review…');
          const feedback = await onCritiqueOutput(call.args.output as string);
          onEpisodicMemory?.('Critic reviewed output');
          response = await chat.sendMessage({
            message: `critique_output result:\n${feedback}`,
          });
        } catch (e: any) {
          response = await chat.sendMessage({ message: `critique_output failed: ${e.message}` });
        }
      }
    } else {
      // Unknown tool – break to avoid infinite loop
      break;
    }
  }

  return { role: 'assistant', content: response.text ?? '' };
}
