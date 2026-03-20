import React, { useState, useEffect, useRef, useCallback } from 'react';
import Markdown from 'react-markdown';
import {
  FolderOpen, FileText, Send, Play, Terminal, CheckCircle2,
  AlertCircle, Plus, X, Edit2, Globe, ChevronDown, Download, Settings,
  Network, Crown, Shield, RefreshCw, MessageSquare, Power, Eye,
} from 'lucide-react';
import { pickDirectory, listFiles, writeBinaryFile, base64ToBytes, readFile as readFileFs, writeFile as writeFileFs, createFolder as createFolderFs } from './lib/fs';
import { initPython, runPythonScript } from './lib/python';
import { processChatTurn } from './lib/ai';
import type { AgentRef } from './lib/ai';
import {
  listOllamaModels, pullOllamaModel, testOllamaConnection,
  getOllamaUrl, setOllamaUrl,
  getGeminiApiKey, setGeminiApiKey,
  DEFAULT_GEMINI_MODELS, POPULAR_OLLAMA_MODELS,
  type Model, type ModelProvider,
} from './lib/models';
import AgentGraph, { type MessageLink } from './components/AgentGraph';

// ── Electron IPC bridge types ─────────────────────────────────────────────────

declare global {
  interface Window {
    /**
     * Exposed by electron/preload.ts via contextBridge.
     * Only present when the app is running inside Electron.
     */
    ollamaSetup?: {
      /** Returns true when the Ollama binary is found on this machine. */
      checkInstalled: () => Promise<boolean>;
      /** Download and open the platform-appropriate Ollama installer. */
      install: () => Promise<{ success: boolean; error?: string }>;
      /**
       * Subscribe to installer-download progress messages.
       * Returns an unsubscribe function.
       */
      onProgress: (callback: (msg: string) => void) => () => void;
      /** e.g. "darwin", "win32", "linux" */
      platform: string;
    };
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Message = { role: 'user' | 'assistant' | 'system'; content: string };

interface Agent {
  id: string;
  name: string;
  /** Manager agents can spawn workers and delegate tasks to them. */
  role: 'manager' | 'worker' | 'authoriser' | 'critic';
  /** ID of the manager that spawned this agent, or null for root agents. */
  parentId: string | null;
  modelId: string;
  provider: ModelProvider;
  enableWebSearch: boolean;
  messages: Message[];
  dirHandle: FileSystemDirectoryHandle | null;
  files: string[];
  terminalLogs: string[];
  proposedScript: { code: string; explanation: string } | null;
  isLoading: boolean;
  input: string;
  /** Custom user-defined task framing / system prompt for this agent. */
  systemPrompt: string;
  /** When true (manager only), agent keeps working until authoriser approves. */
  recursive: boolean;
  /** When true (manager only), the agent runs autonomously in a live loop. */
  isLive: boolean;
  /**
   * Ordered log of completed steps recorded during task execution (episodic memory).
   * Populated automatically as the agent reads/writes files, spawns workers, etc.
   */
  episodicMemory: string[];
}

let agentCounter = 1;

/** Maximum number of workers a single manager is allowed to spawn. */
const MAX_SPAWNED_AGENTS = 10;

/** Truncate a string to maxLength characters, appending '…' if truncated. */
function truncateText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.substring(0, maxLength)}…` : text;
}

function createAgent(name?: string, role: Agent['role'] = 'worker', parentId: string | null = null): Agent {
  return {
    id: crypto.randomUUID(),
    name: name ?? `Agent ${agentCounter++}`,
    role,
    parentId,
    modelId: 'gemini-3.1-pro-preview',
    provider: 'gemini',
    enableWebSearch: role === 'manager',
    messages: [
      {
        role: 'assistant',
        content:
          role === 'manager'
            ? 'Hello! I am your Manager Agent. I can create and coordinate worker agents, break down tasks, delegate work, and search the internet. Set me to **Live** mode to run autonomously, or send me a task to get started.'
            : role === 'critic'
            ? 'Hello! I am your Critic Agent. Submit work to me via the **critique_output** tool (from a manager) and I will provide structured feedback with strengths, issues, and recommendations.'
            : 'Hello! I am your Local AI Assistant. Please select a workspace folder to get started.',
      },
    ],
    dirHandle: null,
    files: [],
    terminalLogs: [],
    proposedScript: null,
    isLoading: false,
    input: '',
    systemPrompt: '',
    recursive: false,
    isLive: false,
    episodicMemory: [],
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function App() {
  const initialAgent = createAgent(undefined, 'worker', null);
  const [agents, setAgents] = useState<Agent[]>([initialAgent]);
  const [activeAgentId, setActiveAgentId] = useState<string>(initialAgent.id);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTabName, setEditingTabName] = useState('');
  const [ollamaModels, setOllamaModels] = useState<Model[]>([]);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);
  const [downloadStatus, setDownloadStatus] = useState('');
  const [pyodideInstance, setPyodideInstance] = useState<any>(null);
  /** Communication links recorded during manager ↔ worker interactions. */
  const [messageLinks, setMessageLinks] = useState<MessageLink[]>([]);
  /**
   * Authorized communication channels set up by managers via connect_agents or by drawing
   * links in the graph. Only agents with an authorized link can use handoff_to_agent to
   * communicate with each other.
   */
  const [connectedLinks, setConnectedLinks] = useState<{ fromId: string; toId: string }[]>([]);
  /** Always-current reference to connectedLinks for use in async callbacks. */
  const connectedLinksRef = useRef<{ fromId: string; toId: string }[]>([]);
  useEffect(() => { connectedLinksRef.current = connectedLinks; }, [connectedLinks]);
  /** Toggle between the chat view and the agent-topology graph view. */
  const [showGraphView, setShowGraphView] = useState(false);
  /** System prompt editor modal state. */
  const [showPromptModal, setShowPromptModal] = useState(false);
  const [promptDraft, setPromptDraft] = useState('');

  // Ollama settings
  const [showSettings, setShowSettings] = useState(false);
  const [ollamaUrlInput, setOllamaUrlInput] = useState(getOllamaUrl);
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');

  // Gemini API key
  const [geminiApiKeyInput, setGeminiApiKeyInput] = useState(getGeminiApiKey);

  // First-run Ollama setup (Electron only)
  const OLLAMA_SETUP_DISMISSED_KEY = 'ollamaSetupDismissed';
  const [showOllamaSetup, setShowOllamaSetup] = useState(false);
  const [ollamaInstallStatus, setOllamaInstallStatus] = useState<
    'idle' | 'downloading' | 'done' | 'error'
  >('idle');
  const [ollamaInstallProgress, setOllamaInstallProgress] = useState('');

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const tabInputRef = useRef<HTMLInputElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  /**
   * Always-current reference to agents used in async callbacks where the React
   * closure would otherwise capture a stale value.
   */
  const agentsRef = useRef<Agent[]>(agents);
  useEffect(() => { agentsRef.current = agents; }, [agents]);

  const activeAgent = agents.find(a => a.id === activeAgentId) ?? agents[0];

  // Probe for available Ollama models once on mount
  useEffect(() => {
    listOllamaModels().then(models => setOllamaModels(models));
  }, []);

  // First-run Ollama setup check (Electron only, shown at most once)
  useEffect(() => {
    if (!window.ollamaSetup) return;
    if (localStorage.getItem(OLLAMA_SETUP_DISMISSED_KEY)) return;
    window.ollamaSetup.checkInstalled()
      .then(installed => { if (!installed) setShowOllamaSetup(true); })
      .catch(err => console.warn('[OllamaSetup] checkInstalled failed:', err));
    // OLLAMA_SETUP_DISMISSED_KEY is a module-level constant; safe to omit from deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scroll to bottom when active agent's messages/logs change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeAgent?.messages, activeAgent?.terminalLogs]);

  // Auto-focus the rename input
  useEffect(() => {
    if (editingTabId && tabInputRef.current) {
      tabInputRef.current.focus();
      tabInputRef.current.select();
    }
  }, [editingTabId]);

  // Close model picker when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) {
        setShowModelPicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const updateAgent = useCallback((id: string, updates: Partial<Agent>) => {
    setAgents(prev => prev.map(a => (a.id === id ? { ...a, ...updates } : a)));
  }, []);

  /** Timers driving the autonomous live-agent loop (one per live manager). */
  const liveTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  /**
   * Consecutive idle ticks per agent. When a live manager has nothing to do it
   * says "IDLE" and we back off exponentially to avoid wasting API calls.
   */
  const idleCountRef = useRef<Map<string, number>>(new Map());

  // ── Agent tab management ────────────────────────────────────────────────────

  const addAgent = () => {
    const agent = createAgent();
    setAgents(prev => [...prev, agent]);
    setActiveAgentId(agent.id);
    setShowGraphView(false);
  };

  const addManager = () => {
    const agent = createAgent(undefined, 'manager', null);
    setAgents(prev => [...prev, agent]);
    setActiveAgentId(agent.id);
    setShowGraphView(false);
  };

  const addAuthoriser = () => {
    const agent = createAgent(undefined, 'authoriser', null);
    setAgents(prev => [...prev, agent]);
    setActiveAgentId(agent.id);
    setShowGraphView(false);
  };

  const addCritic = () => {
    const agent = createAgent(undefined, 'critic', null);
    setAgents(prev => [...prev, agent]);
    setActiveAgentId(agent.id);
    setShowGraphView(false);
  };

  const removeAgent = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setAgents(prev => {
      const filtered = prev.filter(a => a.id !== id);
      if (filtered.length === 0) {
        const newAgent = createAgent();
        setActiveAgentId(newAgent.id);
        return [newAgent];
      }
      if (activeAgentId === id) {
        setActiveAgentId(filtered[0].id);
      }
      return filtered;
    });
    // Remove message links and authorized connections involving this agent
    setMessageLinks(prev => prev.filter(l => l.fromId !== id && l.toId !== id));
    setConnectedLinks(prev => prev.filter(l => l.fromId !== id && l.toId !== id));
  };

  const startRenameTab = (agent: Agent) => {
    setEditingTabId(agent.id);
    setEditingTabName(agent.name);
  };

  const commitRenameTab = () => {
    if (editingTabId && editingTabName.trim()) {
      updateAgent(editingTabId, { name: editingTabName.trim() });
    }
    setEditingTabId(null);
  };

  // ── Prompt editor ────────────────────────────────────────────────────────────

  const handleOpenPromptEditor = (agentId?: string) => {
    const agent = agentsRef.current.find(a => a.id === (agentId ?? activeAgent.id));
    setPromptDraft(agent?.systemPrompt ?? '');
    setShowPromptModal(true);
  };

  const handleSavePrompt = () => {
    updateAgent(activeAgent.id, { systemPrompt: promptDraft });
    setShowPromptModal(false);
  };

  // ── Graph connection handlers ────────────────────────────────────────────────

  /** Create a manual message link between two agents in the graph. */
  const handleCreateLink = (fromId: string, toId: string) => {
    setMessageLinks(prev => {
      const exists = prev.some(l => l.fromId === fromId && l.toId === toId);
      if (exists) return prev;
      return [...prev, { fromId, toId, messageCount: 0, lastMessage: '', messages: [] }];
    });
    // A user-drawn graph link also authorizes communication in that direction
    setConnectedLinks(prev => {
      const exists = prev.some(l => l.fromId === fromId && l.toId === toId);
      if (exists) return prev;
      return [...prev, { fromId, toId }];
    });
  };

  /** Set the parent-child hierarchy between two agents. */
  const handleSetParent = (childId: string, parentId: string) => {
    if (childId === parentId) return;
    updateAgent(childId, { parentId });
  };

  /** Remove an agent's parent, making it a root node. */
  const handleRemoveParent = (agentId: string) => {
    updateAgent(agentId, { parentId: null });
  };

  // ── Workspace / files ───────────────────────────────────────────────────────

  const handleOpenFolder = async (agentId: string) => {
    try {
      const handle = await pickDirectory();
      const fileList = await listFiles(handle);
      setAgents(prev =>
        prev.map(a =>
          a.id === agentId
            ? {
                ...a,
                dirHandle: handle,
                files: fileList,
                messages: [
                  ...a.messages,
                  {
                    role: 'system' as const,
                    content: `Workspace connected: "${handle.name}". Found ${fileList.length} file(s).`,
                  },
                ],
              }
            : a,
        ),
      );
    } catch (err) {
      console.error(err);
    }
  };

  const refreshFiles = async (agentId: string) => {
    const agent = agentsRef.current.find(a => a.id === agentId);
    if (agent?.dirHandle) {
      const fileList = await listFiles(agent.dirHandle);
      updateAgent(agentId, { files: fileList });
    }
  };

  // ── Manager callbacks ───────────────────────────────────────────────────────

  /**
   * Called when a manager agent uses the spawn_agent tool.
   * Creates a new worker agent parented to managerId, immediately executes the
   * initial task, and returns the worker's ref including its initial response.
   * This ensures the manager gets real results back from spawn_agent without
   * needing a separate message_agent call to kick off the work.
   */
  const buildSpawnAgentCallback = (managerId: string) =>
    async (name: string, task: string): Promise<AgentRef> => {
      const managerAgent = agentsRef.current.find(a => a.id === managerId);

      // Chaos prevention: limit the number of workers a manager can spawn
      const existingWorkers = agentsRef.current.filter(a => a.parentId === managerId);
      if (existingWorkers.length >= MAX_SPAWNED_AGENTS) {
        throw new Error(
          `Maximum agent limit (${MAX_SPAWNED_AGENTS}) reached. Cannot spawn more agents.`,
        );
      }

      const newWorker = createAgent(name, 'worker', managerId);
      // Inherit model, provider, and workspace from manager so the worker
      // has the same capabilities (tool calling, API keys, etc.).
      if (managerAgent) {
        newWorker.modelId = managerAgent.modelId;
        newWorker.provider = managerAgent.provider;
        newWorker.enableWebSearch = managerAgent.enableWebSearch;
        if (managerAgent.dirHandle) {
          newWorker.dirHandle = managerAgent.dirHandle;
          newWorker.files = managerAgent.files;
        }
      }
      setAgents(prev => [...prev, newWorker]);
      // Notify the manager's chat thread that an agent was spawned
      setAgents(prev =>
        prev.map(a =>
          a.id === managerId
            ? {
                ...a,
                messages: [
                  ...a.messages,
                  {
                    role: 'system' as const,
                    content: `⚙ Spawned worker agent: **${newWorker.name}** (ID: ${newWorker.id})`,
                  },
                ],
              }
            : a,
        ),
      );
      // Record spawn in manager's episodic memory
      appendEpisodicMemory(managerId, `Spawned worker "${newWorker.name}" for task: ${truncateText(task, 80)}`);
      // Record spawn link
      setMessageLinks(prev => [
        ...prev,
        { fromId: managerId, toId: newWorker.id, messageCount: 0, lastMessage: task, messages: [{ sender: managerAgent?.name ?? 'Manager', content: task }] },
      ]);
      // Automatically authorize bidirectional communication so the worker can
      // message the manager back via handoff_to_agent.
      setConnectedLinks(prev => {
        const links = [...prev];
        if (!links.some(l => l.fromId === newWorker.id && l.toId === managerId)) {
          links.push({ fromId: newWorker.id, toId: managerId });
        }
        if (!links.some(l => l.fromId === managerId && l.toId === newWorker.id)) {
          links.push({ fromId: managerId, toId: newWorker.id });
        }
        return links;
      });

      // Immediately execute the initial task so the manager receives real results.
      setAgents(prev =>
        prev.map(a => a.id === newWorker.id ? { ...a, isLoading: true } : a),
      );
      const workerLog = (msg: string) =>
        setAgents(prev =>
          prev.map(a =>
            a.id === newWorker.id ? { ...a, terminalLogs: [...a.terminalLogs, msg] } : a,
          ),
        );

      let initialResponse: string | undefined;
      // Build a context-rich system prompt that tells the worker it was delegated by a manager
      const managerContextPrompt = [
        newWorker.systemPrompt,
        `You have been assigned this task by manager agent "${managerAgent?.name ?? 'manager'}". Complete it fully and autonomously.`,
      ].filter(Boolean).join('\n\n');
      // The worker can hand results back to the manager
      const workerHandoffTargets: AgentRef[] = managerAgent
        ? [{ id: managerId, name: managerAgent.name }]
        : [];
      try {
        const workerResponse = await processChatTurn(
          task,
          [],
          newWorker.dirHandle,
          (script, explanation) =>
            updateAgent(newWorker.id, { proposedScript: { code: script, explanation } }),
          workerLog,
          {
            modelId: newWorker.modelId,
            provider: newWorker.provider,
            enableWebSearch: newWorker.enableWebSearch,
            agentName: newWorker.name,
            customSystemPrompt: managerContextPrompt,
            onAutoRunScript: buildAutoRunScriptCallback(newWorker.id),
            handoffAgents: workerHandoffTargets,
            onHandoffToAgent: workerHandoffTargets.length > 0
              ? buildHandoffAgentCallback(newWorker.id, newWorker.name)
              : undefined,
            onEpisodicMemory: (entry) => appendEpisodicMemory(newWorker.id, entry),
          },
        );

        initialResponse = workerResponse.content;

        setAgents(prev =>
          prev.map(a =>
            a.id === newWorker.id
              ? {
                  ...a,
                  isLoading: false,
                  messages: [
                    ...a.messages,
                    { role: 'user' as const, content: `[Task from manager]: ${task}` },
                    workerResponse as Message,
                  ],
                }
              : a,
          ),
        );

        // Record the worker's completion in the manager's episodic memory
        appendEpisodicMemory(managerId, `Worker "${newWorker.name}" completed task`);

        // Record the worker's response in the spawn link so the network view
        // shows the complete exchange.
        setMessageLinks(prev =>
          prev.map(l =>
            l.fromId === managerId && l.toId === newWorker.id && l.messageCount === 0
              ? {
                  ...l,
                  messageCount: 1,
                  messages: [
                    ...l.messages,
                    { sender: newWorker.name, content: initialResponse ?? '' },
                  ],
                }
              : l,
          ),
        );

        // Refresh the worker's file list after it may have written files
        if (newWorker.dirHandle) {
          const fileList = await listFiles(newWorker.dirHandle);
          updateAgent(newWorker.id, { files: fileList });
        }
      } catch (err: any) {
        initialResponse = `Error: ${err.message}`;
        setAgents(prev =>
          prev.map(a =>
            a.id === newWorker.id
              ? {
                  ...a,
                  isLoading: false,
                  messages: [
                    ...a.messages,
                    {
                      role: 'system' as const,
                      content: `Error executing initial task: ${err.message}`,
                    },
                  ],
                }
              : a,
          ),
        );
      }

      return { id: newWorker.id, name: newWorker.name, initialResponse };
    };

  /**
   * Called when a manager agent uses the message_agent tool.
   * Runs the target worker's LLM with the given message and records the link.
   */
  const buildMessageAgentCallback = (managerId: string, managerName: string) =>
    async (targetId: string, message: string): Promise<string> => {
      const target = agentsRef.current.find(a => a.id === targetId);
      if (!target) throw new Error(`Agent with ID "${targetId}" not found.`);

      // Show the worker as loading
      setAgents(prev => prev.map(a => a.id === targetId ? { ...a, isLoading: true } : a));

      const workerLog = (msg: string) =>
        setAgents(prev =>
          prev.map(a =>
            a.id === targetId ? { ...a, terminalLogs: [...a.terminalLogs, msg] } : a,
          ),
        );

      // Build the set of agents this worker is authorized to hand off to
      // (includes the parent manager so the worker can reply back).
      const workerHandoffTargets: AgentRef[] = connectedLinksRef.current
        .filter(l => l.fromId === targetId)
        .map(l => agentsRef.current.find(a => a.id === l.toId))
        .filter((a): a is Agent => Boolean(a))
        .map(a => ({ id: a.id, name: a.name }));

      let reply = '';
      try {
        const response = await processChatTurn(
          message,
          target.messages.filter(m => m.role !== 'system'),
          target.dirHandle,
          (script, explanation) => updateAgent(targetId, { proposedScript: { code: script, explanation } }),
          workerLog,
          {
            modelId: target.modelId,
            provider: target.provider,
            enableWebSearch: target.enableWebSearch,
            agentName: target.name,
            customSystemPrompt: target.systemPrompt,
            onAutoRunScript: buildAutoRunScriptCallback(targetId),
            handoffAgents: workerHandoffTargets,
            onHandoffToAgent: workerHandoffTargets.length > 0
              ? buildHandoffAgentCallback(targetId, target.name)
              : undefined,
            onEpisodicMemory: (entry) => appendEpisodicMemory(targetId, entry),
          },
        );

        reply = response.content;

        // Record in manager's episodic memory
        appendEpisodicMemory(
          managerId,
          `Messaged "${target.name}": ${truncateText(message, 60)}`,
        );

        // Notify the manager's chat thread that a message was sent/received
        setAgents(prev =>
          prev.map(a =>
            a.id === managerId
              ? {
                  ...a,
                  messages: [
                    ...a.messages,
                    {
                      role: 'system' as const,
                      content: `↔ Received response from **${target.name}**`,
                    },
                  ],
                }
              : a,
          ),
        );

        // Append the exchange to the worker's chat history
        setAgents(prev =>
          prev.map(a =>
            a.id === targetId
              ? {
                  ...a,
                  isLoading: false,
                  messages: [
                    ...a.messages,
                    { role: 'user', content: `[From ${managerName}]: ${message}` },
                    response as Message,
                  ],
                }
              : a,
          ),
        );
      } catch (err: any) {
        reply = `Error: ${err.message}`;
        setAgents(prev =>
          prev.map(a =>
            a.id === targetId
              ? {
                  ...a,
                  isLoading: false,
                  messages: [
                    ...a.messages,
                    { role: 'system', content: `Error from manager call: ${err.message}` },
                  ],
                }
              : a,
          ),
        );
      }

      // Update or create message link
      setMessageLinks(prev => {
        const existing = prev.find(
          l => l.fromId === managerId && l.toId === targetId && l.messageCount > 0,
        );
        const newMsgs = [
          { sender: managerName, content: message },
          { sender: target.name, content: reply },
        ];
        if (existing) {
          return prev.map(l =>
            l.fromId === managerId && l.toId === targetId
              ? { ...l, messageCount: l.messageCount + 1, lastMessage: message, messages: [...l.messages, ...newMsgs] }
              : l,
          );
        }
        return [...prev, { fromId: managerId, toId: targetId, messageCount: 1, lastMessage: message, messages: newMsgs }];
      });

      return reply;
    };

  /**
   * Called when a recursive manager agent invokes the request_signoff tool.
   * Runs the authoriser agent (if any) and returns APPROVED/REJECTED.
   */
  const buildRequestSignoffCallback = (managerId: string) =>
    async (summary: string): Promise<string> => {
      const authoriser = agentsRef.current.find(a => a.role === 'authoriser');
      if (!authoriser) {
        return 'APPROVED: No authoriser agent configured — task marked as complete.';
      }

      setAgents(prev => prev.map(a => a.id === authoriser.id ? { ...a, isLoading: true } : a));

      const authoriserLog = (msg: string) =>
        setAgents(prev =>
          prev.map(a =>
            a.id === authoriser.id ? { ...a, terminalLogs: [...a.terminalLogs, msg] } : a,
          ),
        );

      try {
        const response = await processChatTurn(
          `Please review this work summary and decide whether to APPROVE or REJECT it:\n\n${summary}\n\n` +
          'Respond with either "APPROVED: <brief comment>" or "REJECTED: <specific feedback about what needs to be improved>".',
          authoriser.messages.filter(m => m.role !== 'system'),
          authoriser.dirHandle,
          () => {},
          authoriserLog,
          {
            modelId: authoriser.modelId,
            provider: authoriser.provider,
            agentName: authoriser.name,
            customSystemPrompt: authoriser.systemPrompt,
          },
        );

        setAgents(prev =>
          prev.map(a =>
            a.id === authoriser.id
              ? {
                  ...a,
                  isLoading: false,
                  messages: [
                    ...a.messages,
                    {
                      role: 'user' as const,
                      content: `[Sign-off request from manager ${managerId}]: ${summary}`,
                    },
                    response as Message,
                  ],
                }
              : a,
          ),
        );

        return response.content;
      } catch (err: any) {
        setAgents(prev => prev.map(a => a.id === authoriser.id ? { ...a, isLoading: false } : a));
        return `APPROVED: Authoriser encountered an error — auto-approving (${err.message}).`;
      }
    };

  // ── Handoff callback ────────────────────────────────────────────────────────

  /**
   * Called when a non-manager agent uses the handoff_to_agent tool.
   * Runs the target agent's LLM with the given message and records the link.
   * The target agent is called with its own full capabilities, including its
   * own handoff agents, enabling a multi-hop pipeline.
   */
  const buildHandoffAgentCallback = (fromId: string, fromName: string) =>
    async (targetId: string, message: string): Promise<string> => {
      const target = agentsRef.current.find(a => a.id === targetId);
      if (!target) throw new Error(`Agent with ID "${targetId}" not found.`);

      setAgents(prev => prev.map(a => a.id === targetId ? { ...a, isLoading: true } : a));

      const targetLog = (msg: string) =>
        setAgents(prev =>
          prev.map(a =>
            a.id === targetId ? { ...a, terminalLogs: [...a.terminalLogs, msg] } : a,
          ),
        );

      // Agents available to the target for further handoff — restricted to authorized connections.
      const targetHandoffAgents: AgentRef[] = target.role !== 'manager'
        ? connectedLinksRef.current
            .filter(l => l.fromId === targetId)
            .map(l => agentsRef.current.find(a => a.id === l.toId))
            .filter((a): a is Agent => Boolean(a))
            .map(a => ({ id: a.id, name: a.name }))
        : [];

      let reply = '';
      try {
        const response = await processChatTurn(
          message,
          target.messages.filter(m => m.role !== 'system'),
          target.dirHandle,
          (script, explanation) => updateAgent(targetId, { proposedScript: { code: script, explanation } }),
          targetLog,
          {
            modelId: target.modelId,
            provider: target.provider,
            enableWebSearch: target.enableWebSearch,
            agentName: target.name,
            customSystemPrompt: target.systemPrompt,
            isManager: target.role === 'manager',
            isRecursive: target.role === 'manager' && target.recursive,
            isLive: target.role === 'manager' && target.isLive,
            spawnedAgents: agentsRef.current
              .filter(a => a.parentId === targetId)
              .map(a => ({ id: a.id, name: a.name })),
            onSpawnAgent: target.role === 'manager' ? buildSpawnAgentCallback(targetId) : undefined,
            onMessageAgent:
              target.role === 'manager'
                ? buildMessageAgentCallback(targetId, target.name)
                : undefined,
            onListAgents: target.role === 'manager' ? buildListAgentsCallback(targetId) : undefined,
            onConnectAgents: target.role === 'manager' ? buildConnectAgentsCallback(targetId) : undefined,
            onRequestSignoff:
              target.role === 'manager' && target.recursive
                ? buildRequestSignoffCallback(targetId)
                : undefined,
            onCritiqueOutput:
              target.role === 'manager' ? buildCritiqueCallback(targetId) : undefined,
            handoffAgents: targetHandoffAgents,
            onHandoffToAgent:
              target.role !== 'manager' && target.role !== 'critic' && targetHandoffAgents.length > 0
                ? buildHandoffAgentCallback(targetId, target.name)
                : undefined,
            onAutoRunScript: buildAutoRunScriptCallback(targetId),
            isCritic: target.role === 'critic',
            onEpisodicMemory: (entry) => appendEpisodicMemory(targetId, entry),
          },
        );

        reply = response.content;

        setAgents(prev =>
          prev.map(a =>
            a.id === targetId
              ? {
                  ...a,
                  isLoading: false,
                  messages: [
                    ...a.messages,
                    { role: 'user', content: `[From ${fromName}]: ${message}` },
                    response as Message,
                  ],
                }
              : a,
          ),
        );
      } catch (err: any) {
        reply = `Error: ${err.message}`;
        setAgents(prev =>
          prev.map(a =>
            a.id === targetId
              ? {
                  ...a,
                  isLoading: false,
                  messages: [
                    ...a.messages,
                    { role: 'system', content: `Error from handoff call: ${err.message}` },
                  ],
                }
              : a,
          ),
        );
      }

      // Record message link for the graph
      setMessageLinks(prev => {
        const existing = prev.find(l => l.fromId === fromId && l.toId === targetId);
        const newMsgs = [
          { sender: fromName, content: message },
          { sender: target.name, content: reply },
        ];
        if (existing) {
          return prev.map(l =>
            l.fromId === fromId && l.toId === targetId
              ? { ...l, messageCount: l.messageCount + 1, lastMessage: message, messages: [...l.messages, ...newMsgs] }
              : l,
          );
        }
        return [...prev, { fromId, toId: targetId, messageCount: 1, lastMessage: message, messages: newMsgs }];
      });

      return reply;
    };

  /**
   * Returns a callback that auto-runs a Python script using Pyodide (no user review required).
   * Used by workers when calling write_document for docx/pdf formats.
   */
  const buildAutoRunScriptCallback = (agentId: string) =>
    async (script: string): Promise<string> => {
      const agent = agentsRef.current.find(a => a.id === agentId);
      const logFn = (msg: string) =>
        setAgents(prev =>
          prev.map(a =>
            a.id === agentId ? { ...a, terminalLogs: [...a.terminalLogs, msg] } : a,
          ),
        );

      try {
        let py = pyodideInstance;
        if (!py) {
          if (!agent?.dirHandle) throw new Error('No workspace folder selected.');
          py = await initPython(agent.dirHandle, logFn);
          setPyodideInstance(py);
        } else if (agent?.dirHandle) {
          // Re-bind file helpers to the agent's current dirHandle
          py.globals.set('read_file_js', async (f: string) => readFileFs(agent.dirHandle!, f));
          py.globals.set('write_file_js', async (f: string, c: string) => writeFileFs(agent.dirHandle!, f, c));
          py.globals.set('write_binary_file_js', async (f: string, b64: string) => {
            await writeBinaryFile(agent.dirHandle!, f, base64ToBytes(b64));
          });
          py.globals.set('create_folder_js', async (p: string) => createFolderFs(agent.dirHandle!, p));
        }
        await runPythonScript(script, py, logFn);
        await refreshFiles(agentId);
        return 'Done.';
      } catch (err: any) {
        return `Error: ${err.message}`;
      }
    };

  // ── Manager-specific callbacks ──────────────────────────────────────────────

  /**
   * Returns all agents (except the calling manager) so the manager can discover
   * which agents are available to delegate to or connect.
   */
  const buildListAgentsCallback = (managerId: string) =>
    async (): Promise<AgentRef[]> =>
      agentsRef.current
        .filter(a => a.id !== managerId)
        .map(a => ({ id: a.id, name: a.name, role: a.role }));

  /**
   * Called when a manager agent uses the connect_agents tool.
   * Creates an authorized one-way communication channel fromAgentId → toAgentId
   * and records the visual link in the graph.
   */
  const buildConnectAgentsCallback = (managerId: string) =>
    async (fromAgentId: string, toAgentId: string): Promise<string> => {
      const fromAgent = agentsRef.current.find(a => a.id === fromAgentId);
      const toAgent = agentsRef.current.find(a => a.id === toAgentId);
      const managerAgent = agentsRef.current.find(a => a.id === managerId);
      if (!fromAgent) return `Error: Agent with ID "${fromAgentId}" not found.`;
      if (!toAgent) return `Error: Agent with ID "${toAgentId}" not found.`;

      setConnectedLinks(prev => {
        const exists = prev.some(l => l.fromId === fromAgentId && l.toId === toAgentId);
        if (exists) return prev;
        return [...prev, { fromId: fromAgentId, toId: toAgentId }];
      });

      // Also add a visual edge to the graph (with 0 message count until they actually talk)
      const linkNote = `Connected by ${managerAgent?.name ?? 'manager'}`;
      setMessageLinks(prev => {
        const exists = prev.some(l => l.fromId === fromAgentId && l.toId === toAgentId);
        if (exists) return prev;
        return [...prev, { fromId: fromAgentId, toId: toAgentId, messageCount: 0, lastMessage: linkNote, messages: [] }];
      });

      return `Connected: ${fromAgent.name} → ${toAgent.name}. ${fromAgent.name} can now hand off work to ${toAgent.name} using handoff_to_agent.`;
    };

  // ── Rename agent callback ──────────────────────────────────────────────────

  /**
   * Called when a manager agent invokes the rename_agent tool.
   * Updates the agent's display name in React state so the UI tabs and graph
   * view reflect the new name immediately.
   */
  const buildRenameAgentCallback = (managerId: string) =>
    async (agentId: string, newName: string): Promise<string> => {
      const target = agentsRef.current.find(a => a.id === agentId);
      if (!target) return `Error: Agent with ID "${agentId}" not found.`;

      const oldName = target.name;
      updateAgent(agentId, { name: newName });
      appendEpisodicMemory(managerId, `Renamed agent "${oldName}" → "${newName}"`);
      return `Agent renamed from "${oldName}" to "${newName}".`;
    };

  // ── Set agent prompt callback ──────────────────────────────────────────────

  /**
   * Called when a manager agent invokes the set_agent_prompt tool.
   * Updates the agent's custom system prompt so the next LLM interaction
   * uses the new instructions.
   */
  const buildSetAgentPromptCallback = (managerId: string) =>
    async (agentId: string, prompt: string): Promise<string> => {
      const target = agentsRef.current.find(a => a.id === agentId);
      if (!target) return `Error: Agent with ID "${agentId}" not found.`;

      updateAgent(agentId, { systemPrompt: prompt });
      appendEpisodicMemory(managerId, `Set system prompt for agent "${target.name}"`);
      return `System prompt updated for agent "${target.name}" (ID: ${agentId}). The new prompt will take effect on the agent's next interaction.`;
    };

  // ── Episodic memory helper ──────────────────────────────────────────────────

  /** Append a step entry to an agent's episodic memory progress log. */
  const appendEpisodicMemory = useCallback((agentId: string, entry: string) => {
    setAgents(prev =>
      prev.map(a =>
        a.id === agentId
          ? { ...a, episodicMemory: [...a.episodicMemory, entry] }
          : a,
      ),
    );
  }, []);

  // ── Critique callback ───────────────────────────────────────────────────────

  /**
   * Called when a manager agent invokes the critique_output tool.
   * Runs the critic agent (if one exists) with the provided output and
   * returns structured feedback (strengths, issues, recommendations, verdict).
   */
  const buildCritiqueCallback = (managerId: string) =>
    async (output: string): Promise<string> => {
      const critic = agentsRef.current.find(a => a.role === 'critic');
      if (!critic) {
        return 'No critic agent configured. Add a Critic agent to enable output review.';
      }

      setAgents(prev => prev.map(a => a.id === critic.id ? { ...a, isLoading: true } : a));

      const criticLog = (msg: string) =>
        setAgents(prev =>
          prev.map(a =>
            a.id === critic.id ? { ...a, terminalLogs: [...a.terminalLogs, msg] } : a,
          ),
        );

      try {
        const response = await processChatTurn(
          `Please review the following work and provide structured feedback:\n\n${output}\n\n` +
          'Format your response as:\nSTRENGTHS: <what is correct and well done>\n' +
          'ISSUES: <what is missing, incorrect, or poorly done>\n' +
          'RECOMMENDATIONS: <specific, actionable steps to improve>\n' +
          'VERDICT: APPROVE | REVISE',
          critic.messages.filter(m => m.role !== 'system'),
          critic.dirHandle,
          () => {},
          criticLog,
          {
            modelId: critic.modelId,
            provider: critic.provider,
            agentName: critic.name,
            customSystemPrompt: critic.systemPrompt,
            isCritic: true,
          },
        );

        setAgents(prev =>
          prev.map(a =>
            a.id === critic.id
              ? {
                  ...a,
                  isLoading: false,
                  messages: [
                    ...a.messages,
                    {
                      role: 'user' as const,
                      content: `[Review request from manager ${managerId}]: ${truncateText(output, 200)}`,
                    },
                    response as Message,
                  ],
                }
              : a,
          ),
        );

        // Record in manager's episodic memory
        const verdictMatch = response.content.match(/VERDICT:\s*(APPROVE|REVISE)/i);
        appendEpisodicMemory(managerId, `Critic reviewed output — verdict: ${
          verdictMatch ? verdictMatch[1].toUpperCase() : 'received'
        }`);

        return response.content;
      } catch (err: any) {
        setAgents(prev => prev.map(a => a.id === critic.id ? { ...a, isLoading: false } : a));
        return `Critic agent error: ${err.message}`;
      }
    };

  // ── Chat ────────────────────────────────────────────────────────────────────

  const handleSendMessage = async (agentId: string) => {
    const agent = agentsRef.current.find(a => a.id === agentId);
    if (!agent || !agent.input.trim() || agent.isLoading) return;

    const userMsg = agent.input;
    updateAgent(agentId, {
      input: '',
      isLoading: true,
      messages: [...agent.messages, { role: 'user', content: userMsg }],
    });

    const logToTerminal = (msg: string) =>
      setAgents(prev =>
        prev.map(a => a.id === agentId ? { ...a, terminalLogs: [...a.terminalLogs, msg] } : a),
      );

    const onProposeScript = (script: string, explanation: string) =>
      updateAgent(agentId, { proposedScript: { code: script, explanation } });

    // Compute which agents this manager has spawned (for the system prompt)
    const spawnedAgents: AgentRef[] = agentsRef.current
      .filter(a => a.parentId === agentId)
      .map(a => ({ id: a.id, name: a.name }));

    // Agents available for handoff: restricted to authorized connections set up by a manager.
    // Only non-manager agents use handoff; managers use message_agent instead.
    const handoffAgents: AgentRef[] = agent.role !== 'manager'
      ? connectedLinksRef.current
          .filter(l => l.fromId === agentId)
          .map(l => agentsRef.current.find(a => a.id === l.toId))
          .filter((a): a is Agent => Boolean(a))
          .map(a => ({ id: a.id, name: a.name }))
      : [];

    try {
      const responseMsg = await processChatTurn(
        userMsg,
        agent.messages.filter(m => m.role !== 'system'),
        agent.dirHandle,
        onProposeScript,
        logToTerminal,
        {
          modelId: agent.modelId,
          provider: agent.provider,
          enableWebSearch: agent.enableWebSearch,
          agentName: agent.name,
          isManager: agent.role === 'manager',
          isRecursive: agent.role === 'manager' && agent.recursive,
          isLive: agent.role === 'manager' && agent.isLive,
          customSystemPrompt: agent.systemPrompt,
          spawnedAgents,
          onSpawnAgent: agent.role === 'manager' ? buildSpawnAgentCallback(agentId) : undefined,
          onMessageAgent:
            agent.role === 'manager'
              ? buildMessageAgentCallback(agentId, agent.name)
              : undefined,
          onListAgents: agent.role === 'manager' ? buildListAgentsCallback(agentId) : undefined,
          onConnectAgents: agent.role === 'manager' ? buildConnectAgentsCallback(agentId) : undefined,
          onRenameAgent: agent.role === 'manager' ? buildRenameAgentCallback(agentId) : undefined,
          onSetAgentPrompt: agent.role === 'manager' ? buildSetAgentPromptCallback(agentId) : undefined,
          onRequestSignoff:
            agent.role === 'manager' && agent.recursive
              ? buildRequestSignoffCallback(agentId)
              : undefined,
          onCritiqueOutput:
            agent.role === 'manager' ? buildCritiqueCallback(agentId) : undefined,
          handoffAgents,
          onHandoffToAgent:
            agent.role !== 'manager' && agent.role !== 'critic' && handoffAgents.length > 0
              ? buildHandoffAgentCallback(agentId, agent.name)
              : undefined,
          onAutoRunScript: buildAutoRunScriptCallback(agentId),
          isCritic: agent.role === 'critic',
          onEpisodicMemory: (entry) => appendEpisodicMemory(agentId, entry),
        },
      );

      setAgents(prev =>
        prev.map(a =>
          a.id === agentId
            ? { ...a, isLoading: false, messages: [...a.messages, responseMsg as Message] }
            : a,
        ),
      );
      await refreshFiles(agentId);
    } catch (err: any) {
      setAgents(prev =>
        prev.map(a =>
          a.id === agentId
            ? {
                ...a,
                isLoading: false,
                messages: [...a.messages, { role: 'system', content: `Error: ${err.message}` }],
              }
            : a,
        ),
      );
    }
  };

  // ── Live agent autonomous loop ──────────────────────────────────────────────

  /**
   * Autonomous tick for a live manager agent.
   * Sends a continuation prompt so the manager can check on its team,
   * delegate new work, or report progress without user input.
   */
  const handleLiveTick = async (agentId: string) => {
    const agent = agentsRef.current.find(a => a.id === agentId);
    if (!agent || !agent.isLive || agent.isLoading || agent.role !== 'manager') return;

    const continuationPrompt =
      'You are running in live autonomous mode. Continue working on your current objectives. ' +
      'Check on your team status, process any remaining sub-tasks, delegate new work if needed, ' +
      'and report progress. If everything is complete and there is nothing more to do right now, ' +
      'respond with exactly "IDLE" on the first line.';

    updateAgent(agentId, {
      isLoading: true,
      messages: [...agent.messages, { role: 'user' as const, content: `[Live Mode] ${continuationPrompt}` }],
    });

    const logToTerminal = (msg: string) =>
      setAgents(prev =>
        prev.map(a => a.id === agentId ? { ...a, terminalLogs: [...a.terminalLogs, msg] } : a),
      );

    const spawnedAgents: AgentRef[] = agentsRef.current
      .filter(a => a.parentId === agentId)
      .map(a => ({ id: a.id, name: a.name }));

    try {
      const responseMsg = await processChatTurn(
        continuationPrompt,
        agent.messages.filter(m => m.role !== 'system'),
        agent.dirHandle,
        (script, explanation) => updateAgent(agentId, { proposedScript: { code: script, explanation } }),
        logToTerminal,
        {
          modelId: agent.modelId,
          provider: agent.provider,
          enableWebSearch: agent.enableWebSearch,
          agentName: agent.name,
          isManager: true,
          isRecursive: agent.recursive,
          isLive: true,
          customSystemPrompt: agent.systemPrompt,
          spawnedAgents,
          onSpawnAgent: buildSpawnAgentCallback(agentId),
          onMessageAgent: buildMessageAgentCallback(agentId, agent.name),
          onListAgents: buildListAgentsCallback(agentId),
          onConnectAgents: buildConnectAgentsCallback(agentId),
          onRenameAgent: buildRenameAgentCallback(agentId),
          onSetAgentPrompt: buildSetAgentPromptCallback(agentId),
          onRequestSignoff: agent.recursive ? buildRequestSignoffCallback(agentId) : undefined,
          onCritiqueOutput: buildCritiqueCallback(agentId),
          onAutoRunScript: buildAutoRunScriptCallback(agentId),
          onEpisodicMemory: (entry) => appendEpisodicMemory(agentId, entry),
        },
      );

      // Check for idle response — match only "IDLE" as the entire first line
      const firstLine = responseMsg.content.trim().split('\n')[0].trim();
      const isIdle = firstLine === 'IDLE';
      if (isIdle) {
        idleCountRef.current.set(agentId, (idleCountRef.current.get(agentId) ?? 0) + 1);
      } else {
        idleCountRef.current.set(agentId, 0);
      }

      setAgents(prev =>
        prev.map(a =>
          a.id === agentId
            ? { ...a, isLoading: false, messages: [...a.messages, responseMsg as Message] }
            : a,
        ),
      );
      await refreshFiles(agentId);
    } catch (err: any) {
      setAgents(prev =>
        prev.map(a =>
          a.id === agentId
            ? {
                ...a,
                isLoading: false,
                messages: [...a.messages, { role: 'system', content: `[Live Mode] Error: ${err.message}` }],
              }
            : a,
        ),
      );
    }
  };

  /**
   * Live-agent scheduler. Watches for managers that have isLive=true and
   * are not currently loading, then schedules the next autonomous tick.
   * Backs off when the manager is idle to avoid wasting API calls.
   */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const timers = liveTimersRef.current;

    // Schedule ticks for live managers that are idle and not already scheduled
    for (const agent of agents) {
      if (agent.role === 'manager' && agent.isLive && !agent.isLoading && !timers.has(agent.id)) {
        const idleCount = idleCountRef.current.get(agent.id) ?? 0;
        // Back off: 8s base, doubling each idle tick, capped at 60s
        const delay = Math.min(8000 * Math.pow(2, idleCount), 60000);
        const timer = setTimeout(() => {
          timers.delete(agent.id);
          handleLiveTick(agent.id);
        }, delay);
        timers.set(agent.id, timer);
      }
    }

    // Cancel timers for agents that are no longer live
    for (const [agentId, timer] of timers.entries()) {
      const agent = agents.find(a => a.id === agentId);
      if (!agent || !agent.isLive) {
        clearTimeout(timer);
        timers.delete(agentId);
        idleCountRef.current.delete(agentId);
      }
    }
  }, [agents]);

  // ── Python script runner ────────────────────────────────────────────────────

  const handleRunScript = async (agentId: string) => {
    const agent = agentsRef.current.find(a => a.id === agentId);
    if (!agent?.proposedScript || !agent.dirHandle) return;

    const logToTerminal = (msg: string) =>
      setAgents(prev =>
        prev.map(a => a.id === agentId ? { ...a, terminalLogs: [...a.terminalLogs, msg] } : a),
      );

    try {
      let py = pyodideInstance;
      if (!py) {
        py = await initPython(agent.dirHandle, logToTerminal);
        setPyodideInstance(py);
      }
      await runPythonScript(agent.proposedScript.code, py, logToTerminal);
      await refreshFiles(agentId);
      setAgents(prev =>
        prev.map(a =>
          a.id === agentId
            ? {
                ...a,
                proposedScript: null,
                messages: [...a.messages, { role: 'system', content: 'Python script execution completed.' }],
              }
            : a,
        ),
      );
    } catch (err: any) {
      logToTerminal(`Execution Error: ${err.message}`);
    }
  };

  // ── Model download ──────────────────────────────────────────────────────────

  const handleDownloadModel = async (modelId: string) => {
    setDownloadingModel(modelId);
    setDownloadStatus('Starting download…');
    try {
      await pullOllamaModel(modelId, status => setDownloadStatus(status));
      setDownloadStatus('Download complete!');
      const updated = await listOllamaModels();
      setOllamaModels(updated);
    } catch (err: any) {
      setDownloadStatus(`Error: ${err.message}`);
    } finally {
      setDownloadingModel(null);
    }
  };

  // ── Ollama settings ─────────────────────────────────────────────────────────

  const handleTestConnection = async () => {
    setConnectionStatus('testing');
    const ok = await testOllamaConnection(ollamaUrlInput);
    setConnectionStatus(ok ? 'ok' : 'fail');
  };

  const handleSaveSettings = async () => {
    setOllamaUrl(ollamaUrlInput);
    setGeminiApiKey(geminiApiKeyInput);
    setConnectionStatus('idle');
    setShowSettings(false);
    const updated = await listOllamaModels();
    setOllamaModels(updated);
  };

  const handleOpenSettings = () => {
    setOllamaUrlInput(getOllamaUrl());
    setGeminiApiKeyInput(getGeminiApiKey());
    setConnectionStatus('idle');
    setShowSettings(true);
  };

  const handleCloseDownloadModal = () => {
    setShowDownloadModal(false);
    setDownloadStatus('');
  };

  // ── First-run Ollama setup ───────────────────────────────────────────────────

  const handleInstallOllama = async () => {
    if (!window.ollamaSetup) return;
    setOllamaInstallStatus('downloading');
    setOllamaInstallProgress('Starting…');
    const unsubscribe = window.ollamaSetup.onProgress(msg => setOllamaInstallProgress(msg));
    try {
      const result = await window.ollamaSetup.install();
      if (result.success) {
        setOllamaInstallStatus('done');
      } else {
        setOllamaInstallStatus('error');
        setOllamaInstallProgress(result.error ?? 'Unknown error');
      }
    } finally {
      unsubscribe();
    }
  };

  const handleDismissOllamaSetup = () => {
    localStorage.setItem(OLLAMA_SETUP_DISMISSED_KEY, '1');
    setShowOllamaSetup(false);
    setOllamaInstallStatus('idle');
    setOllamaInstallProgress('');
  };

  const handleOpenDownloadModal = () => {
    setShowDownloadModal(true);
    setShowModelPicker(false);
  };

  // ── Derived values ──────────────────────────────────────────────────────────

  const allModels: Model[] = [...DEFAULT_GEMINI_MODELS, ...ollamaModels];
  const currentModelLabel =
    allModels.find(m => m.id === activeAgent.modelId)?.name ?? activeAgent.modelId;

  // Deduplicate message links: only the most-recent link per (from,to) pair
  const dedupedMessageLinks: MessageLink[] = Object.values(
    messageLinks.reduce<Record<string, MessageLink>>((acc, l) => {
      const key = `${l.fromId}→${l.toId}`;
      if (!acc[key] || l.messageCount > acc[key].messageCount) acc[key] = l;
      return acc;
    }, {}),
  );

  /** Fast O(1) agent lookup used in render. */
  const agentById = new Map(agents.map(a => [a.id, a]));

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100 font-sans">

      {/* ── Agent tab bar ─────────────────────────────────────────────────── */}
      <div className="flex items-center bg-zinc-900 border-b border-zinc-800 overflow-x-auto shrink-0">
        <div className="flex items-center gap-1 px-2 py-1 flex-1 min-w-0">
          {agents.map(agent => (
            <div
              key={agent.id}
              onClick={() => { setActiveAgentId(agent.id); setShowGraphView(false); }}
              onDoubleClick={() => startRenameTab(agent)}
              title="Double-click to rename"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md cursor-pointer text-sm select-none transition-colors min-w-0 max-w-[10rem] shrink-0 ${
                agent.id === activeAgentId && !showGraphView
                  ? 'bg-zinc-700 text-white'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              {agent.role === 'manager' && (
                <Crown className="w-3 h-3 text-indigo-400 shrink-0" />
              )}
              {agent.role === 'authoriser' && (
                <Shield className="w-3 h-3 text-amber-400 shrink-0" />
              )}
              {agent.role === 'critic' && (
                <Eye className="w-3 h-3 text-cyan-400 shrink-0" />
              )}
              {agent.isLive && (
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse shrink-0" />
              )}
              {editingTabId === agent.id ? (
                <input
                  ref={tabInputRef}
                  value={editingTabName}
                  onChange={e => setEditingTabName(e.target.value)}
                  onBlur={commitRenameTab}
                  onKeyDown={e => {
                    if (e.key === 'Enter') commitRenameTab();
                    if (e.key === 'Escape') setEditingTabId(null);
                  }}
                  onClick={e => e.stopPropagation()}
                  className="bg-transparent text-white outline-none border-b border-emerald-400 w-24 text-sm"
                />
              ) : (
                <>
                  {agent.role === 'worker' && (
                    <Edit2 className="w-3 h-3 text-zinc-600 shrink-0" />
                  )}
                  <span className="truncate">{agent.name}</span>
                </>
              )}
              {agents.length > 1 && (
                <button
                  onClick={e => removeAgent(agent.id, e)}
                  className="text-zinc-500 hover:text-zinc-200 ml-0.5 shrink-0"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          ))}

          <button
            onClick={addAgent}
            title="New Worker Agent"
            className="flex items-center gap-1 px-2 py-1.5 text-zinc-400 hover:text-emerald-400 hover:bg-zinc-800 rounded-md text-sm transition-colors shrink-0"
          >
            <Plus className="w-4 h-4" />
            <span className="text-xs">New Agent</span>
          </button>
          <button
            onClick={addManager}
            title="New Manager Agent"
            className="flex items-center gap-1 px-2 py-1.5 text-zinc-400 hover:text-indigo-400 hover:bg-zinc-800 rounded-md text-sm transition-colors shrink-0"
          >
            <Crown className="w-3.5 h-3.5" />
            <span className="text-xs">Manager</span>
          </button>
          <button
            onClick={addAuthoriser}
            title="New Authoriser Agent"
            className="flex items-center gap-1 px-2 py-1.5 text-zinc-400 hover:text-amber-400 hover:bg-zinc-800 rounded-md text-sm transition-colors shrink-0"
          >
            <Shield className="w-3.5 h-3.5" />
            <span className="text-xs">Authoriser</span>
          </button>
          <button
            onClick={addCritic}
            title="New Critic Agent — reviews outputs and gives structured feedback"
            className="flex items-center gap-1 px-2 py-1.5 text-zinc-400 hover:text-cyan-400 hover:bg-zinc-800 rounded-md text-sm transition-colors shrink-0"
          >
            <Eye className="w-3.5 h-3.5" />
            <span className="text-xs">Critic</span>
          </button>
        </div>

        <span className="text-xs text-zinc-600 px-2 shrink-0 hidden sm:block">
          Double-click tab to rename
        </span>

        {/* Graph view toggle */}
        <button
          onClick={() => setShowGraphView(v => !v)}
          title={showGraphView ? 'Back to chat' : 'View agent graph'}
          className={`px-3 py-2 transition-colors shrink-0 ${
            showGraphView
              ? 'text-emerald-400 bg-emerald-500/10'
              : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
          }`}
        >
          <Network className="w-4 h-4" />
        </button>

        {/* Settings button */}
        <button
          onClick={handleOpenSettings}
          title="Settings"
          className="px-3 py-2 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors shrink-0"
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>

      {/* ── Main content ──────────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0">

        {/* Sidebar */}
        <div className="w-56 bg-zinc-900 border-r border-zinc-800 flex flex-col shrink-0">
          <div className="p-3 border-b border-zinc-800">
            <h1 className="text-sm font-semibold tracking-tight flex items-center gap-2">
              <Terminal className="w-4 h-4 text-emerald-400" />
              Local LM
            </h1>
          </div>

          {showGraphView ? (
            <div className="p-3 text-xs text-zinc-500 space-y-2 overflow-y-auto flex-1">
              <p className="font-semibold text-zinc-400 uppercase tracking-wider text-[10px]">
                Agent Network
              </p>
              <p>{agents.length} agent{agents.length !== 1 ? 's' : ''}</p>
              <p>{agents.filter(a => a.role === 'manager').length} manager{agents.filter(a => a.role === 'manager').length !== 1 ? 's' : ''}</p>
              <p>{agents.filter(a => a.role === 'authoriser').length} authoriser{agents.filter(a => a.role === 'authoriser').length !== 1 ? 's' : ''}</p>
              <p>{agents.filter(a => a.role === 'critic').length} critic{agents.filter(a => a.role === 'critic').length !== 1 ? 's' : ''}</p>
              <p>{dedupedMessageLinks.filter(l => l.messageCount > 0).length} active link{dedupedMessageLinks.filter(l => l.messageCount > 0).length !== 1 ? 's' : ''}</p>
              <hr className="border-zinc-800 my-1" />
              <p className="font-semibold text-zinc-400 uppercase tracking-wider text-[10px]">
                Add Agent
              </p>
              <button
                onClick={addAgent}
                className="w-full text-left flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
              >
                <Plus className="w-3 h-3" /> Worker
              </button>
              <button
                onClick={addManager}
                className="w-full text-left flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-indigo-300 transition-colors"
              >
                <Crown className="w-3 h-3" /> Add Manager
              </button>
              <button
                onClick={addAuthoriser}
                className="w-full text-left flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-amber-300 transition-colors"
              >
                <Shield className="w-3 h-3" /> Add Authoriser
              </button>
              <button
                onClick={addCritic}
                className="w-full text-left flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-cyan-300 transition-colors"
              >
                <Eye className="w-3 h-3" /> Add Critic
              </button>
              {/* Remove Parent section: show agents that have a parent */}
              {agents.some(a => a.parentId !== null) && (
                <>
                  <hr className="border-zinc-800 my-1" />
                  <p className="font-semibold text-zinc-400 uppercase tracking-wider text-[10px]">
                    Remove Parent
                  </p>
                  {agents
                    .filter(a => a.parentId !== null)
                    .map(a => {
                      const parent = agentById.get(a.parentId!);
                      return (
                        <button
                          key={a.id}
                          onClick={() => handleRemoveParent(a.id)}
                          title={`Remove parent link: ${a.name} → ${parent?.name ?? 'unknown'}`}
                          className="w-full text-left flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-zinc-800 hover:bg-red-900/40 text-zinc-400 hover:text-red-300 transition-colors"
                        >
                          <X className="w-3 h-3 shrink-0" />
                          <span className="truncate">{a.name}</span>
                        </button>
                      );
                    })}
                </>
              )}
              <hr className="border-zinc-800 my-1" />
              <p className="text-zinc-600 leading-relaxed">
                Use <strong className="text-zinc-500">🔗 Link</strong> to draw a manual communication line.
              </p>
              <p className="text-zinc-600 leading-relaxed">
                Use <strong className="text-zinc-500">⬆ Set Parent</strong> to assign hierarchy.
              </p>
              <p className="text-zinc-600 leading-relaxed">
                Use <strong className="text-zinc-500">✂ Detach</strong> to remove a parent link.
              </p>
              <p className="text-zinc-600 leading-relaxed">
                Click a node to open that agent's chat.
              </p>
            </div>
          ) : (
            <div className="p-3 flex-1 overflow-y-auto">
              <button
                onClick={() => handleOpenFolder(activeAgent.id)}
                className="w-full flex items-center justify-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-xs font-medium py-2 px-3 rounded-lg transition-colors mb-3"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                {activeAgent.dirHandle ? 'Change Folder' : 'Open Folder'}
              </button>

              {activeAgent.dirHandle && (
                <div>
                  <h2 className="text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2 truncate">
                    {activeAgent.dirHandle.name}
                  </h2>
                  <ul className="space-y-1">
                    {activeAgent.files.length === 0 ? (
                      <li className="text-xs text-zinc-500 italic">Empty folder</li>
                    ) : (
                      activeAgent.files.map(f => (
                        <li
                          key={f}
                          className="text-xs flex items-center gap-1.5 text-zinc-300 hover:text-white cursor-default"
                        >
                          <FileText className="w-3 h-3 text-zinc-500 shrink-0" />
                          <span className="truncate">{f}</span>
                        </li>
                      ))
                    )}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Graph View ─────────────────────────────────────────────────── */}
        {showGraphView ? (
          <AgentGraph
            agents={agents.map(a => ({
              id: a.id,
              name: a.name,
              role: a.role,
              provider: a.provider,
              modelId: a.modelId,
              parentId: a.parentId,
              isLoading: a.isLoading,
              recursive: a.recursive,
              isLive: a.isLive,
            }))}
            activeAgentId={activeAgentId}
            messageLinks={dedupedMessageLinks}
            onSelectAgent={id => {
              setActiveAgentId(id);
              setShowGraphView(false);
            }}
            onCreateLink={handleCreateLink}
            onSetParent={handleSetParent}
            onRemoveParent={handleRemoveParent}
          />
        ) : (
          /* ── Chat View ───────────────────────────────────────────────── */
          <div className="flex-1 flex flex-col min-w-0">

            {/* Agent toolbar */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-zinc-800 bg-zinc-900/50 shrink-0 flex-wrap">
              <span className="text-xs text-zinc-500 font-medium truncate max-w-[8rem] flex items-center gap-1">
                {activeAgent.role === 'manager' && (
                  <Crown className="w-3 h-3 text-indigo-400 shrink-0" />
                )}
                {activeAgent.role === 'authoriser' && (
                  <Shield className="w-3 h-3 text-amber-400 shrink-0" />
                )}
                {activeAgent.role === 'critic' && (
                  <Eye className="w-3 h-3 text-cyan-400 shrink-0" />
                )}
                {activeAgent.name}
              </span>

              {/* Parent indicator with quick-detach button */}
              {activeAgent.parentId && (() => {
                const parent = agentById.get(activeAgent.parentId);
                return parent ? (
                  <span className="flex items-center gap-1 text-xs text-zinc-500 bg-zinc-800/60 border border-zinc-700/50 rounded-md px-2 py-1">
                    <span className="text-zinc-600">↑</span>
                    <span className="truncate max-w-[6rem]">{parent.name}</span>
                    <button
                      onClick={() => handleRemoveParent(activeAgent.id)}
                      title="Remove parent link"
                      className="text-zinc-600 hover:text-red-400 transition-colors ml-0.5"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ) : null;
              })()}

              {/* Role cycle toggle: worker → manager → authoriser → critic → worker */}
              <button
                onClick={() =>
                  updateAgent(activeAgent.id, {
                    role:
                      activeAgent.role === 'worker'
                        ? 'manager'
                        : activeAgent.role === 'manager'
                        ? 'authoriser'
                        : activeAgent.role === 'authoriser'
                        ? 'critic'
                        : 'worker',
                  })
                }
                title="Cycle role: Worker → Manager → Authoriser → Critic → Worker"
                className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md transition-colors ${
                  activeAgent.role === 'manager'
                    ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/30'
                    : activeAgent.role === 'authoriser'
                    ? 'bg-amber-600/20 text-amber-400 border border-amber-500/30'
                    : activeAgent.role === 'critic'
                    ? 'bg-cyan-600/20 text-cyan-400 border border-cyan-500/30'
                    : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700'
                }`}
              >
                {activeAgent.role === 'manager' && <Crown className="w-3 h-3" />}
                {activeAgent.role === 'authoriser' && <Shield className="w-3 h-3" />}
                {activeAgent.role === 'critic' && <Eye className="w-3 h-3" />}
                {activeAgent.role === 'worker' && <Edit2 className="w-3 h-3" />}
                {activeAgent.role === 'manager'
                  ? 'Manager'
                  : activeAgent.role === 'authoriser'
                  ? 'Authoriser'
                  : activeAgent.role === 'critic'
                  ? 'Critic'
                  : 'Worker'}
              </button>

              {/* Recursive toggle (manager only) */}
              {activeAgent.role === 'manager' && (
                <button
                  onClick={() =>
                    updateAgent(activeAgent.id, { recursive: !activeAgent.recursive })
                  }
                  title={
                    activeAgent.recursive
                      ? 'Recursive mode active — click to disable'
                      : 'Enable recursive mode: manager loops until authoriser approves'
                  }
                  className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md transition-colors ${
                    activeAgent.recursive
                      ? 'bg-purple-600/20 text-purple-400 border border-purple-500/30'
                      : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700'
                  }`}
                >
                  <RefreshCw className="w-3 h-3" />
                  Recursive
                </button>
              )}

              {/* Live mode toggle (manager only) */}
              {activeAgent.role === 'manager' && (
                <button
                  onClick={() => {
                    const goingLive = !activeAgent.isLive;
                    updateAgent(activeAgent.id, { isLive: goingLive });
                    if (goingLive) {
                      idleCountRef.current.set(activeAgent.id, 0);
                    }
                  }}
                  title={
                    activeAgent.isLive
                      ? 'Live mode active — click to stop autonomous operation'
                      : 'Go Live: agent runs autonomously, checking on its team and processing tasks'
                  }
                  className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md transition-colors ${
                    activeAgent.isLive
                      ? 'bg-green-600/20 text-green-400 border border-green-500/30 animate-pulse'
                      : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700'
                  }`}
                >
                  <Power className="w-3 h-3" />
                  {activeAgent.isLive ? 'Live ●' : 'Go Live'}
                </button>
              )}

              {/* Edit system prompt */}
              <button
                onClick={() => handleOpenPromptEditor()}
                title="Edit this agent's system prompt / task framing"
                className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md transition-colors ${
                  activeAgent.systemPrompt.trim()
                    ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/30'
                    : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700'
                }`}
              >
                <MessageSquare className="w-3 h-3" />
                Prompt
              </button>

              {/* Model picker */}
              <div className="relative" ref={modelPickerRef}>
                <button
                  onClick={() => setShowModelPicker(p => !p)}
                  className="flex items-center gap-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 px-2.5 py-1.5 rounded-md transition-colors"
                >
                  <span className="max-w-[8rem] truncate">{currentModelLabel}</span>
                  <ChevronDown className="w-3 h-3 text-zinc-400 shrink-0" />
                </button>

                {showModelPicker && (
                  <div className="absolute top-9 left-0 z-50 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl w-60 max-h-80 overflow-y-auto">
                    <div className="px-3 py-2 border-b border-zinc-700">
                      <p className="text-xs text-zinc-400 font-semibold uppercase tracking-wider">
                        Cloud Models
                      </p>
                    </div>
                    {DEFAULT_GEMINI_MODELS.map(m => (
                      <button
                        key={m.id}
                        onClick={() => {
                          updateAgent(activeAgent.id, { modelId: m.id, provider: 'gemini' });
                          setShowModelPicker(false);
                        }}
                        className={`w-full text-left px-3 py-2 text-sm hover:bg-zinc-700 transition-colors ${
                          activeAgent.modelId === m.id ? 'text-emerald-400' : 'text-zinc-200'
                        }`}
                      >
                        {m.name}
                      </button>
                    ))}

                    <div className="px-3 py-2 border-t border-b border-zinc-700 flex items-center justify-between">
                      <p className="text-xs text-zinc-400 font-semibold uppercase tracking-wider">
                        Local (Ollama)
                      </p>
                      <button
                        onClick={handleOpenDownloadModal}
                        className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
                      >
                        <Download className="w-3 h-3" /> Get models
                      </button>
                    </div>

                    {ollamaModels.length === 0 ? (
                      <p className="px-3 py-2 text-xs text-zinc-500 italic">
                        No local models found. Start Ollama and download a model.
                      </p>
                    ) : (
                      ollamaModels.map(m => (
                        <button
                          key={m.id}
                          onClick={() => {
                            updateAgent(activeAgent.id, { modelId: m.id, provider: 'ollama' });
                            setShowModelPicker(false);
                          }}
                          className={`w-full text-left px-3 py-2 text-sm hover:bg-zinc-700 transition-colors ${
                            activeAgent.modelId === m.id ? 'text-emerald-400' : 'text-zinc-200'
                          }`}
                        >
                          {m.name}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>

              {/* Web-search toggle */}
              <button
                onClick={() =>
                  updateAgent(activeAgent.id, { enableWebSearch: !activeAgent.enableWebSearch })
                }
                title={
                  activeAgent.enableWebSearch
                    ? 'Web search enabled (click to disable)'
                    : 'Enable web search'
                }
                className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md transition-colors ${
                  activeAgent.enableWebSearch
                    ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/30'
                    : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700'
                }`}
              >
                <Globe className="w-3.5 h-3.5" />
                Web
              </button>
            </div>

            {/* API key warning */}
            {activeAgent.provider === 'gemini' && !getGeminiApiKey() && (
              <div className="mx-5 mt-3 flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2.5 text-xs text-amber-300">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  No Gemini API key configured.{' '}
                  <button
                    onClick={handleOpenSettings}
                    className="underline hover:text-amber-100 transition-colors"
                  >
                    Open Settings
                  </button>{' '}
                  to enter your key, or switch to a local Ollama model.
                </span>
              </div>
            )}

            {/* Manager worker agents panel */}
            {activeAgent.role === 'manager' && agents.some(a => a.parentId === activeAgent.id) && (
              <div className="mx-4 mt-3 p-3 bg-indigo-500/10 border border-indigo-500/20 rounded-lg">
                <p className="text-xs font-semibold text-indigo-400 mb-2 flex items-center gap-1.5">
                  <Crown className="w-3 h-3" />
                  Worker Agents ({agents.filter(a => a.parentId === activeAgent.id).length})
                </p>
                <div className="flex flex-wrap gap-2">
                  {agents
                    .filter(a => a.parentId === activeAgent.id)
                    .map(worker => (
                      <button
                        key={worker.id}
                        onClick={() => { setActiveAgentId(worker.id); setShowGraphView(false); }}
                        title={`Switch to ${worker.name}`}
                        className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 hover:bg-indigo-500/20 transition-colors"
                      >
                        {worker.isLoading && (
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse inline-block" />
                        )}
                        {worker.name}
                      </button>
                    ))}
                </div>
              </div>
            )}

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-5 space-y-5">
              {activeAgent.messages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-3xl rounded-2xl px-4 py-3 ${
                      msg.role === 'user'
                        ? 'bg-emerald-600/20 text-emerald-50 border border-emerald-500/20'
                        : msg.role === 'system'
                        ? 'bg-zinc-800/50 text-zinc-400 text-sm border border-zinc-700/50'
                        : 'bg-zinc-900 border border-zinc-800 text-zinc-200'
                    }`}
                  >
                    {msg.role === 'system' ? (
                      <div className="flex items-center gap-2">
                        <AlertCircle className="w-4 h-4 shrink-0" />
                        {msg.content}
                      </div>
                    ) : (
                      <div className="prose prose-invert prose-sm max-w-none">
                        <Markdown>{msg.content}</Markdown>
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {activeAgent.isLoading && (
                <div className="flex justify-start">
                  <div className="bg-zinc-900 border border-zinc-800 rounded-2xl px-4 py-3 text-zinc-400 text-sm animate-pulse">
                    Thinking…
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="p-4 border-t border-zinc-800 bg-zinc-950">
              <div className="max-w-4xl mx-auto relative">
                <textarea
                  value={activeAgent.input}
                  onChange={e => updateAgent(activeAgent.id, { input: e.target.value })}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSendMessage(activeAgent.id);
                    }
                  }}
                  placeholder={
                    activeAgent.role === 'manager'
                      ? activeAgent.recursive
                        ? `${activeAgent.name} will work recursively until authoriser approves…`
                        : `${activeAgent.name} can spawn workers and delegate tasks…`
                      : activeAgent.role === 'authoriser'
                      ? `${activeAgent.name} reviews work and provides APPROVED/REJECTED decisions…`
                      : activeAgent.role === 'critic'
                      ? `${activeAgent.name} reviews outputs — use critique_output from a manager to submit work for review…`
                      : agents.length > 1
                      ? `Ask ${activeAgent.name} to write a document, build a tool, analyse data, or hand off to another agent…`
                      : `Ask ${activeAgent.name} to write a document, build a tool, run a script, or search the web…`
                  }
                  disabled={activeAgent.isLoading}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl pl-4 pr-12 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50 disabled:opacity-50 resize-none"
                  rows={1}
                />
                <button
                  onClick={() => handleSendMessage(activeAgent.id)}
                  disabled={!activeAgent.input.trim() || activeAgent.isLoading}
                  className="absolute right-2 top-2 p-1.5 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 rounded-lg disabled:opacity-50 transition-colors"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Right panel: script review + terminal (chat view only) */}
        {!showGraphView && (activeAgent.proposedScript || activeAgent.terminalLogs.length > 0 || activeAgent.episodicMemory.length > 0) && (
          <div className="w-[22rem] bg-zinc-900 border-l border-zinc-800 flex flex-col shrink-0">
            {activeAgent.proposedScript && (
              <div className="flex-1 flex flex-col border-b border-zinc-800 min-h-0">
                <div className="p-3 border-b border-zinc-800 flex items-center justify-between bg-zinc-950/50 shrink-0">
                  <h2 className="text-xs font-semibold flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    Review Script
                  </h2>
                  <button
                    onClick={() => handleRunScript(activeAgent.id)}
                    className="flex items-center gap-1 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 text-xs font-bold py-1 px-2.5 rounded-md transition-colors"
                  >
                    <Play className="w-3 h-3" />
                    Run
                  </button>
                </div>
                <div className="p-3 text-xs text-zinc-400 bg-zinc-900/50 border-b border-zinc-800 shrink-0">
                  {activeAgent.proposedScript.explanation}
                </div>
                <div className="flex-1 overflow-y-auto p-3 bg-[#0d0d0d]">
                  <pre className="text-xs font-mono text-zinc-300 whitespace-pre-wrap">
                    {activeAgent.proposedScript.code}
                  </pre>
                </div>
              </div>
            )}

            {/* Episodic memory: task progress log */}
            {activeAgent.episodicMemory.length > 0 && (
              <div className="flex flex-col border-b border-zinc-800 max-h-44 shrink-0">
                <div className="p-2 border-b border-zinc-800 bg-zinc-950/50 shrink-0">
                  <h2 className="text-xs font-bold text-zinc-500 uppercase tracking-wider px-1 flex items-center gap-1.5">
                    <CheckCircle2 className="w-3 h-3 text-emerald-500/70" />
                    Task Progress
                  </h2>
                </div>
                <div className="overflow-y-auto p-3 bg-[#0a0a0a] font-mono text-xs text-zinc-400 space-y-0.5">
                  {activeAgent.episodicMemory.map((entry, i) => (
                    <div key={i} className="flex items-start gap-1.5 break-words">
                      <span className="text-emerald-500/70 shrink-0 mt-px">✓</span>
                      <span>{entry}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className={`flex flex-col ${!activeAgent.proposedScript ? 'flex-1' : 'h-40'}`}>
              <div className="p-2 border-b border-zinc-800 bg-zinc-950/50 shrink-0">
                <h2 className="text-xs font-bold text-zinc-500 uppercase tracking-wider px-1">
                  Terminal
                </h2>
              </div>
              <div className="flex-1 overflow-y-auto p-3 bg-[#0a0a0a] font-mono text-xs text-zinc-400 space-y-0.5">
                {activeAgent.terminalLogs.length === 0 ? (
                  <div className="text-zinc-600 italic">No output yet…</div>
                ) : (
                  activeAgent.terminalLogs.map((log, i) => (
                    <div key={i} className="break-words">{log}</div>
                  ))
                )}
                <div ref={messagesEndRef} />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Download model modal ───────────────────────────────────────────── */}
      {showDownloadModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold">Download Local Model (Ollama)</h2>
              <button onClick={handleCloseDownloadModal} className="text-zinc-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-zinc-400 mb-4">
              Requires{' '}
              <a href="https://ollama.com/download" target="_blank" rel="noreferrer" className="text-emerald-400 hover:underline">
                Ollama
              </a>{' '}
              to be running locally or inside Docker. After installing Ollama, use the Download button next to each model below to pull it — models are stored in the Ollama data directory.
              If Ollama is not yet set up, open{' '}
              <button onClick={() => { setShowDownloadModal(false); handleOpenSettings(); }} className="text-emerald-400 hover:underline">
                Settings
              </button>{' '}
              for setup instructions.
            </p>

            <div className="space-y-2 max-h-64 overflow-y-auto">
              {POPULAR_OLLAMA_MODELS.map(m => {
                const isInstalled = ollamaModels.some(om => om.id === m.id);
                const isDownloading = downloadingModel === m.id;
                return (
                  <div key={m.id} className="flex items-center justify-between p-2.5 bg-zinc-800 rounded-lg">
                    <div>
                      <p className="text-sm font-medium">{m.name}</p>
                      <p className="text-xs text-zinc-500">{m.size}</p>
                    </div>
                    <button
                      onClick={() => handleDownloadModel(m.id)}
                      disabled={isInstalled || isDownloading || !!downloadingModel}
                      className={`text-xs px-3 py-1.5 rounded-md font-medium transition-colors ${
                        isInstalled
                          ? 'bg-zinc-700 text-zinc-400 cursor-default'
                          : 'bg-emerald-500 hover:bg-emerald-400 text-zinc-950 disabled:opacity-50'
                      }`}
                    >
                      {isInstalled ? 'Installed' : isDownloading ? 'Pulling…' : 'Download'}
                    </button>
                  </div>
                );
              })}
            </div>

            {downloadStatus && (
              <p className="mt-3 text-xs text-zinc-400 font-mono break-words">{downloadStatus}</p>
            )}
          </div>
        </div>
      )}

      {/* ── Settings modal ────────────────────────────────────────────────── */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-full max-w-md shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-semibold flex items-center gap-2">
                <Settings className="w-4 h-4 text-emerald-400" />
                Settings
              </h2>
              <button onClick={() => setShowSettings(false)} className="text-zinc-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Gemini API Key section */}
            <p className="text-xs font-semibold text-zinc-300 uppercase tracking-wider mb-2">
              Gemini API Key
            </p>
            <p className="text-xs text-zinc-400 mb-3">
              Required for cloud Gemini models. Get your free key at{' '}
              <a
                href="https://aistudio.google.com/app/apikey"
                target="_blank"
                rel="noreferrer"
                className="text-emerald-400 hover:underline"
              >
                aistudio.google.com
              </a>
              . The key is stored only in your browser's local storage — avoid using it on shared devices.
            </p>
            <input
              type="password"
              id="gemini-api-key"
              aria-label="Gemini API key"
              value={geminiApiKeyInput}
              onChange={e => setGeminiApiKeyInput(e.target.value)}
              placeholder="AIza…"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50 mb-5 font-mono"
            />

            <hr className="border-zinc-800 mb-5" />

            {/* Ollama section */}
            <p className="text-xs font-semibold text-zinc-300 uppercase tracking-wider mb-2">
              Ollama (Local Models)
            </p>
            <p className="text-xs text-zinc-400 mb-3">
              Point the app at a local or remote Ollama instance.{' '}
              <a
                href="https://ollama.com/download"
                target="_blank"
                rel="noreferrer"
                className="text-emerald-400 hover:underline"
              >
                Download Ollama
              </a>{' '}
              and install it, then models can be pulled from the model picker.
            </p>

            <label className="block text-xs font-medium text-zinc-400 mb-1">Ollama URL</label>
            <div className="flex gap-2 mb-3">
              <input
                type="url"
                value={ollamaUrlInput}
                onChange={e => { setOllamaUrlInput(e.target.value); setConnectionStatus('idle'); }}
                placeholder="http://localhost:11434"
                className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
              />
              <button
                onClick={handleTestConnection}
                disabled={connectionStatus === 'testing'}
                className="px-3 py-2 bg-zinc-700 hover:bg-zinc-600 text-sm rounded-lg transition-colors disabled:opacity-50"
              >
                {connectionStatus === 'testing' ? 'Testing…' : 'Test'}
              </button>
            </div>

            {connectionStatus === 'ok' && (
              <p className="text-xs text-emerald-400 mb-3 flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5" /> Connected successfully
              </p>
            )}
            {connectionStatus === 'fail' && (
              <p className="text-xs text-red-400 mb-3 flex items-center gap-1">
                <AlertCircle className="w-3.5 h-3.5" /> Could not reach Ollama at that URL
              </p>
            )}

            <div className="bg-zinc-800/60 rounded-lg p-3 mb-5 text-xs text-zinc-400 space-y-1">
              <p className="font-semibold text-zinc-300">Quick-start with Docker:</p>
              <p>1. Install Docker, then run:</p>
              <pre className="text-emerald-400 mt-1">docker compose up -d</pre>
              <p className="mt-1">For NVIDIA GPU (EC2):</p>
              <pre className="text-emerald-400 mt-1">
                docker compose -f docker-compose.yml \{'\n'}
                {'               '}-f docker-compose.gpu.yml up -d
              </pre>
              <p className="mt-1">Then set the URL to <code>http://&lt;server-ip&gt;:11434</code></p>
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowSettings(false)}
                className="px-4 py-2 text-sm text-zinc-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveSettings}
                className="px-4 py-2 text-sm bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-medium rounded-lg transition-colors"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── First-run Ollama setup dialog (Electron only) ─────────────────── */}
      {showOllamaSetup && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-full max-w-md shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-emerald-500/15 flex items-center justify-center shrink-0">
                <Download className="w-5 h-5 text-emerald-400" />
              </div>
              <div>
                <h2 className="text-base font-semibold">Install Ollama?</h2>
                <p className="text-xs text-zinc-400 mt-0.5">Required to run AI models locally on your machine</p>
              </div>
            </div>

            {ollamaInstallStatus === 'idle' && (
              <>
                <p className="text-sm text-zinc-300 mb-4">
                  Ollama was not detected on your system. It lets you run powerful AI models
                  completely offline — no API key needed.
                  Would you like Local LM to download and install it now?
                </p>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={handleDismissOllamaSetup}
                    className="px-4 py-2 text-sm text-zinc-400 hover:text-white transition-colors"
                  >
                    Skip for now
                  </button>
                  <button
                    onClick={handleInstallOllama}
                    className="px-4 py-2 text-sm bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-medium rounded-lg transition-colors flex items-center gap-2"
                  >
                    <Download className="w-4 h-4" />
                    Download &amp; Install
                  </button>
                </div>
              </>
            )}

            {ollamaInstallStatus === 'downloading' && (
              <div className="space-y-3">
                <div className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
                  <div className="h-full bg-emerald-500 rounded-full animate-pulse w-full" />
                </div>
                <p className="text-xs text-zinc-400 font-mono break-words">
                  {ollamaInstallProgress || 'Starting…'}
                </p>
              </div>
            )}

            {ollamaInstallStatus === 'done' && (
              <>
                <div className="flex items-center gap-2 text-emerald-400 mb-3">
                  <CheckCircle2 className="w-5 h-5 shrink-0" />
                  <p className="text-sm font-medium">Ollama installer launched!</p>
                </div>
                <p className="text-xs text-zinc-400 mb-4">
                  {ollamaInstallProgress || 'Follow the on-screen setup instructions to complete the installation.'}
                  {' '}Once Ollama is running, use the model picker to download a local AI model.
                </p>
                <div className="flex justify-end">
                  <button
                    onClick={handleDismissOllamaSetup}
                    className="px-4 py-2 text-sm bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-medium rounded-lg transition-colors"
                  >
                    Got it
                  </button>
                </div>
              </>
            )}

            {ollamaInstallStatus === 'error' && (
              <>
                <div className="flex items-center gap-2 text-red-400 mb-2">
                  <AlertCircle className="w-5 h-5 shrink-0" />
                  <p className="text-sm font-medium">Download failed</p>
                </div>
                <p className="text-xs text-zinc-400 font-mono break-words mb-4">
                  {ollamaInstallProgress}
                </p>
                <p className="text-xs text-zinc-400 mb-4">
                  You can install Ollama manually from{' '}
                  <a
                    href="https://ollama.com/download"
                    target="_blank"
                    rel="noreferrer"
                    className="text-emerald-400 hover:underline"
                  >
                    ollama.com/download
                  </a>
                  .
                </p>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={handleDismissOllamaSetup}
                    className="px-4 py-2 text-sm text-zinc-400 hover:text-white transition-colors"
                  >
                    Dismiss
                  </button>
                  <button
                    onClick={() => {
                      setOllamaInstallStatus('idle');
                      setOllamaInstallProgress('');
                    }}
                    className="px-4 py-2 text-sm bg-zinc-700 hover:bg-zinc-600 text-white font-medium rounded-lg transition-colors"
                  >
                    Retry
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── System Prompt Editor modal ────────────────────────────────────── */}
      {showPromptModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-full max-w-lg shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-emerald-400" />
                Agent System Prompt — {activeAgent.name}
              </h2>
              <button
                onClick={() => setShowPromptModal(false)}
                className="text-zinc-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-zinc-400 mb-3">
              Provide task context, goals, or constraints for this agent. This is appended to the
              default system instruction and shapes how the agent interprets every message.
              {activeAgent.role === 'authoriser' && (
                <span className="block mt-1 text-amber-400">
                  Authoriser tip: describe the quality criteria and what APPROVED vs REJECTED should mean.
                </span>
              )}
              {activeAgent.role === 'manager' && activeAgent.recursive && (
                <span className="block mt-1 text-purple-400">
                  Recursive manager tip: specify the acceptance criteria the authoriser should check.
                </span>
              )}
            </p>

            <textarea
              value={promptDraft}
              onChange={e => setPromptDraft(e.target.value)}
              placeholder={
                activeAgent.role === 'authoriser'
                  ? 'e.g. Approve only if the work is complete, well-documented, and all sub-tasks are finished. Reject if any part is missing or unclear.'
                  : activeAgent.role === 'manager'
                  ? 'e.g. You are managing a research team. Break the task into literature review, analysis, and summary sub-tasks. Ensure every claim is cited.'
                  : 'e.g. Focus on Python 3.10+. Always add type hints. Write tests alongside any code you produce.'
              }
              rows={7}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-sm text-zinc-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 resize-none mb-4"
            />

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowPromptModal(false)}
                className="px-4 py-2 text-sm text-zinc-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              {promptDraft.trim() && (
                <button
                  onClick={() => {
                    updateAgent(activeAgent.id, { systemPrompt: '' });
                    setPromptDraft('');
                    setShowPromptModal(false);
                  }}
                  className="px-4 py-2 text-sm text-zinc-400 hover:text-red-400 transition-colors"
                >
                  Clear
                </button>
              )}
              <button
                onClick={handleSavePrompt}
                className="px-4 py-2 text-sm bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-medium rounded-lg transition-colors"
              >
                Save Prompt
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
