'use strict';

// Pure functions behind bin/skill-cost: they find where a session ran the orchestrate
// or subagent-driven-development skill, group sessions into runs, and compare the
// costs of the two skills. Nothing here reads a file or runs git, so the tests feed
// them text and plain objects.

const SKILLS = {
  orchestrate: 'orchestrate',
  'superpowers:subagent-driven-development': 'sdd',
};
const COMMAND_NAME = /<command-name>\/?([^<\s]+)\s*<\/command-name>/;
const ORCHESTRATOR = /You are the orchestrator for (\S+)/;
const ORCHESTRATOR_G = /You are the orchestrator for ([^\s"\\]+)/g;

// The plan path an orchestrator sentence names: the next token, without a trailing dot.
function planPathOf(token) {
  return token.replace(/\.+$/, '');
}

// The text of a user line when it is a plain string or text blocks. Tool results give ''.
function userText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

// Reads the text of one main session transcript. Returns
// { markers: [{skill, t}], firstT, lastT, prompts: [t], execPlan, planPaths }.
//   markers   each place the session called the Skill tool or the user typed the
//             slash command for a target skill, sorted by time. `skill` is
//             'orchestrate' or 'sdd'.
//   prompts   times of real user prompts: string content not starting with '<', not isMeta.
//   execPlan  the plan path when the first real prompt says "You are the orchestrator
//             for <plan>" (an orchestrate execution session), else null.
//   planPaths every plan path any line of the session names after that sentence (the
//             planning session queues the sentence as its reset line).
function scanSession(text) {
  const markers = [];
  const prompts = [];
  const planPaths = new Set();
  let firstT = null;
  let lastT = null;
  let execPlan = null;
  let sawPrompt = false;
  let execT = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    const mentionsSkill = line.includes('orchestrate') || line.includes('subagent-driven-development');
    const mentionsPrompt = line.includes('"user"');
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const t = Date.parse(parsed?.timestamp);
    if (!Number.isFinite(t)) continue;
    if (firstT === null || t < firstT) firstT = t;
    if (lastT === null || t > lastT) lastT = t;
    if (line.includes('You are the orchestrator for')) {
      // The skill's own text says "<plan path>" as a placeholder; a real path never starts with <.
      for (const m of line.matchAll(ORCHESTRATOR_G)) if (!m[1].startsWith('<')) planPaths.add(planPathOf(m[1]));
    }
    const content = parsed.message?.content;
    if (parsed.type === 'assistant' && mentionsSkill && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'tool_use' && b.name === 'Skill' && SKILLS[b.input?.skill]) markers.push({ skill: SKILLS[b.input.skill], t });
      }
    }
    if (parsed.type === 'user' && !parsed.isMeta && mentionsPrompt) {
      const s = userText(content);
      if (s.trimStart().startsWith('<command')) {
        const m = mentionsSkill ? COMMAND_NAME.exec(s) : null;
        if (m && SKILLS[m[1]]) markers.push({ skill: SKILLS[m[1]], t });
      } else if (typeof content === 'string' && !s.startsWith('<')) {
        let m = !sawPrompt ? ORCHESTRATOR.exec(s) : null;
        if (m?.[1].startsWith('<')) m = null;
        sawPrompt = true;
        if (m) {
          execPlan = planPathOf(m[1]);
          execT = t;
        } else {
          prompts.push(t);
        }
      }
    }
  }
  // An execution session never runs the skill itself: its first prompt starts the run.
  if (execT !== null) markers.push({ skill: 'orchestrate', t: execT });
  markers.sort((a, b) => a.t - b.t);
  return { markers, firstT, lastT, prompts, execPlan, planPaths: [...planPaths] };
}

// Parses `--until <sessionIdPrefix>=<ISO time>`. Returns { prefix, t } or null.
function parseUntil(arg) {
  const i = arg.indexOf('=');
  if (i <= 0) return null;
  const t = Date.parse(arg.slice(i + 1));
  return Number.isFinite(t) ? { prefix: arg.slice(0, i), t } : null;
}

// The segment of a scanned session: { skill, start, end }, or null when the session
// has no marker. It starts at the first marker. It ends at the next marker of a
// different skill, else at the session's last timestamp, and at an `--until` time for
// this session id when that comes first.
function segmentOf(scan, sessionId, untils = []) {
  const first = scan.markers[0];
  if (!first) return null;
  const next = scan.markers.find((m) => m.skill !== first.skill);
  let end = next ? next.t : scan.lastT;
  for (const u of untils) if (sessionId.startsWith(u.prefix) && u.t < end) end = u.t;
  if (end < first.t) return null;
  return { skill: first.skill, start: first.t, end };
}

// Groups segmented sessions into runs. Each item is { id, scan, segment, ... }.
// Orchestrate sessions that name the same plan path (a planning session and its
// execution session) form one run, and an orchestrate session with no partner is its
// own run. Each sdd session is its own run. Returns [{ skill, items }] sorted by start.
function pairRuns(items) {
  const runs = [];
  const byPlan = new Map();
  for (const item of items) {
    if (!item.segment) continue;
    if (item.segment.skill !== 'orchestrate') {
      runs.push({ skill: item.segment.skill, items: [item] });
      continue;
    }
    const paths = [item.scan.execPlan, ...item.scan.planPaths].filter(Boolean);
    let run = paths.map((p) => byPlan.get(p)).find(Boolean);
    if (!run) {
      run = { skill: 'orchestrate', items: [] };
      runs.push(run);
    }
    run.items.push(item);
    for (const p of paths) byPlan.set(p, run);
  }
  for (const r of runs) r.items.sort((a, b) => a.segment.start - b.segment.start);
  return runs.sort((a, b) => a.items[0].segment.start - b.items[0].segment.start);
}

// The commits a segment's own work produced. lib/commits.js marks a rebased or
// cherry-picked copy `rewrite` and a commit only the reflog reaches `fromReflog`.
// lineRows drops such a row only when another transcript holds the original, and this
// script reads one run at a time, so a copy of work authored before the segment
// started (a rebase of an earlier PR's commits) would count as the run's lines.
function ownCommits(commits, start) {
  return commits.filter((c) => !(c.rewrite || c.fromReflog) || !(c.authorTime * 1000 < start));
}

// A run's numbers. `m` holds the sums the caller measured:
// { mainCost, subCost, subagents, added, removed, prompts }.
function runMetrics(m) {
  const total = m.mainCost + m.subCost;
  const lines = m.added + m.removed;
  return {
    ...m,
    totalCost: total,
    lines,
    costPerSubagent: m.subagents > 0 ? total / m.subagents : null,
    costPer100Lines: lines > 0 ? (total / lines) * 100 : null,
  };
}

function median(values) {
  const v = values.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Percent difference of `a` against `b`: (a - b) / b * 100. Null when either is
// missing or b is 0.
function pctDiff(a, b) {
  if (a == null || b == null || b === 0) return null;
  return ((a - b) / b) * 100;
}

// Summary per skill over runs with at least minSubagents subagents.
function summarise(runs, { minSubagents = 5 } = {}) {
  const kept = runs.filter((r) => r.subagents >= minSubagents);
  const out = {};
  for (const skill of ['orchestrate', 'sdd']) {
    const rs = kept.filter((r) => r.skill === skill);
    out[skill] = {
      runs: rs.length,
      medianPerSubagent: median(rs.map((r) => r.costPerSubagent)),
      medianPer100Lines: median(rs.map((r) => r.costPer100Lines)),
    };
  }
  out.diff = {
    perSubagent: pctDiff(out.orchestrate.medianPerSubagent, out.sdd.medianPerSubagent),
    per100Lines: pctDiff(out.orchestrate.medianPer100Lines, out.sdd.medianPer100Lines),
  };
  return out;
}

// For each orchestrate run with lines > 0, the sdd runs whose changed lines are within
// ±band of it. Returns { pairs: [{ run, matches, medianMatches }], overall }.
function similarSize(runs, { minSubagents = 5, band = 0.5 } = {}) {
  const kept = runs.filter((r) => r.subagents >= minSubagents && r.lines > 0);
  const sdd = kept.filter((r) => r.skill === 'sdd');
  const pairs = [];
  const matched = new Set();
  for (const run of kept.filter((r) => r.skill === 'orchestrate')) {
    const matches = sdd.filter((s) => s.lines >= run.lines * (1 - band) && s.lines <= run.lines * (1 + band));
    for (const s of matches) matched.add(s);
    pairs.push({ run, matches, medianMatches: median(matches.map((s) => s.costPer100Lines)) });
  }
  const orch = pairs.filter((p) => p.matches.length);
  const orchMedian = median(orch.map((p) => p.run.costPer100Lines));
  const sddMedian = median([...matched].map((s) => s.costPer100Lines));
  return { pairs, overall: { orchestrate: orchMedian, sdd: sddMedian, diff: pctDiff(orchMedian, sddMedian), matchedRuns: orch.length } };
}

const usd = (x) => (x == null ? '-' : `$${x.toFixed(2)}`);
const pad = (s, n, right) => (right ? String(s).padStart(n) : String(s).padEnd(n));
const when = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
const verdict = (d, what) => (d == null ? `${what}: no comparison` : `orchestrate costs ${Math.abs(d).toFixed(0)}% ${d <= 0 ? 'less' : 'more'} ${what}`);

function renderText(runs, summary, similar, { minSubagents = 5 } = {}) {
  const lines = [];
  const head = ['start (UTC)', 'skill', 'sessions', 'project', 'subs', 'main', 'subagents', 'total', '+lines', '-lines', '$/sub', '$/100 lines', 'asks'];
  const rows = runs.map((r) => [
    when(r.start), r.skill, r.sessionIds.join('+'), r.project.length > 24 ? `…${r.project.slice(-23)}` : r.project, r.subagents,
    usd(r.mainCost), usd(r.subCost), usd(r.totalCost), r.added, r.removed, usd(r.costPerSubagent), usd(r.costPer100Lines), r.prompts,
  ].map(String));
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (r) => r.map((c, i) => pad(c, widths[i], i >= 4 && i !== 3)).join('  ');
  lines.push(`Runs (${runs.length})`, fmt(head), ...rows.map(fmt), '');

  lines.push(`Summary per skill (runs with at least ${minSubagents} subagents)`);
  for (const skill of ['orchestrate', 'sdd']) {
    const s = summary[skill];
    lines.push(`  ${pad(skill, 12)} runs ${s.runs}  median ${usd(s.medianPerSubagent)}/subagent  median ${usd(s.medianPer100Lines)}/100 lines`);
  }
  lines.push(`  ${verdict(summary.diff.perSubagent, 'per subagent')}`, `  ${verdict(summary.diff.per100Lines, 'per 100 lines')}`, '');

  lines.push('Similar-size comparison');
  if (!similar.pairs.length) lines.push('  no orchestrate run with changed lines');
  for (const p of similar.pairs) {
    const id = p.run.sessionIds.join('+');
    if (!p.matches.length) {
      lines.push(`  ${id} (${p.run.lines} lines, ${usd(p.run.costPer100Lines)}/100): no SDD run of similar size`);
      continue;
    }
    lines.push(`  ${id} (${p.run.lines} lines, ${usd(p.run.costPer100Lines)}/100) vs median ${usd(p.medianMatches)}/100 of ${p.matches.length} SDD run(s):`);
    for (const s of p.matches) lines.push(`    ${s.sessionIds.join('+')} ${s.lines} lines, ${usd(s.costPer100Lines)}/100`);
  }
  const o = similar.overall;
  lines.push(o.diff == null
    ? '  Overall: no SDD run of similar size'
    : `  Overall: orchestrate median ${usd(o.orchestrate)}/100 lines vs matched SDD median ${usd(o.sdd)}/100 lines (${verdict(o.diff, 'per 100 lines')})`);
  lines.push('', 'Note: lines changed include tests. Cost per subagent and cost per 100 lines are both rough, and neither is the only measure.');
  return lines.join('\n');
}

module.exports = { scanSession, parseUntil, segmentOf, pairRuns, ownCommits, runMetrics, median, pctDiff, summarise, similarSize, renderText };
