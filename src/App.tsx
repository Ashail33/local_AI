import React, { useState, useEffect, useRef } from 'react';
import Markdown from 'react-markdown';
import { FolderOpen, FileText, Send, Play, Terminal, CheckCircle2, AlertCircle } from 'lucide-react';
import { pickDirectory, listFiles } from './lib/fs';
import { initPython, runPythonScript } from './lib/python';
import { processChatTurn } from './lib/ai';

type Message = { role: 'user' | 'assistant' | 'system'; content: string };

export default function App() {
  const [dirHandle, setDirHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: 'Hello! I am your Local AI Assistant. Please select a workspace folder to get started.' }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  
  // Python & Code Review State
  const [proposedScript, setProposedScript] = useState<{code: string, explanation: string} | null>(null);
  const [terminalLogs, setTerminalLogs] = useState<string[]>([]);
  const [pyodideInstance, setPyodideInstance] = useState<any>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, terminalLogs]);

  const handleOpenFolder = async () => {
    try {
      const handle = await pickDirectory();
      setDirHandle(handle);
      const fileList = await listFiles(handle);
      setFiles(fileList);
      setMessages(prev => [...prev, { role: 'system', content: `Workspace connected. Found ${fileList.length} files.` }]);
    } catch (err) {
      console.error(err);
    }
  };

  const refreshFiles = async () => {
    if (dirHandle) {
      const fileList = await listFiles(dirHandle);
      setFiles(fileList);
    }
  };

  const logToTerminal = (msg: string) => {
    setTerminalLogs(prev => [...prev, msg]);
  };

  const handleSendMessage = async () => {
    if (!input.trim()) return;
    
    const userMsg = input;
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
    setIsLoading(true);

    try {
      const responseMsg = await processChatTurn(
        userMsg,
        messages.filter(m => m.role !== 'system'),
        dirHandle,
        (script, explanation) => {
          setProposedScript({ code: script, explanation });
        },
        logToTerminal
      );
      
      setMessages(prev => [...prev, responseMsg as Message]);
      await refreshFiles();
    } catch (err: any) {
      setMessages(prev => [...prev, { role: 'system', content: `Error: ${err.message}` }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRunScript = async () => {
    if (!proposedScript || !dirHandle) return;
    
    try {
      let py = pyodideInstance;
      if (!py) {
        py = await initPython(dirHandle, logToTerminal);
        setPyodideInstance(py);
      }
      
      await runPythonScript(proposedScript.code, py, logToTerminal);
      await refreshFiles();
      setMessages(prev => [...prev, { role: 'system', content: 'Python script execution completed.' }]);
      setProposedScript(null); // Clear after running
    } catch (err: any) {
      logToTerminal(`Execution Error: ${err.message}`);
    }
  };

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100 font-sans">
      {/* Sidebar - Workspace */}
      <div className="w-64 bg-zinc-900 border-r border-zinc-800 flex flex-col">
        <div className="p-4 border-b border-zinc-800">
          <h1 className="text-lg font-semibold tracking-tight flex items-center gap-2">
            <Terminal className="w-5 h-5 text-emerald-400" />
            Local LM
          </h1>
        </div>
        
        <div className="p-4 flex-1 overflow-y-auto">
          <button 
            onClick={handleOpenFolder}
            className="w-full flex items-center justify-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-sm font-medium py-2 px-4 rounded-lg transition-colors mb-4"
          >
            <FolderOpen className="w-4 h-4" />
            {dirHandle ? 'Change Folder' : 'Open Folder'}
          </button>

          {dirHandle && (
            <div>
              <h2 className="text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Workspace Files</h2>
              <ul className="space-y-1">
                {files.length === 0 ? (
                  <li className="text-sm text-zinc-500 italic">Empty folder</li>
                ) : (
                  files.map(f => (
                    <li key={f} className="text-sm flex items-center gap-2 text-zinc-300 hover:text-white cursor-default">
                      <FileText className="w-3 h-3 text-zinc-500" />
                      <span className="truncate">{f}</span>
                    </li>
                  ))
                )}
              </ul>
            </div>
          )}
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-3xl rounded-2xl px-5 py-4 ${
                msg.role === 'user' 
                  ? 'bg-emerald-600/20 text-emerald-50 border border-emerald-500/20' 
                  : msg.role === 'system'
                  ? 'bg-zinc-800/50 text-zinc-400 text-sm border border-zinc-700/50'
                  : 'bg-zinc-900 border border-zinc-800 text-zinc-200'
              }`}>
                {msg.role === 'system' ? (
                  <div className="flex items-center gap-2">
                    <AlertCircle className="w-4 h-4" />
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
          {isLoading && (
            <div className="flex justify-start">
              <div className="bg-zinc-900 border border-zinc-800 rounded-2xl px-5 py-4 text-zinc-400 text-sm animate-pulse">
                Thinking...
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Area */}
        <div className="p-4 border-t border-zinc-800 bg-zinc-950">
          <div className="max-w-4xl mx-auto relative">
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSendMessage();
                }
              }}
              placeholder={dirHandle ? "Ask me to create a file, analyze data, or write a script..." : "Please open a folder first..."}
              disabled={!dirHandle || isLoading}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-xl pl-4 pr-12 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50 disabled:opacity-50 resize-none"
              rows={1}
            />
            <button 
              onClick={handleSendMessage}
              disabled={!input.trim() || !dirHandle || isLoading}
              className="absolute right-2 top-2 p-1.5 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 rounded-lg disabled:opacity-50 transition-colors"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Right Panel - Code Review & Terminal */}
      {(proposedScript || terminalLogs.length > 0) && (
        <div className="w-96 bg-zinc-900 border-l border-zinc-800 flex flex-col">
          {proposedScript && (
            <div className="flex-1 flex flex-col border-b border-zinc-800">
              <div className="p-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-950/50">
                <h2 className="text-sm font-semibold flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  Review Script
                </h2>
                <button 
                  onClick={handleRunScript}
                  className="flex items-center gap-1 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 text-xs font-bold py-1.5 px-3 rounded-md transition-colors"
                >
                  <Play className="w-3 h-3" />
                  Run
                </button>
              </div>
              <div className="p-4 text-sm text-zinc-400 bg-zinc-900/50 border-b border-zinc-800">
                {proposedScript.explanation}
              </div>
              <div className="flex-1 overflow-y-auto p-4 bg-[#0d0d0d]">
                <pre className="text-xs font-mono text-zinc-300 whitespace-pre-wrap">
                  {proposedScript.code}
                </pre>
              </div>
            </div>
          )}
          
          <div className={`flex-1 flex flex-col ${!proposedScript ? 'h-full' : ''}`}>
            <div className="p-2 border-b border-zinc-800 bg-zinc-950/50">
              <h2 className="text-xs font-bold text-zinc-500 uppercase tracking-wider px-2">Terminal</h2>
            </div>
            <div className="flex-1 overflow-y-auto p-4 bg-[#0a0a0a] font-mono text-xs text-zinc-400 space-y-1">
              {terminalLogs.length === 0 ? (
                <div className="text-zinc-600 italic">No output yet...</div>
              ) : (
                terminalLogs.map((log, i) => (
                  <div key={i} className="break-words">{log}</div>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
