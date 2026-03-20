/**
 * State-based tests for agent management actions.
 *
 * These tests verify the actual state mutations produced by the manager tools
 * (spawn, rename, set_agent_prompt, connect, list) — NOT the LLM's text
 * responses.  Each test checks that the correct updates are applied to the
 * agent state, that communication links are established, and that episodic
 * memory is recorded.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  renameAgent,
  setAgentPrompt,
  computeSpawnLinks,
  createSpawnMessageLink,
  connectAgents,
  listAgents,
  recordConversationExchange,
  type AgentLike,
  type ConnectedLink,
  type MessageLink,
} from './agent-actions';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<AgentLike> & { id: string }): AgentLike {
  return {
    name: 'Test Agent',
    role: 'worker',
    parentId: null,
    systemPrompt: '',
    ...overrides,
  };
}

// ── rename_agent ─────────────────────────────────────────────────────────────

describe('renameAgent — state-based checks', () => {
  it('calls updateAgent with the new name', async () => {
    const worker = makeAgent({ id: 'w1', name: 'Old Name' });
    const updateAgent = vi.fn();
    const appendMemory = vi.fn();

    await renameAgent([worker], 'mgr1', 'w1', 'New Name', updateAgent, appendMemory);

    // STATE CHECK: updateAgent was called with the exact field change
    expect(updateAgent).toHaveBeenCalledTimes(1);
    expect(updateAgent).toHaveBeenCalledWith('w1', { name: 'New Name' });
  });

  it('returns a success message containing both old and new names', async () => {
    const worker = makeAgent({ id: 'w1', name: 'Old Name' });
    const result = await renameAgent([worker], 'mgr1', 'w1', 'New Name', vi.fn(), vi.fn());
    expect(result).toContain('Old Name');
    expect(result).toContain('New Name');
    expect(result).toContain('renamed');
  });

  it('records the rename in episodic memory', async () => {
    const worker = makeAgent({ id: 'w1', name: 'Alpha' });
    const updateAgent = vi.fn();
    const appendMemory = vi.fn();

    await renameAgent([worker], 'mgr1', 'w1', 'Beta', updateAgent, appendMemory);

    // STATE CHECK: episodic memory logged for the manager
    expect(appendMemory).toHaveBeenCalledTimes(1);
    expect(appendMemory).toHaveBeenCalledWith('mgr1', 'Renamed agent "Alpha" → "Beta"');
  });

  it('returns an error string and does NOT mutate state for a missing agent', async () => {
    const updateAgent = vi.fn();
    const appendMemory = vi.fn();

    const result = await renameAgent([], 'mgr1', 'nonexistent', 'X', updateAgent, appendMemory);

    expect(result).toMatch(/Error/);
    // STATE CHECK: no mutations occurred
    expect(updateAgent).not.toHaveBeenCalled();
    expect(appendMemory).not.toHaveBeenCalled();
  });
});

// ── set_agent_prompt ─────────────────────────────────────────────────────────

describe('setAgentPrompt — state-based checks', () => {
  it('calls updateAgent with the new systemPrompt', async () => {
    const worker = makeAgent({ id: 'w1', name: 'Researcher' });
    const updateAgent = vi.fn();
    const appendMemory = vi.fn();

    await setAgentPrompt(
      [worker], 'mgr1', 'w1',
      'You are a research expert. Always cite sources.',
      updateAgent, appendMemory,
    );

    // STATE CHECK: systemPrompt field is set
    expect(updateAgent).toHaveBeenCalledTimes(1);
    expect(updateAgent).toHaveBeenCalledWith('w1', {
      systemPrompt: 'You are a research expert. Always cite sources.',
    });
  });

  it('records the prompt update in episodic memory', async () => {
    const worker = makeAgent({ id: 'w1', name: 'Writer' });
    const updateAgent = vi.fn();
    const appendMemory = vi.fn();

    await setAgentPrompt([worker], 'mgr1', 'w1', 'Write concisely.', updateAgent, appendMemory);

    // STATE CHECK: memory logged for the manager referencing the agent name
    expect(appendMemory).toHaveBeenCalledWith('mgr1', 'Set system prompt for agent "Writer"');
  });

  it('returns an error and does NOT mutate state for a missing agent', async () => {
    const updateAgent = vi.fn();
    const appendMemory = vi.fn();

    const result = await setAgentPrompt([], 'mgr1', 'ghost', 'prompt', updateAgent, appendMemory);

    expect(result).toMatch(/Error/);
    expect(updateAgent).not.toHaveBeenCalled();
    expect(appendMemory).not.toHaveBeenCalled();
  });
});

// ── computeSpawnLinks (communication gateway) ────────────────────────────────

describe('computeSpawnLinks — communication gateway opens', () => {
  it('creates bidirectional links between manager and new worker', () => {
    const links = computeSpawnLinks([], 'mgr1', 'w1');

    // STATE CHECK: two links exist — one in each direction
    expect(links).toHaveLength(2);
    expect(links).toContainEqual({ fromId: 'w1', toId: 'mgr1' });
    expect(links).toContainEqual({ fromId: 'mgr1', toId: 'w1' });
  });

  it('preserves existing links and does not duplicate', () => {
    const existing: ConnectedLink[] = [
      { fromId: 'w1', toId: 'mgr1' },
    ];

    const links = computeSpawnLinks(existing, 'mgr1', 'w1');

    // STATE CHECK: only one new link added (mgr1→w1), existing w1→mgr1 kept
    expect(links).toHaveLength(2);
    const workerToManager = links.filter(l => l.fromId === 'w1' && l.toId === 'mgr1');
    const managerToWorker = links.filter(l => l.fromId === 'mgr1' && l.toId === 'w1');
    expect(workerToManager).toHaveLength(1);
    expect(managerToWorker).toHaveLength(1);
  });

  it('handles multiple workers without cross-talk', () => {
    let links = computeSpawnLinks([], 'mgr1', 'w1');
    links = computeSpawnLinks(links, 'mgr1', 'w2');

    // STATE CHECK: four links total — mgr1↔w1 and mgr1↔w2
    expect(links).toHaveLength(4);
    expect(links).toContainEqual({ fromId: 'w1', toId: 'mgr1' });
    expect(links).toContainEqual({ fromId: 'mgr1', toId: 'w1' });
    expect(links).toContainEqual({ fromId: 'w2', toId: 'mgr1' });
    expect(links).toContainEqual({ fromId: 'mgr1', toId: 'w2' });
    // No w1↔w2 links
    expect(links.some(l => l.fromId === 'w1' && l.toId === 'w2')).toBe(false);
    expect(links.some(l => l.fromId === 'w2' && l.toId === 'w1')).toBe(false);
  });
});

// ── createSpawnMessageLink ───────────────────────────────────────────────────

describe('createSpawnMessageLink — spawn message recorded', () => {
  it('creates a message link with correct initial state', () => {
    const link = createSpawnMessageLink('mgr1', 'w1', 'Manager Bot', 'Research AI safety');

    // STATE CHECK: link records the task and sender
    expect(link.fromId).toBe('mgr1');
    expect(link.toId).toBe('w1');
    expect(link.messageCount).toBe(0);
    expect(link.lastMessage).toBe('Research AI safety');
    expect(link.messages).toHaveLength(1);
    expect(link.messages[0]).toEqual({ sender: 'Manager Bot', content: 'Research AI safety' });
  });

  it('handles an empty task string', () => {
    const link = createSpawnMessageLink('mgr1', 'w1', 'Manager', '');
    expect(link.lastMessage).toBe('');
    expect(link.messages[0].content).toBe('');
  });

  it('preserves special characters in the task', () => {
    const task = 'Analyse "complex" data & produce <report>';
    const link = createSpawnMessageLink('mgr1', 'w1', 'Manager', task);
    expect(link.lastMessage).toBe(task);
    expect(link.messages[0].content).toBe(task);
  });
});

// ── connectAgents ────────────────────────────────────────────────────────────

describe('connectAgents — one-way communication link', () => {
  it('creates a directed link from source to destination', () => {
    const agents = [
      makeAgent({ id: 'w1', name: 'Writer' }),
      makeAgent({ id: 'w2', name: 'Editor' }),
    ];

    const { connectedLinks, messageLinks, result } = connectAgents(
      agents, [], [], 'Boss', 'w1', 'w2',
    );

    // STATE CHECK: one-way connected link exists
    expect(connectedLinks).toHaveLength(1);
    expect(connectedLinks[0]).toEqual({ fromId: 'w1', toId: 'w2' });

    // STATE CHECK: visual message link created
    expect(messageLinks).toHaveLength(1);
    expect(messageLinks[0].fromId).toBe('w1');
    expect(messageLinks[0].toId).toBe('w2');

    // STATE CHECK: result mentions both agent names
    expect(result).toContain('Writer');
    expect(result).toContain('Editor');
  });

  it('does NOT create a reverse link (one-way only)', () => {
    const agents = [
      makeAgent({ id: 'w1', name: 'Writer' }),
      makeAgent({ id: 'w2', name: 'Editor' }),
    ];

    const { connectedLinks } = connectAgents(agents, [], [], 'Boss', 'w1', 'w2');

    // STATE CHECK: only w1→w2, NOT w2→w1
    expect(connectedLinks.some(l => l.fromId === 'w2' && l.toId === 'w1')).toBe(false);
  });

  it('does not duplicate an existing link', () => {
    const agents = [
      makeAgent({ id: 'w1', name: 'Writer' }),
      makeAgent({ id: 'w2', name: 'Editor' }),
    ];
    const existing: ConnectedLink[] = [{ fromId: 'w1', toId: 'w2' }];
    const existingMsg: MessageLink[] = [{
      fromId: 'w1', toId: 'w2', messageCount: 0, lastMessage: 'old', messages: [],
    }];

    const { connectedLinks, messageLinks } = connectAgents(
      agents, existing, existingMsg, 'Boss', 'w1', 'w2',
    );

    // STATE CHECK: no new links added
    expect(connectedLinks).toHaveLength(1);
    expect(messageLinks).toHaveLength(1);
  });

  it('returns error for missing source agent', () => {
    const agents = [makeAgent({ id: 'w2', name: 'Editor' })];
    const { error } = connectAgents(agents, [], [], 'Boss', 'missing', 'w2');
    expect(error).toMatch(/not found/);
  });

  it('returns error for missing destination agent', () => {
    const agents = [makeAgent({ id: 'w1', name: 'Writer' })];
    const { error } = connectAgents(agents, [], [], 'Boss', 'w1', 'missing');
    expect(error).toMatch(/not found/);
  });
});

// ── listAgents ───────────────────────────────────────────────────────────────

describe('listAgents — agent discovery', () => {
  it('excludes the calling manager from the list', () => {
    const agents = [
      makeAgent({ id: 'mgr1', name: 'Manager', role: 'manager' }),
      makeAgent({ id: 'w1', name: 'Worker 1', role: 'worker' }),
      makeAgent({ id: 'w2', name: 'Worker 2', role: 'worker' }),
    ];

    const result = listAgents(agents, 'mgr1');

    // STATE CHECK: manager is excluded, both workers returned
    expect(result).toHaveLength(2);
    expect(result.map(a => a.id)).toEqual(['w1', 'w2']);
    expect(result.find(a => a.id === 'mgr1')).toBeUndefined();
  });

  it('returns empty array when only the manager exists', () => {
    const agents = [makeAgent({ id: 'mgr1', name: 'Manager', role: 'manager' })];
    const result = listAgents(agents, 'mgr1');
    expect(result).toHaveLength(0);
  });

  it('includes agent role in the returned data', () => {
    const agents = [
      makeAgent({ id: 'mgr1', role: 'manager' }),
      makeAgent({ id: 'auth1', name: 'Approver', role: 'authoriser' }),
      makeAgent({ id: 'w1', name: 'Worker', role: 'worker' }),
    ];

    const result = listAgents(agents, 'mgr1');

    // STATE CHECK: roles are correctly propagated
    expect(result.find(a => a.id === 'auth1')?.role).toBe('authoriser');
    expect(result.find(a => a.id === 'w1')?.role).toBe('worker');
  });
});

// ── End-to-end scenario: manager creates, renames, and prompts an agent ──────

describe('End-to-end: manager creates → renames → prompts an agent', () => {
  it('full workflow produces correct state transitions', async () => {
    // Simulate a simple state store
    const state: {
      agents: AgentLike[];
      connectedLinks: ConnectedLink[];
      messageLinks: MessageLink[];
      memory: { agentId: string; entry: string }[];
    } = {
      agents: [
        makeAgent({ id: 'mgr1', name: 'Manager', role: 'manager' }),
      ],
      connectedLinks: [],
      messageLinks: [],
      memory: [],
    };

    const updateAgent = (id: string, updates: Partial<AgentLike>) => {
      state.agents = state.agents.map(a => a.id === id ? { ...a, ...updates } : a);
    };
    const appendMemory = (agentId: string, entry: string) => {
      state.memory.push({ agentId, entry });
    };

    // Step 1: Simulate spawn — create a new worker and set up links
    const newWorker = makeAgent({
      id: 'w1',
      name: 'Worker 1',
      role: 'worker',
      parentId: 'mgr1',
    });
    state.agents.push(newWorker);
    state.connectedLinks = computeSpawnLinks(state.connectedLinks, 'mgr1', 'w1');
    state.messageLinks.push(
      createSpawnMessageLink('mgr1', 'w1', 'Manager', 'Research topic X'),
    );

    // STATE CHECK: worker exists in state
    expect(state.agents.find(a => a.id === 'w1')).toBeDefined();
    expect(state.agents.find(a => a.id === 'w1')?.parentId).toBe('mgr1');

    // STATE CHECK: bidirectional communication gateway is open
    expect(state.connectedLinks).toContainEqual({ fromId: 'w1', toId: 'mgr1' });
    expect(state.connectedLinks).toContainEqual({ fromId: 'mgr1', toId: 'w1' });

    // STATE CHECK: spawn message link recorded
    expect(state.messageLinks).toHaveLength(1);
    expect(state.messageLinks[0].lastMessage).toBe('Research topic X');

    // Step 2: Manager renames the worker
    const renameResult = await renameAgent(
      state.agents, 'mgr1', 'w1', 'Research Bot', updateAgent, appendMemory,
    );

    // STATE CHECK: name changed in state (not just in the result string)
    expect(state.agents.find(a => a.id === 'w1')?.name).toBe('Research Bot');
    expect(renameResult).toContain('renamed');

    // STATE CHECK: episodic memory recorded
    expect(state.memory).toContainEqual({
      agentId: 'mgr1',
      entry: 'Renamed agent "Worker 1" → "Research Bot"',
    });

    // Step 3: Manager sets the worker's system prompt
    const promptResult = await setAgentPrompt(
      state.agents, 'mgr1', 'w1',
      'You are a research specialist. Focus on peer-reviewed sources only.',
      updateAgent, appendMemory,
    );

    // STATE CHECK: systemPrompt changed in state
    expect(state.agents.find(a => a.id === 'w1')?.systemPrompt).toBe(
      'You are a research specialist. Focus on peer-reviewed sources only.',
    );
    expect(promptResult).toContain('System prompt updated');

    // STATE CHECK: episodic memory recorded for the prompt change
    expect(state.memory).toContainEqual({
      agentId: 'mgr1',
      entry: 'Set system prompt for agent "Research Bot"',
    });

    // Step 4: Verify the agent is visible via list_agents
    const agentList = listAgents(state.agents, 'mgr1');
    expect(agentList).toHaveLength(1);
    expect(agentList[0]).toEqual({
      id: 'w1',
      name: 'Research Bot',
      role: 'worker',
    });
  });
});

// ── recordConversationExchange ───────────────────────────────────────────────

describe('recordConversationExchange — single exchange', () => {
  it('creates a new message link when none exists between the pair', () => {
    const links = recordConversationExchange(
      [], 'a1', 'a2', 'Alice', 'Bob', 'Hello Bob', 'Hi Alice',
    );

    expect(links).toHaveLength(1);
    expect(links[0].fromId).toBe('a1');
    expect(links[0].toId).toBe('a2');
    expect(links[0].messageCount).toBe(1);
    expect(links[0].lastMessage).toBe('Hello Bob');
    expect(links[0].messages).toHaveLength(2);
    expect(links[0].messages[0]).toEqual({ sender: 'Alice', content: 'Hello Bob' });
    expect(links[0].messages[1]).toEqual({ sender: 'Bob', content: 'Hi Alice' });
  });

  it('appends to an existing link between the same pair', () => {
    const existing: MessageLink[] = [{
      fromId: 'a1', toId: 'a2', messageCount: 1, lastMessage: 'first',
      messages: [
        { sender: 'Alice', content: 'first' },
        { sender: 'Bob', content: 'reply to first' },
      ],
    }];

    const links = recordConversationExchange(
      existing, 'a1', 'a2', 'Alice', 'Bob', 'second', 'reply to second',
    );

    expect(links).toHaveLength(1);
    expect(links[0].messageCount).toBe(2);
    expect(links[0].lastMessage).toBe('second');
    expect(links[0].messages).toHaveLength(4);
    expect(links[0].messages[2]).toEqual({ sender: 'Alice', content: 'second' });
    expect(links[0].messages[3]).toEqual({ sender: 'Bob', content: 'reply to second' });
  });

  it('does not modify unrelated links', () => {
    const unrelated: MessageLink = {
      fromId: 'x', toId: 'y', messageCount: 5, lastMessage: 'old',
      messages: [{ sender: 'X', content: 'old' }],
    };

    const links = recordConversationExchange(
      [unrelated], 'a1', 'a2', 'Alice', 'Bob', 'hi', 'hey',
    );

    expect(links).toHaveLength(2);
    // Unrelated link is unchanged
    expect(links[0]).toEqual(unrelated);
  });
});

describe('recordConversationExchange — multi-turn conversation', () => {
  it('accumulates a full back-and-forth conversation across multiple turns', () => {
    let links: MessageLink[] = [];

    // Turn 1: Manager asks Worker to research a topic
    links = recordConversationExchange(
      links, 'mgr1', 'w1', 'Manager', 'Researcher',
      'Please research quantum computing applications.',
      'I found several key applications: cryptography, drug discovery, and optimisation.',
    );

    // Turn 2: Manager asks for more detail
    links = recordConversationExchange(
      links, 'mgr1', 'w1', 'Manager', 'Researcher',
      'Can you elaborate on the cryptography aspect?',
      'Quantum computing threatens RSA encryption but enables quantum key distribution.',
    );

    // Turn 3: Manager requests a summary
    links = recordConversationExchange(
      links, 'mgr1', 'w1', 'Manager', 'Researcher',
      'Summarise your findings in three bullet points.',
      '• Cryptography: QKD replaces RSA\n• Drug discovery: molecular simulation\n• Optimisation: logistics and finance',
    );

    // Should be a single link with all 3 exchanges
    expect(links).toHaveLength(1);
    expect(links[0].messageCount).toBe(3);
    expect(links[0].messages).toHaveLength(6);

    // Verify chronological ordering of all messages
    expect(links[0].messages[0].sender).toBe('Manager');
    expect(links[0].messages[1].sender).toBe('Researcher');
    expect(links[0].messages[2].sender).toBe('Manager');
    expect(links[0].messages[3].sender).toBe('Researcher');
    expect(links[0].messages[4].sender).toBe('Manager');
    expect(links[0].messages[5].sender).toBe('Researcher');

    // Verify the last message is from the final turn
    expect(links[0].lastMessage).toBe('Summarise your findings in three bullet points.');
  });

  it('keeps separate conversations for different agent pairs', () => {
    let links: MessageLink[] = [];

    // Manager talks to Worker 1
    links = recordConversationExchange(
      links, 'mgr', 'w1', 'Boss', 'Writer',
      'Write an intro paragraph.', 'Here is the intro...',
    );

    // Manager talks to Worker 2
    links = recordConversationExchange(
      links, 'mgr', 'w2', 'Boss', 'Editor',
      'Review the intro.', 'The intro looks good.',
    );

    // Manager sends another message to Worker 1
    links = recordConversationExchange(
      links, 'mgr', 'w1', 'Boss', 'Writer',
      'Now write the conclusion.', 'Here is the conclusion...',
    );

    expect(links).toHaveLength(2);

    const w1Link = links.find(l => l.toId === 'w1')!;
    const w2Link = links.find(l => l.toId === 'w2')!;

    expect(w1Link.messageCount).toBe(2);
    expect(w1Link.messages).toHaveLength(4);
    expect(w2Link.messageCount).toBe(1);
    expect(w2Link.messages).toHaveLength(2);
  });

  it('correctly updates a spawn link (messageCount 0) on first exchange', () => {
    // Spawn creates a link with messageCount 0
    const spawnLink = createSpawnMessageLink('mgr1', 'w1', 'Manager', 'Research AI safety');

    // First message_agent exchange should update the spawn link
    const links = recordConversationExchange(
      [spawnLink], 'mgr1', 'w1', 'Manager', 'Worker',
      'What did you find?', 'AI safety involves alignment, robustness, and interpretability.',
    );

    // Should still be one link (updated, not duplicated)
    expect(links).toHaveLength(1);
    expect(links[0].messageCount).toBe(1);
    // Spawn message is preserved, plus the new exchange
    expect(links[0].messages).toHaveLength(3);
    expect(links[0].messages[0]).toEqual({ sender: 'Manager', content: 'Research AI safety' });
    expect(links[0].messages[1]).toEqual({ sender: 'Manager', content: 'What did you find?' });
    expect(links[0].messages[2]).toEqual({ sender: 'Worker', content: 'AI safety involves alignment, robustness, and interpretability.' });
  });
});

describe('recordConversationExchange — UI visibility', () => {
  it('messages contain sender names and content needed by the AgentGraph panel', () => {
    const links = recordConversationExchange(
      [], 'a1', 'a2', 'Planner', 'Executor',
      'Build the API endpoint.', 'Done — endpoint /api/tasks is live.',
    );

    const msgs = links[0].messages;
    // Each message has the fields the AgentGraph conversation panel expects
    for (const m of msgs) {
      expect(m).toHaveProperty('sender');
      expect(m).toHaveProperty('content');
      expect(typeof m.sender).toBe('string');
      expect(typeof m.content).toBe('string');
      expect(m.sender.length).toBeGreaterThan(0);
      expect(m.content.length).toBeGreaterThan(0);
    }

    // Senders alternate between the two agents (for chat-bubble alignment)
    expect(msgs[0].sender).toBe('Planner');
    expect(msgs[1].sender).toBe('Executor');
  });

  it('messageCount reflects the number of exchanges visible in the graph badge', () => {
    let links: MessageLink[] = [];
    for (let i = 1; i <= 5; i++) {
      links = recordConversationExchange(
        links, 'a1', 'a2', 'Agent A', 'Agent B',
        `Message ${i}`, `Reply ${i}`,
      );
    }

    expect(links[0].messageCount).toBe(5);
    expect(links[0].messages).toHaveLength(10);
  });
});

// ── End-to-end: two agents have a conversation about a task ──────────────────

describe('End-to-end: two agents converse about a task', () => {
  it('full conversation lifecycle — spawn, exchange, accumulate, display', () => {
    // Simulate state
    const state: {
      agents: AgentLike[];
      connectedLinks: ConnectedLink[];
      messageLinks: MessageLink[];
    } = {
      agents: [
        makeAgent({ id: 'mgr1', name: 'Manager', role: 'manager' }),
      ],
      connectedLinks: [],
      messageLinks: [],
    };

    // Step 1: Manager spawns a worker for a task
    const worker = makeAgent({
      id: 'w1', name: 'Analyst', role: 'worker', parentId: 'mgr1',
    });
    state.agents.push(worker);
    state.connectedLinks = computeSpawnLinks(state.connectedLinks, 'mgr1', 'w1');
    state.messageLinks.push(
      createSpawnMessageLink('mgr1', 'w1', 'Manager', 'Analyse customer feedback data'),
    );

    // Verify spawn set up the communication channel
    expect(state.connectedLinks).toHaveLength(2);
    expect(state.messageLinks).toHaveLength(1);
    expect(state.messageLinks[0].messages[0].content).toBe('Analyse customer feedback data');

    // Step 2: Manager sends first message to the worker
    state.messageLinks = recordConversationExchange(
      state.messageLinks, 'mgr1', 'w1', 'Manager', 'Analyst',
      'What are the top complaints?',
      'The top complaints are: slow delivery, poor packaging, and missing items.',
    );

    // Still one link (spawn link was updated)
    expect(state.messageLinks).toHaveLength(1);
    expect(state.messageLinks[0].messages).toHaveLength(3);

    // Step 3: Manager asks a follow-up question
    state.messageLinks = recordConversationExchange(
      state.messageLinks, 'mgr1', 'w1', 'Manager', 'Analyst',
      'What percentage of complaints are about delivery?',
      '42% of all complaints mention slow delivery.',
    );

    expect(state.messageLinks[0].messageCount).toBe(2);
    expect(state.messageLinks[0].messages).toHaveLength(5);

    // Step 4: Manager asks for recommendations
    state.messageLinks = recordConversationExchange(
      state.messageLinks, 'mgr1', 'w1', 'Manager', 'Analyst',
      'What do you recommend to address these issues?',
      'I recommend: 1) Partner with faster couriers, 2) Improve packaging QA, 3) Implement order verification.',
    );

    expect(state.messageLinks[0].messageCount).toBe(3);
    expect(state.messageLinks[0].messages).toHaveLength(7);

    // Verify the full conversation is visible and correctly ordered
    const conversation = state.messageLinks[0].messages;
    expect(conversation[0]).toEqual({ sender: 'Manager', content: 'Analyse customer feedback data' });
    expect(conversation[1]).toEqual({ sender: 'Manager', content: 'What are the top complaints?' });
    expect(conversation[2]).toEqual({
      sender: 'Analyst',
      content: 'The top complaints are: slow delivery, poor packaging, and missing items.',
    });
    expect(conversation[3]).toEqual({ sender: 'Manager', content: 'What percentage of complaints are about delivery?' });
    expect(conversation[4]).toEqual({ sender: 'Analyst', content: '42% of all complaints mention slow delivery.' });
    expect(conversation[5]).toEqual({ sender: 'Manager', content: 'What do you recommend to address these issues?' });
    expect(conversation[6]).toEqual({
      sender: 'Analyst',
      content: 'I recommend: 1) Partner with faster couriers, 2) Improve packaging QA, 3) Implement order verification.',
    });

    // Verify UI-facing metadata
    expect(state.messageLinks[0].lastMessage).toBe('What do you recommend to address these issues?');
    expect(state.messageLinks[0].fromId).toBe('mgr1');
    expect(state.messageLinks[0].toId).toBe('w1');
  });

  it('worker-to-worker handoff conversation is recorded and visible', () => {
    const state: {
      agents: AgentLike[];
      connectedLinks: ConnectedLink[];
      messageLinks: MessageLink[];
    } = {
      agents: [
        makeAgent({ id: 'mgr1', name: 'Manager', role: 'manager' }),
        makeAgent({ id: 'w1', name: 'Writer', role: 'worker', parentId: 'mgr1' }),
        makeAgent({ id: 'w2', name: 'Editor', role: 'worker', parentId: 'mgr1' }),
      ],
      connectedLinks: [],
      messageLinks: [],
    };

    // Set up connections: mgr↔w1, mgr↔w2, w1→w2 (pipeline)
    state.connectedLinks = computeSpawnLinks(state.connectedLinks, 'mgr1', 'w1');
    state.connectedLinks = computeSpawnLinks(state.connectedLinks, 'mgr1', 'w2');
    const connectResult = connectAgents(
      state.agents, state.connectedLinks, state.messageLinks,
      'Manager', 'w1', 'w2',
    );
    state.connectedLinks = connectResult.connectedLinks;
    state.messageLinks = connectResult.messageLinks;

    // Writer hands off work to Editor
    state.messageLinks = recordConversationExchange(
      state.messageLinks, 'w1', 'w2', 'Writer', 'Editor',
      'Here is my draft article for your review.',
      'I have reviewed the draft. Suggesting improvements to paragraphs 2 and 5.',
    );

    // Editor's conversation should be visible
    const w1w2Link = state.messageLinks.find(l => l.fromId === 'w1' && l.toId === 'w2')!;
    expect(w1w2Link).toBeDefined();
    expect(w1w2Link.messageCount).toBe(1);
    expect(w1w2Link.messages).toHaveLength(2);
    expect(w1w2Link.messages[0].sender).toBe('Writer');
    expect(w1w2Link.messages[1].sender).toBe('Editor');

    // Second handoff round
    state.messageLinks = recordConversationExchange(
      state.messageLinks, 'w1', 'w2', 'Writer', 'Editor',
      'Updated draft with your suggestions applied.',
      'Looks great now. Approved for publication.',
    );

    const updatedLink = state.messageLinks.find(l => l.fromId === 'w1' && l.toId === 'w2')!;
    expect(updatedLink.messageCount).toBe(2);
    expect(updatedLink.messages).toHaveLength(4);
  });
});
