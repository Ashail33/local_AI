import React, { useState, useEffect, useRef, useCallback } from 'react';
import Markdown from 'react-markdown';
import {
  FolderOpen, FileText, Send, Play, Terminal, CheckCircle2,
  AlertCircle, Plus, X, Edit2, Globe, ChevronDown, Download,
} from 'lucide-react';
import { pickDirectory, listFiles } from './lib/fs';
import { initPython, runPythonScript } from './lib/python';
import { processChatTurn } from './lib/ai';
import {
  listOllamaModels, pullOllamaModel,
  DEFAULT_GEMINI_MODELS, POPULAR_OLLAMA_MODELS,
  type Model, type ModelProvider,
} from './lib/models';

type Message = { role: 'user' | 'assistant' | 'system'; content: string };

interface Agent {
  id: string;
  name: string;
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

function createAgent(name?: string): Agent {
  return {
    id: crypto.randomUUID(),
    name: name ?? `Agent ${agentCounter++}`,
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

export default function App() {
  const initialAgent = createAgent();
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

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const tabInputRef = useRef<HTMLInputElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);

  const activeAgent = agents.find(a => a.id === activeAgentId) ?? agents[0];

  // Probe for available Ollama models once on mount
  useEffect(() => {
    listOllamaModels().then(models => setOllamaModels(models));
  }, []);

  // Scroll to bottom when active agent's messages change
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
    const agent = agents.find(a => a.id === agentId);
    if (agent?.dirHandle) {
      const fileList = await listFiles(agent.dirHandle);
      updateAgent(agentId, { files: fileList });
    }
  };

  // ── Chat ────────────────────────────────────────────────────────────────────

  const handleSendMessage = async (agentId: string) => {
    const agent = agents.find(a => a.id === agentId);
    if (!agent || !agent.input.trim() || agent.isLoading) return;

    const userMsg = agent.input;
    updateAgent(agentId, {
      input: '',
      isLoading: true,
      messages: [...agent.messages, { role: 'user', content: userMsg }],
    });

    const logToTerminal = (msg: string) => {
      setAgents(prev =>
        prev.map(a =>
          a.id === agentId ? { ...a, terminalLogs: [...a.terminalLogs, msg] } : a,
        ),
      );
    };

    const onProposeScript = (script: string, explanation: string) => {
      updateAgent(agentId, { proposedScript: { code: script, explanation } });
    };

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
                messages: [
                  ...a.messages,
                  { role: 'system', content: `Error: ${err.message}` },
                ],
              }
            : a,
        ),
      );
    }
  };

  // ── Python script runner ────────────────────────────────────────────────────

  const handleRunScript = async (agentId: string) => {
    const agent = agents.find(a => a.id === agentId);
    if (!agent?.proposedScript || !agent.dirHandle) return;

    const logToTerminal = (msg: string) => {
      setAgents(prev =>
        prev.map(a =>
          a.id === agentId ? { ...a, terminalLogs: [...a.terminalLogs, msg] } : a,
        ),
      );
    };

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
                messages: [
                  ...a.messages,
                  { role: 'system', content: 'Python script execution completed.' },
                ],
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

  // ── Derived values ──────────────────────────────────────────────────────────

  const allModels: Model[] = [...DEFAULT_GEMINI_MODELS, ...ollamaModels];
  const currentModelLabel =
    allModels.find(m => m.id === activeAgent.modelId)?.name ?? activeAgent.modelId;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100 font-sans">

      {/* ── Agent tab bar ─────────────────────────────────────────────────── */}
      <div className="flex items-center bg-zinc-900 border-b border-zinc-800 overflow-x-auto shrink-0">
        <div className="flex items-center gap-1 px-2 py-1 flex-1 min-w-0">
          {agents.map(agent => (
            <div
              key={agent.id}
              onClick={() => setActiveAgentId(agent.id)}
              onDoubleClick={() => startRenameTab(agent)}
              title="Double-click to rename"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md cursor-pointer text-sm select-none transition-colors min-w-0 max-w-[10rem] shrink-0 ${
                agent.id === activeAgentId
                  ? 'bg-zinc-700 text-white'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
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
                  <Edit2 className="w-3 h-3 text-zinc-600 shrink-0" />
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

        <span className="text-xs text-zinc-600 px-3 shrink-0 hidden sm:block">
          Double-click tab to rename
        </span>
      </div>

      {/* ── Main content (sidebar + chat + right panel) ────────────────────── */}
      <div className="flex flex-1 min-h-0">

        {/* Sidebar */}
        <div className="w-56 bg-zinc-900 border-r border-zinc-800 flex flex-col shrink-0">
          <div className="p-3 border-b border-zinc-800">
            <h1 className="text-sm font-semibold tracking-tight flex items-center gap-2">
              <Terminal className="w-4 h-4 text-emerald-400" />
              Local LM
            </h1>
          </div>

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
        </div>

        {/* Chat area */}
        <div className="flex-1 flex flex-col min-w-0">

          {/* Agent toolbar: model selector + web-search toggle */}
          <div className="flex items-center gap-3 px-4 py-2 border-b border-zinc-800 bg-zinc-900/50 shrink-0">
            <span className="text-xs text-zinc-500 font-medium truncate max-w-[8rem]">
              {activeAgent.name}
            </span>

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
                  {/* Gemini models */}
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

                  {/* Ollama models */}
                  <div className="px-3 py-2 border-t border-b border-zinc-700 flex items-center justify-between">
                    <p className="text-xs text-zinc-400 font-semibold uppercase tracking-wider">
                      Local (Ollama)
                    </p>
                    <button
                      onClick={() => { setShowDownloadModal(true); setShowModelPicker(false); }}
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
                activeAgent.enableWebSearch ? 'Web search enabled (click to disable)' : 'Enable web search'
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
                    ? `Ask ${activeAgent.name} to create a file, search the web, write a script…`
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

        {/* Right panel: script review + terminal */}
        {(activeAgent.proposedScript || activeAgent.terminalLogs.length > 0) && (
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
              <button
                onClick={() => { setShowDownloadModal(false); setDownloadStatus(''); }}
                className="text-zinc-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-zinc-400 mb-4">
              Requires{' '}
              <a
                href="https://ollama.com"
                target="_blank"
                rel="noreferrer"
                className="text-emerald-400 hover:underline"
              >
                Ollama
              </a>{' '}
              to be running locally or inside Docker. Models are stored in the Ollama volume.
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
    </div>
  );
}
