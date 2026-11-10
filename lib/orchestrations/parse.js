'use strict';

// Reads an orchestrator session's transcript lines into its workers, reviewers,
// steers and merges. The rules come from the "Data" table and "Derived states" in
// docs/superpowers/specs/2026-11-10-orchestration-tab-design.md.

const RESET_LINE = /^Read (\S+\.md)\. You are the orchestrator for (\S+?)\.? Continue at/;
const WORKTREE = /^Your worktree is (\S+?);/;
const IMAGE_IN_PROMPT = /Read (\S+\.md) in full/;
const TASK_IN_PROMPT = /do Task (\d+) of (\S+), "([^"]+)"/;
const FILES_IN_PROMPT = /Files this task touches: ([^\n]+?)\.?\n/;
const DONE_WHEN = /Done when: ([^\n]+)/;
const TASK_IN_TEXT = /\bTask (\d+)\b/;
const IMAGE_WRITE = /\/docs\/superpowers\/images\/[^/]+\.md$/;
const WT_CREATE = /\bwt switch\b[^\n;&|]*?--create[= ]+(\S+)/g;
// `git merge` must be followed by whitespace or the end, so merge-base and merge-tree do not match.
const MERGE_COMMAND = /(?:\bgit\s+(?:-C\s+\S+\s+)?merge(?=\s|$)|\bwt\s+remove\b)([^\n;&|]*)/g;
const TASK_BRANCH = /^(.+)-t(\d+)$/;

function blocksOf(record) {
  const c = record.message?.content;
  return Array.isArray(c) ? c : [];
}

// The text of a user prompt: a typed string, a text block, or a queued prompt.
// Tool results are not prompts.
function promptOf(record) {
  if (record.type === 'attachment' && record.attachment?.type === 'queued_command') {
    return typeof record.attachment.prompt === 'string' ? record.attachment.prompt : null;
  }
  if (record.type !== 'user' || record.isMeta) return null;
  const c = record.message?.content;
  if (typeof c === 'string') return c;
  const text = blocksOf(record).find((b) => b.type === 'text' && typeof b.text === 'string');
  return text ? text.text : null;
}

function roleOf(description, prompt) {
  if (WORKTREE.test(prompt)) return 'worker';
  if (/review/i.test(description) || /review/i.test(prompt)) return 'reviewer';
  return 'agent';
}

// One agent from its Agent tool_use input. Task, title, files and worktree come
// from the worker prompt the orchestrate skill writes; a reviewer's task comes
// from its description or prompt.
function agentFrom(use, agentId, resultPrompt) {
  const input = use.input ?? {};
  const description = typeof input.description === 'string' ? input.description : '';
  const prompt = typeof input.prompt === 'string' ? input.prompt : resultPrompt;
  const role = roleOf(description, prompt);
  const taskMatch = TASK_IN_PROMPT.exec(prompt);
  const fallback = TASK_IN_TEXT.exec(description) ?? TASK_IN_TEXT.exec(prompt);
  const files = FILES_IN_PROMPT.exec(prompt)?.[1];
  return {
    agentId,
    description,
    role,
    task: taskMatch ? Number(taskMatch[1]) : role !== 'agent' && fallback ? Number(fallback[1]) : null,
    title: taskMatch?.[3] ?? null,
    files: files ? files.split(', ') : [],
    doneWhen: DONE_WHEN.exec(prompt)?.[1] ?? null,
    worktree: WORKTREE.exec(prompt)?.[1] ?? null,
    startedAt: use.at,
    line: use.line,
  };
}

// Branch names after git merge or wt remove, with quoted text (commit messages)
// removed, as [branch, task] pairs for the ones ending in -t<N>.
function mergedBranches(command) {
  const out = [];
  for (const m of command.matchAll(MERGE_COMMAND)) {
    if (/(?:^|\s)--abort(?:\s|$)/.test(m[1])) continue;
    for (const word of m[1].replace(/"[^"]*"|'[^']*'/g, ' ').split(/\s+/)) {
      const b = TASK_BRANCH.exec(word);
      if (b) out.push([b[1], Number(b[2])]);
    }
  }
  return out;
}

function planBranch(created) {
  const plain = created.find((b) => !TASK_BRANCH.test(b));
  if (plain) return plain;
  const task = created.map((b) => TASK_BRANCH.exec(b)).find(Boolean);
  return task ? task[1] : null;
}

function parseOrchestrator(lines) {
  let sawSkill = false;
  let finishing = false;
  let firstPrompt = null;
  let resetImage = null;
  let resetPlan = null;
  let writeImage = null;
  let promptImage = null;
  let promptPlan = null;
  let monitorBoard = null;
  const created = [];
  const launches = []; // Agent tool_use records in order
  const results = new Map(); // tool_use_id -> { agentId, prompt }
  const sends = [];
  const merged = []; // [branch, task, at, line]

  lines.forEach((raw, i) => {
    let r;
    try {
      r = JSON.parse(raw);
    } catch {
      return;
    }
    if (!r || typeof r !== 'object') return;
    const line = i + 1;
    const at = typeof r.timestamp === 'string' ? r.timestamp : '';

    if (firstPrompt === null) {
      const p = promptOf(r);
      if (p !== null) {
        firstPrompt = p;
        const reset = RESET_LINE.exec(p);
        if (reset) [, resetImage, resetPlan] = reset;
      }
    }

    if (r.type === 'user' && r.toolUseResult?.agentId) {
      const id = blocksOf(r).find((b) => b.type === 'tool_result')?.tool_use_id;
      if (id) results.set(id, { agentId: String(r.toolUseResult.agentId), prompt: String(r.toolUseResult.prompt ?? '') });
      return;
    }
    if (r.type !== 'assistant') return;

    for (const b of blocksOf(r)) {
      if (b.type !== 'tool_use') continue;
      const input = b.input ?? {};
      if (b.name === 'Skill') {
        if (input.skill === 'orchestrate') sawSkill = true;
        if (input.skill === 'superpowers:finishing-a-development-branch') finishing = true;
      } else if (b.name === 'Write' && typeof input.file_path === 'string') {
        if (writeImage === null && IMAGE_WRITE.test(input.file_path) && !input.file_path.endsWith('.feedback.md')) writeImage = input.file_path;
      } else if (b.name === 'Agent') {
        launches.push({ ...b, at, line });
      } else if (b.name === 'Monitor' && typeof input.command === 'string') {
        const board = /--board\s+(\S+)/.exec(input.command);
        if (board && monitorBoard === null) monitorBoard = board[1].replace(/^["']|["']$/g, '');
      } else if (b.name === 'SendMessage' && typeof input.to === 'string') {
        sends.push({ to: input.to, summary: typeof input.summary === 'string' ? input.summary : '', at, line });
      } else if (b.name === 'Bash' && typeof input.command === 'string') {
        for (const m of input.command.matchAll(WT_CREATE)) created.push(m[1].replace(/^["']|["']$/g, ''));
        for (const [branch, task] of mergedBranches(input.command)) merged.push({ branch, task, at, line });
      }
    }
  });

  const agents = [];
  for (const use of launches) {
    const res = results.get(use.id);
    if (!res) continue;
    const agent = agentFrom(use, res.agentId, res.prompt);
    if (agent.role === 'worker') {
      const prompt = typeof use.input?.prompt === 'string' ? use.input.prompt : res.prompt;
      promptImage ??= IMAGE_IN_PROMPT.exec(prompt)?.[1] ?? null;
      promptPlan ??= TASK_IN_PROMPT.exec(prompt)?.[2] ?? null;
    }
    agents.push(agent);
  }

  const imagePath = resetImage ?? writeImage ?? promptImage;
  // The plan branch: a wt switch without -tN, else a worker branch from a wt switch
  // with its -tN removed, else the same from a worker's worktree folder name.
  const branch = planBranch([...created, ...agents.map((a) => (a.worktree ? a.worktree.split('/').pop() : null)).filter(Boolean)]);
  const known = new Set(agents.map((a) => a.agentId));
  const seenTasks = new Set();
  const merges = [];
  for (const m of merged) {
    if ((branch !== null && m.branch !== branch) || seenTasks.has(m.task)) continue;
    seenTasks.add(m.task);
    merges.push({ task: m.task, at: m.at, line: m.line });
  }

  return {
    isOrchestrator: sawSkill || resetImage !== null,
    imagePath,
    planPath: resetPlan ?? promptPlan,
    boardPath: monitorBoard ?? (imagePath ? imagePath.replace(/\.md$/, '.board.jsonl') : null),
    branch,
    finishing,
    agents,
    steers: sends.filter((s) => known.has(s.to)),
    merges,
  };
}

module.exports = { parseOrchestrator };
