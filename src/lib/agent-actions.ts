/**
 * Pure, framework-agnostic agent management functions extracted from the React
 * component callbacks so they can be unit-tested without a DOM or React.
 *
 * Each function accepts the current agents array and dependency callbacks for
 * state mutation, then returns a result string identical to what the LLM-facing
 * tool handler returns.
 */

// ── Shared types ──────────────────────────────────────────────────────────────

/** Minimal agent shape needed by the action helpers. */
export interface AgentLike {
  id: string;
  name: string;
  role: string;
  parentId: string | null;
  systemPrompt: string;
}

export interface ConnectedLink {
  fromId: string;
  toId: string;
}

export interface MessageLinkEntry {
  sender: string;
  content: string;
}

export interface MessageLink {
  fromId: string;
  toId: string;
  messageCount: number;
  lastMessage: string;
  messages: MessageLinkEntry[];
}

// ── rename_agent ──────────────────────────────────────────────────────────────

/**
 * Core logic for the rename_agent tool.
 * Finds the target agent and applies the name update via the provided callback.
 */
export async function renameAgent(
  agents: AgentLike[],
  managerId: string,
  agentId: string,
  newName: string,
  updateAgent: (id: string, updates: Partial<AgentLike>) => void,
  appendMemory: (agentId: string, entry: string) => void,
): Promise<string> {
  const target = agents.find(a => a.id === agentId);
  if (!target) return `Error: Agent with ID "${agentId}" not found.`;

  const oldName = target.name;
  updateAgent(agentId, { name: newName });
  appendMemory(managerId, `Renamed agent "${oldName}" → "${newName}"`);
  return `Agent renamed from "${oldName}" to "${newName}".`;
}

// ── set_agent_prompt ──────────────────────────────────────────────────────────

/**
 * Core logic for the set_agent_prompt tool.
 * Finds the target agent and applies the system prompt update.
 */
export async function setAgentPrompt(
  agents: AgentLike[],
  managerId: string,
  agentId: string,
  prompt: string,
  updateAgent: (id: string, updates: Partial<AgentLike>) => void,
  appendMemory: (agentId: string, entry: string) => void,
): Promise<string> {
  const target = agents.find(a => a.id === agentId);
  if (!target) return `Error: Agent with ID "${agentId}" not found.`;

  updateAgent(agentId, { systemPrompt: prompt });
  appendMemory(managerId, `Set system prompt for agent "${target.name}"`);
  return `System prompt updated for agent "${target.name}" (ID: ${agentId}). The new prompt will take effect on the agent's next interaction.`;
}

// ── Spawn-related helpers ─────────────────────────────────────────────────────

/**
 * Compute the bidirectional connected links that should be created when a
 * manager spawns a new worker.  Returns the new full array of links.
 */
export function computeSpawnLinks(
  existingLinks: ConnectedLink[],
  managerId: string,
  workerId: string,
): ConnectedLink[] {
  const links = [...existingLinks];
  if (!links.some(l => l.fromId === workerId && l.toId === managerId)) {
    links.push({ fromId: workerId, toId: managerId });
  }
  if (!links.some(l => l.fromId === managerId && l.toId === workerId)) {
    links.push({ fromId: managerId, toId: workerId });
  }
  return links;
}

/**
 * Create the initial message link recorded when a manager spawns a worker.
 */
export function createSpawnMessageLink(
  managerId: string,
  workerId: string,
  managerName: string,
  task: string,
): MessageLink {
  return {
    fromId: managerId,
    toId: workerId,
    messageCount: 0,
    lastMessage: task,
    messages: [{ sender: managerName, content: task }],
  };
}

// ── connect_agents ────────────────────────────────────────────────────────────

/**
 * Core logic for the connect_agents tool.
 * Creates a one-way communication link from source to destination.
 * Returns the new arrays plus a result string.
 */
export function connectAgents(
  agents: AgentLike[],
  existingLinks: ConnectedLink[],
  existingMessageLinks: MessageLink[],
  managerName: string,
  fromAgentId: string,
  toAgentId: string,
): {
  error?: string;
  connectedLinks: ConnectedLink[];
  messageLinks: MessageLink[];
  result: string;
} {
  const fromAgent = agents.find(a => a.id === fromAgentId);
  const toAgent = agents.find(a => a.id === toAgentId);
  if (!fromAgent)
    return {
      error: `Error: Agent with ID "${fromAgentId}" not found.`,
      connectedLinks: existingLinks,
      messageLinks: existingMessageLinks,
      result: `Error: Agent with ID "${fromAgentId}" not found.`,
    };
  if (!toAgent)
    return {
      error: `Error: Agent with ID "${toAgentId}" not found.`,
      connectedLinks: existingLinks,
      messageLinks: existingMessageLinks,
      result: `Error: Agent with ID "${toAgentId}" not found.`,
    };

  // Add the authorized link if not already present
  let newLinks = existingLinks;
  if (!existingLinks.some(l => l.fromId === fromAgentId && l.toId === toAgentId)) {
    newLinks = [...existingLinks, { fromId: fromAgentId, toId: toAgentId }];
  }

  // Add a visual message link if not already present
  let newMessageLinks = existingMessageLinks;
  const linkNote = `Connected by ${managerName}`;
  if (!existingMessageLinks.some(l => l.fromId === fromAgentId && l.toId === toAgentId)) {
    newMessageLinks = [
      ...existingMessageLinks,
      { fromId: fromAgentId, toId: toAgentId, messageCount: 0, lastMessage: linkNote, messages: [] },
    ];
  }

  return {
    connectedLinks: newLinks,
    messageLinks: newMessageLinks,
    result: `Connected: ${fromAgent.name} → ${toAgent.name}. ${fromAgent.name} can now hand off work to ${toAgent.name} using handoff_to_agent.`,
  };
}

// ── list_agents ───────────────────────────────────────────────────────────────

/**
 * Core logic for the list_agents tool.
 * Returns all agents except the calling manager.
 */
export function listAgents(
  agents: AgentLike[],
  managerId: string,
): { id: string; name: string; role: string }[] {
  return agents
    .filter(a => a.id !== managerId)
    .map(a => ({ id: a.id, name: a.name, role: a.role }));
}

// ── recordConversationExchange ────────────────────────────────────────────────

/**
 * Record a message exchange between two agents on the shared message-link
 * graph.  If a link already exists between the pair it is updated in-place;
 * otherwise a brand-new link is created.
 *
 * Returns a new array (immutable update) suitable for a React setState call.
 */
export function recordConversationExchange(
  existingLinks: MessageLink[],
  fromId: string,
  toId: string,
  senderName: string,
  recipientName: string,
  message: string,
  reply: string,
): MessageLink[] {
  const newMsgs: MessageLinkEntry[] = [
    { sender: senderName, content: message },
    { sender: recipientName, content: reply },
  ];

  const existing = existingLinks.find(l => l.fromId === fromId && l.toId === toId);
  if (existing) {
    return existingLinks.map(l =>
      l === existing
        ? { ...l, messageCount: l.messageCount + 1, lastMessage: message, messages: [...l.messages, ...newMsgs] }
        : l,
    );
  }
  return [...existingLinks, { fromId, toId, messageCount: 1, lastMessage: message, messages: newMsgs }];
}
