import React, { useState, useEffect, useRef, useCallback } from 'react';
import Markdown from 'react-markdown';
import {
  FolderOpen, FileText, Send, Play, Terminal, CheckCircle2,
  AlertCircle, Plus, X, Edit2, Globe, ChevronDown, Download, Settings,
  Network, Crown,
} from 'lucide-react';
import { pickDirectory, listFiles } from './lib/fs';
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

// ── Types ─────────────────────────────────────────────────────────────────────

type Message = { role: 'user' | 'assistant' | 'system'; content: string };

interface Agent {
  id: string;
  name: string;
  /** Manager agents can spawn workers and delegate tasks to them. */
  role: 'manager' | 'worker';
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
}

let agentCounter = 1;

function createAgent(name?: string, role: Agent['role'] = 'worker', parentId: string | null = null): Agent {
  return {
    id: crypto.randomUUID(),
    name: name ?? `Agent ${agentCounter++}`,
    role,
    parentId,
    modelId: 'gemini-3.1-pro-preview',
    provider: 'gemini',
    enableWebSearch: false,
    messages: [
      {
        role: 'assistant',
        content:
          'Hello! I am your Local AI Assistant. Please select a workspace folder to get started.',
      },
    ],
    dirHandle: null,
    files: [],
    terminalLogs: [],
    proposedScript: null,
    isLoading: false,
    input: '',
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
  /** Toggle between the chat view and the agent-topology graph view. */
  const [showGraphView, setShowGraphView] = useState(false);

  // Ollama settings
  const [showSettings, setShowSettings] = useState(false);
  const [ollamaUrlInput, setOllamaUrlInput] = useState(getOllamaUrl);
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');

  // Gemini API key
  const [geminiApiKeyInput, setGeminiApiKeyInput] = useState(getGeminiApiKey);

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

  // ── Agent tab management ────────────────────────────────────────────────────

  const addAgent = () => {
    const agent = createAgent();
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
    // Remove message links involving this agent
    setMessageLinks(prev => prev.filter(l => l.fromId !== id && l.toId !== id));
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
   * Creates a new worker agent parented to managerId and returns its ref.
   */
  const buildSpawnAgentCallback = (managerId: string) =>
    async (name: string, task: string): Promise<AgentRef> => {
      const managerAgent = agentsRef.current.find(a => a.id === managerId);
      const newWorker = createAgent(name, 'worker', managerId);
      // Inherit workspace from manager if available
      if (managerAgent?.dirHandle) {
        newWorker.dirHandle = managerAgent.dirHandle;
        newWorker.files = managerAgent.files;
      }
      // Seed the worker's history with the initial task as a system note
      newWorker.messages = [
        ...newWorker.messages,
        { role: 'system', content: `Initial task from manager: ${task}` },
      ];
      setAgents(prev => [...prev, newWorker]);
      // Record spawn link
      setMessageLinks(prev => [
        ...prev,
        { fromId: managerId, toId: newWorker.id, messageCount: 0, lastMessage: task },
      ]);
      return { id: newWorker.id, name: newWorker.name };
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
          },
        );

        reply = response.content;

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
        if (existing) {
          return prev.map(l =>
            l.fromId === managerId && l.toId === targetId
              ? { ...l, messageCount: l.messageCount + 1, lastMessage: message }
              : l,
          );
        }
        return [...prev, { fromId: managerId, toId: targetId, messageCount: 1, lastMessage: message }];
      });

      return reply;
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
          spawnedAgents,
          onSpawnAgent: agent.role === 'manager' ? buildSpawnAgentCallback(agentId) : undefined,
          onMessageAgent:
            agent.role === 'manager'
              ? buildMessageAgentCallback(agentId, agent.name)
              : undefined,
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
            title="New Agent"
            className="flex items-center gap-1 px-2 py-1.5 text-zinc-400 hover:text-emerald-400 hover:bg-zinc-800 rounded-md text-sm transition-colors shrink-0"
          >
            <Plus className="w-4 h-4" />
            <span className="text-xs">New Agent</span>
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
            <div className="p-3 text-xs text-zinc-500 space-y-2">
              <p className="font-semibold text-zinc-400 uppercase tracking-wider text-[10px]">
                Agent Network
              </p>
              <p>{agents.length} agent{agents.length !== 1 ? 's' : ''}</p>
              <p>{agents.filter(a => a.role === 'manager').length} manager{agents.filter(a => a.role === 'manager').length !== 1 ? 's' : ''}</p>
              <p>{dedupedMessageLinks.filter(l => l.messageCount > 0).length} communication link{dedupedMessageLinks.filter(l => l.messageCount > 0).length !== 1 ? 's' : ''}</p>
              <hr className="border-zinc-800 my-1" />
              <p className="text-zinc-600">Click a node to open that agent's chat.</p>
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
            }))}
            activeAgentId={activeAgentId}
            messageLinks={dedupedMessageLinks}
            onSelectAgent={id => {
              setActiveAgentId(id);
              setShowGraphView(false);
            }}
          />
        ) : (
          /* ── Chat View ───────────────────────────────────────────────── */
          <div className="flex-1 flex flex-col min-w-0">

            {/* Agent toolbar */}
            <div className="flex items-center gap-3 px-4 py-2 border-b border-zinc-800 bg-zinc-900/50 shrink-0">
              <span className="text-xs text-zinc-500 font-medium truncate max-w-[8rem] flex items-center gap-1">
                {activeAgent.role === 'manager' && (
                  <Crown className="w-3 h-3 text-indigo-400 shrink-0" />
                )}
                {activeAgent.name}
              </span>

              {/* Manager / Worker role toggle */}
              <button
                onClick={() =>
                  updateAgent(activeAgent.id, {
                    role: activeAgent.role === 'manager' ? 'worker' : 'manager',
                  })
                }
                title={
                  activeAgent.role === 'manager'
                    ? 'Manager mode — click to make worker'
                    : 'Worker mode — click to promote to manager'
                }
                className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md transition-colors ${
                  activeAgent.role === 'manager'
                    ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/30'
                    : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700'
                }`}
              >
                <Crown className="w-3 h-3" />
                {activeAgent.role === 'manager' ? 'Manager' : 'Worker'}
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
                    activeAgent.dirHandle
                      ? activeAgent.role === 'manager'
                        ? `${activeAgent.name} can spawn workers and delegate tasks…`
                        : `Ask ${activeAgent.name} to create a file, search the web, write a script…`
                      : 'Please open a folder first…'
                  }
                  disabled={!activeAgent.dirHandle || activeAgent.isLoading}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl pl-4 pr-12 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50 disabled:opacity-50 resize-none"
                  rows={1}
                />
                <button
                  onClick={() => handleSendMessage(activeAgent.id)}
                  disabled={!activeAgent.input.trim() || !activeAgent.dirHandle || activeAgent.isLoading}
                  className="absolute right-2 top-2 p-1.5 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 rounded-lg disabled:opacity-50 transition-colors"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Right panel: script review + terminal (chat view only) */}
        {!showGraphView && (activeAgent.proposedScript || activeAgent.terminalLogs.length > 0) && (
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
    </div>
  );
}
