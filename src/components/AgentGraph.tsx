import React, { useState, useCallback, useEffect, useRef } from 'react';
import type { ModelProvider } from '../lib/models';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GraphAgent {
  id: string;
  name: string;
  role: 'manager' | 'worker';
  provider: ModelProvider;
  modelId: string;
  parentId: string | null;
  isLoading: boolean;
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

export default function AgentGraph({
  agents,
  activeAgentId,
  messageLinks,
  onSelectAgent,
}: AgentGraphProps) {
  const [positions, setPositions] = useState<Map<string, Pos>>(() => computeLayout(agents));
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

  const handleMouseDown = (e: React.MouseEvent, id: string) => {
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

  return (
    <div className="flex-1 relative overflow-auto bg-[#09090b] select-none">
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

        {/* ── Message edges (dashed emerald) ───────────────────────────── */}
        {messageLinks
          .filter(l => positions.has(l.fromId) && positions.has(l.toId))
          .map((l, i) => {
            const from = nodeCenter(l.fromId);
            const to = nodeCenter(l.toId);
            // Quadratic bezier for a gentle curve
            const mx = (from.x + to.x) / 2;
            const my = Math.min(from.y, to.y) - 40;
            return (
              <g key={`msg-${i}`}>
                <path
                  d={`M ${from.x} ${from.y} Q ${mx} ${my} ${to.x} ${to.y}`}
                  fill="none"
                  stroke="#10b981"
                  strokeWidth={1.5}
                  strokeDasharray="5 3"
                  markerEnd="url(#arrow-msg)"
                  opacity={0.7}
                />
                {/* Message count badge */}
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
              </g>
            );
          })}

        {/* ── Agent nodes ──────────────────────────────────────────────── */}
        {agents.map(agent => {
          const pos = positions.get(agent.id);
          if (!pos) return null;
          const isActive = agent.id === activeAgentId;
          const isManager = agent.role === 'manager';

          const borderColor = isActive ? '#10b981' : isManager ? '#818cf8' : '#3f3f46';
          const bgColor = isActive ? '#111827' : '#18181b';
          const badgeBg = isManager ? '#4f46e5' : '#0f766e';
          const badgeLabel = isManager ? 'MANAGER' : 'WORKER';
          const badgeW = isManager ? 54 : 42;

          return (
            <g
              key={agent.id}
              transform={`translate(${pos.x}, ${pos.y})`}
              style={{ cursor: 'pointer' }}
              onClick={() => onSelectAgent(agent.id)}
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
                strokeWidth={isActive ? 2 : 1.5}
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

              {/* Drag hint */}
              <title>
                {agent.name} ({agent.role}) — click to open, drag to move
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
          <div className="w-3 h-3 rounded bg-indigo-600 shrink-0" />
          <span>Manager agent</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded bg-teal-700 shrink-0" />
          <span>Worker agent</span>
        </div>
        <p className="text-zinc-600 pt-1 border-t border-zinc-800">Drag nodes to rearrange</p>
      </div>
    </div>
  );
}
