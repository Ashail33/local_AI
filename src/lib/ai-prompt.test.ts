/**
 * Tests for system prompt self-profile sections.
 *
 * Every agent (manager, worker, critic) must receive a SELF PROFILE block in
 * its system instruction that tells it:
 *   - Its name and role
 *   - What tools it has access to
 *   - Which agents it can communicate with
 *   - Its purpose and how to do tasks
 *
 * These tests verify that the self-profile block is present and accurate for
 * each agent type in both the Gemini and Ollama system instruction builders.
 */

import { describe, it, expect } from 'vitest';
import { buildSystemInstruction, buildOllamaSystemInstruction } from './ai';

// ── buildSystemInstruction (Gemini) ──────────────────────────────────────────

describe('buildSystemInstruction — self-profile for manager', () => {
  const prompt = buildSystemInstruction(
    'Project Manager',
    true,   // enableWebSearch
    true,   // isManager
    [],     // spawnedAgents
    false,  // isRecursive
    '',     // customSystemPrompt
    [],     // handoffAgents
    false,  // isLive
    false,  // isCritic
  );

  it('includes AGENT SELF PROFILE section', () => {
    expect(prompt).toContain('AGENT SELF PROFILE');
    expect(prompt).toContain('END SELF PROFILE');
  });

  it('includes the agent name', () => {
    expect(prompt).toContain('Name: Project Manager');
  });

  it('identifies role as MANAGER AGENT', () => {
    expect(prompt).toContain('Role: MANAGER AGENT');
  });

  it('lists spawn_agent as an available tool', () => {
    expect(prompt).toContain('spawn_agent');
  });

  it('lists all core manager tools', () => {
    const expectedTools = [
      'read_file',
      'list_files',
      'create_document',
      'create_folder',
      'web_search',
      'list_agents',
      'spawn_agent',
      'message_agent',
      'connect_agents',
      'critique_output',
      'rename_agent',
      'set_agent_prompt',
    ];
    for (const tool of expectedTools) {
      expect(prompt).toContain(tool);
    }
  });

  it('does NOT list request_signoff when not recursive', () => {
    expect(prompt).not.toContain('request_signoff');
  });

  it('includes purpose description', () => {
    expect(prompt).toContain('Purpose:');
  });

  it('includes communication section', () => {
    expect(prompt).toContain('Agents you can communicate with:');
  });

  it('includes how-to section', () => {
    expect(prompt).toContain('How to do your tasks:');
  });
});

describe('buildSystemInstruction — recursive manager includes request_signoff', () => {
  const prompt = buildSystemInstruction(
    'Recursive Manager',
    true,   // enableWebSearch
    true,   // isManager
    [],     // spawnedAgents
    true,   // isRecursive
    '',
    [],
    false,
    false,
  );

  it('lists request_signoff tool', () => {
    expect(prompt).toContain('request_signoff');
  });
});

describe('buildSystemInstruction — manager with spawned agents', () => {
  const prompt = buildSystemInstruction(
    'Team Lead',
    true,
    true,
    [{ id: 'w1', name: 'Coder' }, { id: 'w2', name: 'Researcher' }],
    false,
    '',
    [],
    false,
    false,
  );

  it('lists spawned agents in communication section', () => {
    expect(prompt).toContain('Coder');
    expect(prompt).toContain('w1');
    expect(prompt).toContain('Researcher');
    expect(prompt).toContain('w2');
  });
});

describe('buildSystemInstruction — self-profile for worker', () => {
  const prompt = buildSystemInstruction(
    'Code Writer',
    true,   // enableWebSearch
    false,  // isManager
    [],
    false,
    '',
    [{ id: 'w2', name: 'Reviewer' }], // handoffAgents
    false,
    false,
  );

  it('includes AGENT SELF PROFILE section', () => {
    expect(prompt).toContain('AGENT SELF PROFILE');
    expect(prompt).toContain('END SELF PROFILE');
  });

  it('includes the agent name', () => {
    expect(prompt).toContain('Name: Code Writer');
  });

  it('identifies role as WORKER AGENT', () => {
    expect(prompt).toContain('Role: WORKER AGENT');
  });

  it('lists worker tools', () => {
    const expectedTools = [
      'read_file',
      'write_file',
      'list_files',
      'create_document',
      'build_tool',
      'propose_python_script',
      'create_folder',
      'write_document',
      'web_search',
      'handoff_to_agent',
    ];
    for (const tool of expectedTools) {
      expect(prompt).toContain(tool);
    }
  });

  it('includes handoff agents in communication section', () => {
    expect(prompt).toContain('Reviewer');
    expect(prompt).toContain('w2');
  });

  it('includes purpose description', () => {
    expect(prompt).toContain('Purpose:');
  });

  it('includes how-to section', () => {
    expect(prompt).toContain('How to do your tasks:');
  });
});

describe('buildSystemInstruction — worker without handoff has no handoff_to_agent', () => {
  const prompt = buildSystemInstruction(
    'Solo Worker',
    false, // enableWebSearch
    false,
    [],
    false,
    '',
    [],    // no handoff agents
    false,
    false,
  );

  it('does NOT list handoff_to_agent or web_search in tools section', () => {
    // handoff_to_agent should NOT be in the self-profile tools section when no handoff agents
    const selfProfileMatch = prompt.match(/AGENT SELF PROFILE[\s\S]*?END SELF PROFILE/);
    expect(selfProfileMatch).toBeTruthy();
    const toolsSection = selfProfileMatch![0].match(/Tools you have access to:[\s\S]*?Agents you can communicate with:/);
    expect(toolsSection).toBeTruthy();
    expect(toolsSection![0]).not.toContain('handoff_to_agent');
    expect(toolsSection![0]).not.toContain('web_search');
  });
});

describe('buildSystemInstruction — self-profile for critic', () => {
  const prompt = buildSystemInstruction(
    'Quality Reviewer',
    false,
    false,
    [],
    false,
    '',
    [],
    false,
    true, // isCritic
  );

  it('includes AGENT SELF PROFILE section', () => {
    expect(prompt).toContain('AGENT SELF PROFILE');
    expect(prompt).toContain('END SELF PROFILE');
  });

  it('includes the agent name', () => {
    expect(prompt).toContain('Name: Quality Reviewer');
  });

  it('identifies role as CRITIC AGENT', () => {
    expect(prompt).toContain('Role: CRITIC AGENT');
  });

  it('lists read_file and list_files as tools', () => {
    expect(prompt).toContain('read_file');
    expect(prompt).toContain('list_files');
  });

  it('includes purpose description', () => {
    expect(prompt).toContain('Purpose:');
  });
});

// ── buildOllamaSystemInstruction ─────────────────────────────────────────────

describe('buildOllamaSystemInstruction — self-profile for manager', () => {
  const prompt = buildOllamaSystemInstruction(
    'Ollama Manager',
    true,  // isManager
    '',    // customSystemPrompt
    false, // isCritic
    ['read_file', 'web_search'],
  );

  it('includes AGENT SELF PROFILE section', () => {
    expect(prompt).toContain('AGENT SELF PROFILE');
    expect(prompt).toContain('END SELF PROFILE');
  });

  it('includes the agent name', () => {
    expect(prompt).toContain('Name: Ollama Manager');
  });

  it('identifies role as MANAGER AGENT', () => {
    expect(prompt).toContain('Role: MANAGER AGENT');
  });

  it('lists available tools', () => {
    expect(prompt).toContain('read_file');
    expect(prompt).toContain('web_search');
  });
});

describe('buildOllamaSystemInstruction — self-profile for worker', () => {
  const prompt = buildOllamaSystemInstruction(
    'Ollama Worker',
    false,
    '',
    false,
    ['read_file', 'write_file', 'list_files'],
  );

  it('includes AGENT SELF PROFILE section', () => {
    expect(prompt).toContain('AGENT SELF PROFILE');
    expect(prompt).toContain('END SELF PROFILE');
  });

  it('includes the agent name', () => {
    expect(prompt).toContain('Name: Ollama Worker');
  });

  it('identifies role as WORKER AGENT', () => {
    expect(prompt).toContain('Role: WORKER AGENT');
  });

  it('lists the tools provided', () => {
    expect(prompt).toContain('read_file');
    expect(prompt).toContain('write_file');
    expect(prompt).toContain('list_files');
  });
});

describe('buildOllamaSystemInstruction — self-profile for critic', () => {
  const prompt = buildOllamaSystemInstruction(
    'Ollama Critic',
    false,
    '',
    true, // isCritic
    [],
  );

  it('includes AGENT SELF PROFILE section', () => {
    expect(prompt).toContain('AGENT SELF PROFILE');
    expect(prompt).toContain('END SELF PROFILE');
  });

  it('identifies role as CRITIC AGENT', () => {
    expect(prompt).toContain('Role: CRITIC AGENT');
  });
});
