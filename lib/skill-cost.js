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
const ORCHESTRATOR_G = /You are the orchestrator for (\S+)/g;
const FINISH_SKILL = 'superpowers:finishing-a-development-branch';
const IMAGE_DIR = '/docs/superpowers/images/';

// The plan path an orchestrator sentence names: the next token without trailing
// punctuation or quotes. Null unless it is an absolute path ending in .md.
function planPathOf(token) {
  const p = token.replace(/[.,;:)\]}"'`\\]+$/, '');
  return p.startsWith('/') && p.endsWith('.md') ? p : null;
}

// Every string inside a value, for reading the text and tool inputs the model wrote.
function stringsIn(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) stringsIn(v, out);
  return out;
}

// Drops edit rows for the orchestrate context image, board and feedback files. They
// are written prose under docs/superpowers/images/, not code.
function dropContextImages(edits) {
  return edits.filter((e) => !(typeof e.file === 'string' && e.file.includes(IMAGE_DIR)));
}

// The text of a user line when it is a plain string or text blocks. Tool results give ''.
function userText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

// Reads the text of one main session transcript. Returns
// { markers: [{skill, t}], finishes: [t], firstT, lastT, prompts: [t], execPlan, planPaths }.
//   markers   each place the session called the Skill tool or the user typed the
//             slash command for a target skill, sorted by time. `skill` is
//             'orchestrate' or 'sdd'.
//   finishes  times of assistant Skill calls to finishing-a-development-branch.
//   prompts   times of real user prompts: string content not starting with '<', not isMeta.
//   execPlan  the absolute .md plan path when the first real prompt says "You are the
//             orchestrator for <plan>" (an orchestrate execution session), else null.
//   planPaths every absolute .md plan path the assistant wrote after that sentence, in
//             text blocks and tool inputs (the planning session queues the sentence as
//             its reset line). Tool results and user lines are not read.
function scanSession(text) {
  const markers = [];
  const finishes = [];
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
    const content = parsed.message?.content;
    if (parsed.type === 'assistant' && line.includes('You are the orchestrator for')) {
      for (const str of stringsIn(content)) {
        for (const m of str.matchAll(ORCHESTRATOR_G)) {
          const p = planPathOf(m[1]);
          if (p) planPaths.add(p);
        }
      }
    }
    if (parsed.type === 'assistant' && line.includes(FINISH_SKILL) && Array.isArray(content)) {
      for (const b of content) if (b?.type === 'tool_use' && b.name === 'Skill' && b.input?.skill === FINISH_SKILL) finishes.push(t);
    }
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
        const m = !sawPrompt ? ORCHESTRATOR.exec(s) : null;
        const plan = m ? planPathOf(m[1]) : null;
        sawPrompt = true;
        if (plan) {
          execPlan = plan;
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
  finishes.sort((a, b) => a - b);
  return { markers, finishes, firstT, lastT, prompts, execPlan, planPaths: [...planPaths] };
}

// Parses `--until <sessionIdPrefix>=<ISO time>`. Returns { prefix, t } or null.
function parseUntil(arg) {
  const i = arg.indexOf('=');
  if (i <= 0) return null;
  const t = Date.parse(arg.slice(i + 1));
  return Number.isFinite(t) ? { prefix: arg.slice(0, i), t } : null;
}

// The segments of a scanned session: [{ skill, start, end }] in time order. A segment
// starts at a marker of a target skill and ends at the earliest of: a marker of the
// other target skill (which starts the next segment), a finishing-a-development-branch
// call (the next marker after it starts a new segment), an `--until` time for this
// session id, and the session's last timestamp. A repeated marker of the same skill
// inside a segment does not split it. Markers after an `--until` time are ignored.
function segmentsOf(scan, sessionId, untils = []) {
  let limit = scan.lastT;
  for (const u of untils) if (sessionId.startsWith(u.prefix) && u.t < limit) limit = u.t;
  const segments = [];
  let prevEnd = -Infinity;
  for (const m of scan.markers) {
    if (m.t < prevEnd || m.t > limit) continue;
    let end = limit;
    const other = scan.markers.find((x) => x.skill !== m.skill && x.t > m.t);
    if (other && other.t < end) end = other.t;
    const fin = scan.finishes.find((f) => f > m.t);
    if (fin !== undefined && fin < end) end = fin;
    segments.push({ skill: m.skill, start: m.t, end });
    prevEnd = end;
  }
  return segments;
}

// Groups segments into runs. Each item is { id, scan, segment, ... }, one per segment.
// Orchestrate segments that name the same plan path (a planning session and its
// execution session) form one run. When one segment names paths that belong to two
// runs, those runs merge. An orchestrate segment with no partner is its own run, and
// each sdd segment is its own run. Returns [{ skill, items }] sorted by start.
function pairRuns(items) {
  let runs = [];
  const byPlan = new Map();
  for (const item of items) {
    if (!item.segment) continue;
    if (item.segment.skill !== 'orchestrate') {
      runs.push({ skill: item.segment.skill, items: [item] });
      continue;
    }
    const paths = [item.scan.execPlan, ...item.scan.planPaths].filter(Boolean);
    const found = [...new Set(paths.map((p) => byPlan.get(p)).filter(Boolean))];
    let run = found[0];
    if (!run) {
      run = { skill: 'orchestrate', items: [] };
      runs.push(run);
    }
    for (const other of found.slice(1)) {
      run.items.push(...other.items);
      for (const [p, r] of byPlan) if (r === other) byPlan.set(p, run);
      runs = runs.filter((r) => r !== other);
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
  return { pairs, overall: { orchestrate: orchMedian, sdd: sddMedian, diff: pctDiff(orchMedian, sddMedian), matchedRuns: orch.length, sddRuns: matched.size } };
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
    : `  Overall: orchestrate median ${usd(o.orchestrate)}/100 lines vs matched SDD median ${usd(o.sdd)}/100 lines over ${o.sddRuns} run${o.sddRuns === 1 ? '' : 's'}${o.sddRuns < 3 ? ' (few runs)' : ''} (${verdict(o.diff, 'per 100 lines')})`);
  lines.push('', 'Note: lines changed include tests. Cost per subagent and cost per 100 lines are both rough, and neither is the only measure.');
  return lines.join('\n');
}

module.exports = { scanSession, parseUntil, segmentsOf, dropContextImages,  pairRuns, ownCommits, runMetrics, median, pctDiff, summarise, similarSize, renderText };
