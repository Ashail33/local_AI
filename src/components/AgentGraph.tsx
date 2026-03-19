import React, { useState, useCallback, useEffect, useRef } from 'react';
import type { ModelProvider } from '../lib/models';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GraphAgent {
  id: string;
  name: string;
  role: 'manager' | 'worker' | 'authoriser';
  provider: ModelProvider;
  modelId: string;
  parentId: string | null;
  isLoading: boolean;
  recursive: boolean;
}

export interface MessageLink {
  fromId: string;
  toId: string;
  messageCount: number;
  lastMessage: string;
}

interface AgentGraphProps {
  agents: GraphAgent[];
  activeAgentId: string;
  messageLinks: MessageLink[];
  onSelectAgent: (id: string) => void;
  /** Called when the user manually draws a message link between two agents. */
  onCreateLink?: (fromId: string, toId: string) => void;
  /** Called when the user sets one agent as the parent of another. */
  onSetParent?: (childId: string, parentId: string) => void;
  /** Called when the user removes the parent of an agent (makes it a root). */
  onRemoveParent?: (agentId: string) => void;
}

// ── Layout ────────────────────────────────────────────────────────────────────

const NODE_W = 164;
const NODE_H = 60;
const H_GAP = 72;
const V_GAP = 80;
const MARGIN = 48;

interface Pos { x: number; y: number }

function computeLayout(agents: GraphAgent[]): Map<string, Pos> {
  const positions = new Map<string, Pos>();
  if (agents.length === 0) return positions;

  // Build children map
  const childrenOf = new Map<string | null, string[]>();
  for (const a of agents) {
    const key = a.parentId ?? null;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key)!.push(a.id);
  }

  // Compute minimum subtree width needed for each node
  const subtreeW = new Map<string, number>();
  const calcWidth = (id: string): number => {
    const children = childrenOf.get(id) ?? [];
    if (children.length === 0) {
      subtreeW.set(id, NODE_W);
      return NODE_W;
    }
    const total = children.reduce(
      (sum, cid, i) => sum + calcWidth(cid) + (i > 0 ? H_GAP : 0),
      0,
    );
    subtreeW.set(id, total);
    return total;
  };

  const roots = childrenOf.get(null) ?? [];
  roots.forEach(r => calcWidth(r));

  // Place nodes in a top-down tree
  const placeNode = (id: string, centerX: number, y: number) => {
    positions.set(id, { x: centerX - NODE_W / 2, y });
    const children = childrenOf.get(id) ?? [];
    if (children.length === 0) return;
    const totalW = children.reduce(
      (sum, cid, i) => sum + (subtreeW.get(cid) ?? NODE_W) + (i > 0 ? H_GAP : 0),
      0,
    );
    let cx = centerX - totalW / 2;
    for (const cid of children) {
      const cw = subtreeW.get(cid) ?? NODE_W;
      placeNode(cid, cx + cw / 2, y + NODE_H + V_GAP);
      cx += cw + H_GAP;
    }
  };

  let xOff = MARGIN;
  for (const rootId of roots) {
    const rw = subtreeW.get(rootId) ?? NODE_W;
    placeNode(rootId, xOff + rw / 2, MARGIN);
    xOff += rw + H_GAP * 2;
  }

  return positions;
}

// ── Component ─────────────────────────────────────────────────────────────────

type ConnectMode = 'none' | 'link' | 'parent';

export default function AgentGraph({
  agents,
  activeAgentId,
  messageLinks,
  onSelectAgent,
  onCreateLink,
  onSetParent,
  onRemoveParent,
}: AgentGraphProps) {
  const [positions, setPositions] = useState<Map<string, Pos>>(() => computeLayout(agents));
  const [connectMode, setConnectMode] = useState<ConnectMode>('none');
  const [pendingId, setPendingId] = useState<string | null>(null);

  const dragging = useRef<{
    id: string;
    startMx: number;
    startMy: number;
    origX: number;
    origY: number;
  } | null>(null);

  // Re-layout only for newly added agents; preserve user-dragged positions
  useEffect(() => {
    const fresh = computeLayout(agents);
    setPositions(prev => {
      const next = new Map(prev);
      for (const [id, pos] of fresh) {
        if (!next.has(id)) next.set(id, pos);
      }
      // Remove stale entries
      for (const id of next.keys()) {
        if (!agents.find(a => a.id === id)) next.delete(id);
      }
      return next;
    });
  }, [agents]);

  // Reset connect mode when agents list changes (e.g. agent removed)
  useEffect(() => {
    if (pendingId && !agents.find(a => a.id === pendingId)) {
      setPendingId(null);
      setConnectMode('none');
    }
  }, [agents, pendingId]);

  const handleMouseDown = (e: React.MouseEvent, id: string) => {
    if (connectMode !== 'none') return; // don't drag in connect mode
    e.stopPropagation();
    const pos = positions.get(id);
    if (!pos) return;
    dragging.current = { id, startMx: e.clientX, startMy: e.clientY, origX: pos.x, origY: pos.y };
  };

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!dragging.current) return;
    const { id, startMx, startMy, origX, origY } = dragging.current;
    setPositions(prev => {
      const next = new Map(prev);
      next.set(id, { x: origX + e.clientX - startMx, y: origY + e.clientY - startMy });
      return next;
    });
  }, []);

  const handleMouseUp = useCallback(() => {
    dragging.current = null;
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  const handleNodeClick = (e: React.MouseEvent, id: string) => {
    if (connectMode === 'none') {
      onSelectAgent(id);
      return;
    }
    e.stopPropagation();
    if (!pendingId) {
      // First click: select source / child
      setPendingId(id);
    } else if (pendingId !== id) {
      // Second click: complete the connection
      if (connectMode === 'link') {
        onCreateLink?.(pendingId, id);
      } else if (connectMode === 'parent') {
        // pendingId = child, id = parent
        onSetParent?.(pendingId, id);
      }
      setPendingId(null);
      setConnectMode('none');
    }
  };

  const cancelConnect = () => {
    setConnectMode('none');
    setPendingId(null);
  };

  const toggleMode = (mode: ConnectMode) => {
    if (connectMode === mode) {
      cancelConnect();
    } else {
      setConnectMode(mode);
      setPendingId(null);
    }
  };

  // Helpers
  const nodeCenter = (id: string): Pos => {
    const p = positions.get(id);
    if (!p) return { x: 0, y: 0 };
    return { x: p.x + NODE_W / 2, y: p.y + NODE_H / 2 };
  };

  // Viewport
  let maxX = 480;
  let maxY = 320;
  for (const { x, y } of positions.values()) {
    maxX = Math.max(maxX, x + NODE_W + MARGIN);
    maxY = Math.max(maxY, y + NODE_H + MARGIN);
  }

  const connectModeLabel =
    connectMode === 'link'
      ? pendingId
        ? `Click target agent to link from "${agents.find(a => a.id === pendingId)?.name ?? '…'}"`
        : 'Click source agent to start a message link'
      : connectMode === 'parent'
      ? pendingId
        ? `Click parent agent for "${agents.find(a => a.id === pendingId)?.name ?? '…'}"`
        : 'Click the child agent first'
      : '';

  return (
    <div className="flex-1 relative overflow-auto bg-[#09090b] select-none">
      {/* ── Floating connect-mode toolbar ──────────────────────────────── */}
      <div className="absolute top-3 left-3 z-10 flex flex-col gap-2">
        <div className="flex gap-1.5">
          <button
            onClick={() => toggleMode('link')}
            title="Draw a message link between two agents"
            className={`px-2.5 py-1 text-xs rounded-lg font-medium transition-colors ${
              connectMode === 'link'
                ? 'bg-emerald-500 text-zinc-950'
                : 'bg-zinc-800/90 text-zinc-300 hover:bg-zinc-700 hover:text-white'
            }`}
          >
            🔗 Link Agents
          </button>
          <button
            onClick={() => toggleMode('parent')}
            title="Set parent-child hierarchy between agents"
            className={`px-2.5 py-1 text-xs rounded-lg font-medium transition-colors ${
              connectMode === 'parent'
                ? 'bg-indigo-500 text-white'
                : 'bg-zinc-800/90 text-zinc-300 hover:bg-zinc-700 hover:text-white'
            }`}
          >
            ⬆ Set Parent
          </button>
          {onRemoveParent && (
            <button
              onClick={() => toggleMode('parent')}
              title="Remove parent link — click an agent in the graph then select the parent mode"
              className="px-2.5 py-1 text-xs rounded-lg font-medium bg-zinc-800/90 text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors"
            >
              ✂ Detach
            </button>
          )}
        </div>

        {/* Status / instruction message when in connect mode */}
        {connectMode !== 'none' && (
          <div className="flex items-center gap-2 bg-zinc-900/95 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-zinc-300 max-w-xs backdrop-blur-sm">
            <span className="flex-1">{connectModeLabel}</span>
            <button
              onClick={cancelConnect}
              className="text-zinc-500 hover:text-zinc-200 shrink-0 font-bold"
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {/* Empty state */}
      {agents.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-zinc-600 text-sm">
          No agents yet.
        </div>
      )}

      <svg width={maxX} height={maxY} className="block">
        <defs>
          {/* Arrow for spawn edges */}
          <marker id="arrow-spawn" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill="#52525b" />
          </marker>
          {/* Arrow for message edges */}
          <marker id="arrow-msg" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill="#10b981" />
          </marker>
          {/* Arrow for manual link edges */}
          <marker id="arrow-manual" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill="#6366f1" />
          </marker>
        </defs>

        {/* ── Spawn edges (solid grey) ──────────────────────────────────── */}
        {agents
          .filter(a => a.parentId && positions.has(a.parentId) && positions.has(a.id))
          .map(a => {
            const from = nodeCenter(a.parentId!);
            const toPos = positions.get(a.id)!;
            // Arrow lands at top-centre of child node
            const tx = toPos.x + NODE_W / 2;
            const ty = toPos.y;
            return (
              <line
                key={`spawn-${a.id}`}
                x1={from.x}
                y1={from.y}
                x2={tx}
                y2={ty}
                stroke="#52525b"
                strokeWidth={1.5}
                markerEnd="url(#arrow-spawn)"
              />
            );
          })}

        {/* ── Message edges (dashed emerald for auto, solid indigo for manual) */}
        {messageLinks
          .filter(l => positions.has(l.fromId) && positions.has(l.toId))
          .map((l, i) => {
            const from = nodeCenter(l.fromId);
            const to = nodeCenter(l.toId);
            // Quadratic bezier for a gentle curve
            const mx = (from.x + to.x) / 2;
            const my = Math.min(from.y, to.y) - 40;
            const isManual = l.messageCount === 0;
            const strokeColor = isManual ? '#6366f1' : '#10b981';
            const markerId = isManual ? 'url(#arrow-manual)' : 'url(#arrow-msg)';
            return (
              <g key={`msg-${i}`}>
                <path
                  d={`M ${from.x} ${from.y} Q ${mx} ${my} ${to.x} ${to.y}`}
                  fill="none"
                  stroke={strokeColor}
                  strokeWidth={1.5}
                  strokeDasharray={isManual ? '3 4' : '5 3'}
                  markerEnd={markerId}
                  opacity={0.7}
                />
                {/* Message count badge (only for active communication links) */}
                {l.messageCount > 0 && (
                  <text
                    x={mx}
                    y={my - 4}
                    textAnchor="middle"
                    fontSize={10}
                    fill="#10b981"
                    opacity={0.85}
                    style={{ fontFamily: 'monospace' }}
                  >
                    {l.messageCount}×
                  </text>
                )}
              </g>
            );
          })}

        {/* ── Preview edge when in connect mode with a source selected ──── */}
        {connectMode !== 'none' && pendingId && positions.has(pendingId) && (() => {
          const from = nodeCenter(pendingId);
          const strokeColor = connectMode === 'link' ? '#10b981' : '#818cf8';
          return (
            <circle
              cx={from.x}
              cy={from.y}
              r={NODE_W / 2 + 6}
              fill="none"
              stroke={strokeColor}
              strokeWidth={2}
              strokeDasharray="6 3"
              opacity={0.6}
            >
              <animate attributeName="stroke-dashoffset" from="0" to="-18" dur="1s" repeatCount="indefinite" />
            </circle>
          );
        })()}

        {/* ── Agent nodes ──────────────────────────────────────────────── */}
        {agents.map(agent => {
          const pos = positions.get(agent.id);
          if (!pos) return null;
          const isActive = agent.id === activeAgentId;
          const isPending = agent.id === pendingId;
          const isManager = agent.role === 'manager';
          const isAuthoriser = agent.role === 'authoriser';

          const borderColor = isPending
            ? (connectMode === 'link' ? '#10b981' : '#818cf8')
            : isActive
            ? '#10b981'
            : isManager
            ? '#818cf8'
            : isAuthoriser
            ? '#f59e0b'
            : '#3f3f46';
          const bgColor = isActive || isPending ? '#111827' : '#18181b';
          const badgeBg = isManager ? '#4f46e5' : isAuthoriser ? '#b45309' : '#0f766e';
          const badgeLabel = isManager
            ? (agent.recursive ? 'RECUR' : 'MGR')
            : isAuthoriser
            ? 'AUTH'
            : 'WORKER';
          const badgeW = isManager
            ? (agent.recursive ? 38 : 26)
            : isAuthoriser
            ? 30
            : 42;

          return (
            <g
              key={agent.id}
              transform={`translate(${pos.x}, ${pos.y})`}
              style={{ cursor: connectMode !== 'none' ? 'crosshair' : 'pointer' }}
              onClick={e => handleNodeClick(e, agent.id)}
              onMouseDown={e => handleMouseDown(e, agent.id)}
            >
              {/* Shadow */}
              <rect
                x={2} y={3}
                width={NODE_W} height={NODE_H}
                rx={8}
                fill="black"
                opacity={0.3}
              />
              {/* Node body */}
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={8}
                fill={bgColor}
                stroke={borderColor}
                strokeWidth={(isActive || isPending) ? 2 : 1.5}
              />

              {/* Role badge */}
              <rect x={8} y={8} width={badgeW} height={17} rx={4} fill={badgeBg} />
              <text
                x={8 + badgeW / 2}
                y={20}
                textAnchor="middle"
                fontSize={9}
                fill="white"
                style={{ fontFamily: 'monospace', fontWeight: 700 }}
              >
                {badgeLabel}
              </text>

              {/* Agent name */}
              <text
                x={NODE_W / 2}
                y={43}
                textAnchor="middle"
                fontSize={12}
                fill={isActive ? '#f4f4f5' : '#a1a1aa'}
                style={{
                  fontFamily: 'sans-serif',
                  fontWeight: isActive ? 600 : 400,
                }}
              >
                {agent.name.length > 17 ? `${agent.name.slice(0, 16)}…` : agent.name}
              </text>

              {/* Spinner dot when loading */}
              {agent.isLoading && (
                <circle cx={NODE_W - 10} cy={10} r={4} fill="#10b981">
                  <animate
                    attributeName="opacity"
                    values="1;0.2;1"
                    dur="1.2s"
                    repeatCount="indefinite"
                  />
                </circle>
              )}

              {/* Drag hint / tooltip */}
              <title>
                {agent.name} ({agent.role}{agent.recursive ? ', recursive' : ''})
                {connectMode !== 'none'
                  ? pendingId
                    ? ' — click to connect'
                    : ' — click to select as source'
                  : ' — click to open, drag to move'}
              </title>
            </g>
          );
        })}
      </svg>

      {/* ── Legend ─────────────────────────────────────────────────────── */}
      <div className="absolute bottom-4 right-4 bg-zinc-900/90 border border-zinc-700 rounded-xl p-3 text-xs text-zinc-400 space-y-2 backdrop-blur-sm">
        <p className="font-semibold text-zinc-200 text-xs mb-1">Legend</p>
        <div className="flex items-center gap-2">
          <svg width="28" height="4">
            <line x1="0" y1="2" x2="28" y2="2" stroke="#52525b" strokeWidth="1.5" />
          </svg>
          <span>Spawned by</span>
        </div>
        <div className="flex items-center gap-2">
          <svg width="28" height="4">
            <line
              x1="0" y1="2" x2="28" y2="2"
              stroke="#10b981"
              strokeWidth="1.5"
              strokeDasharray="4 2"
            />
          </svg>
          <span>Message sent</span>
        </div>
        <div className="flex items-center gap-2">
          <svg width="28" height="4">
            <line
              x1="0" y1="2" x2="28" y2="2"
              stroke="#6366f1"
              strokeWidth="1.5"
              strokeDasharray="3 3"
            />
          </svg>
          <span>Manual link</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded bg-indigo-600 shrink-0" />
          <span>Manager (MGR)</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded bg-indigo-500 shrink-0" />
          <span>Recursive (RECUR)</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded bg-teal-700 shrink-0" />
          <span>Worker</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded bg-amber-700 shrink-0" />
          <span>Authoriser (AUTH)</span>
        </div>
        <p className="text-zinc-600 pt-1 border-t border-zinc-800">Drag nodes to rearrange</p>
      </div>
    </div>
  );
}
