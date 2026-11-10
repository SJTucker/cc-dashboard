'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir } = require('./helpers');
const sc = require('../lib/skill-cost');

const BIN = path.join(__dirname, '..', 'bin', 'skill-cost');
const iso = (m) => new Date(Date.UTC(2026, 10, 1, 10, m)).toISOString();
const T = (m) => Date.parse(iso(m));

const skillCall = (m, skill) => JSON.stringify({ type: 'assistant', timestamp: iso(m), message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill } }] } });
const typedCmd = (m, name) => JSON.stringify({ type: 'user', timestamp: iso(m), message: { content: `<command-message>x</command-message>\n<command-name>/${name}</command-name>` } });
const prompt = (m, text) => JSON.stringify({ type: 'user', timestamp: iso(m), message: { content: text } });
const text = (...lines) => lines.join('\n') + '\n';
const SDD = 'superpowers:subagent-driven-development';

test('segment starts at a Skill tool call and ends at the last timestamp', () => {
  const scan = sc.scanSession(text(prompt(0, 'hi'), skillCall(5, SDD), prompt(9, 'more')));
  assert.deepStrictEqual(sc.segmentsOf(scan, 'abc'), [{ skill: 'sdd', start: T(5), end: T(9) }]);
});

test('segment starts at a typed slash command', () => {
  const scan = sc.scanSession(text(prompt(0, 'hi'), typedCmd(3, 'orchestrate'), prompt(8, 'x')));
  assert.deepStrictEqual(sc.segmentsOf(scan, 'abc'), [{ skill: 'orchestrate', start: T(3), end: T(8) }]);
  assert.deepStrictEqual(sc.scanSession(text(typedCmd(1, SDD))).markers, [{ skill: 'sdd', t: T(1) }]);
});

test('a marker of a different target skill ends the segment and starts the next, the same skill does not', () => {
  const scan = sc.scanSession(text(skillCall(1, 'orchestrate'), skillCall(4, 'orchestrate'), skillCall(6, SDD), prompt(9, 'x')));
  assert.deepStrictEqual(sc.segmentsOf(scan, 'abc'), [{ skill: 'orchestrate', start: T(1), end: T(6) }, { skill: 'sdd', start: T(6), end: T(9) }]);
});

test('no marker gives no segment', () => {
  assert.deepStrictEqual(sc.segmentsOf(sc.scanSession(text(prompt(0, 'orchestrate me'))), 'abc'), []);
});

test('--until cuts the segment of the matching session only', () => {
  const scan = sc.scanSession(text(skillCall(1, SDD), prompt(9, 'x')));
  const u = sc.parseUntil(`abc=${iso(5)}`);
  assert.deepStrictEqual(u, { prefix: 'abc', t: T(5) });
  assert.strictEqual(sc.segmentsOf(scan, 'abcdef', [u])[0].end, T(5));
  assert.strictEqual(sc.segmentsOf(scan, 'zzz', [u])[0].end, T(9));
  assert.strictEqual(sc.parseUntil('nonsense'), null);
});

test('real prompts skip commands, meta lines and tool results', () => {
  const meta = JSON.stringify({ type: 'user', isMeta: true, timestamp: iso(2), message: { content: 'meta' } });
  const result = JSON.stringify({ type: 'user', timestamp: iso(3), message: { content: [{ type: 'tool_result', content: 'x' }] } });
  const scan = sc.scanSession(text(typedCmd(1, SDD), meta, result, prompt(4, 'do it'), prompt(5, '<local-command>x')));
  assert.deepStrictEqual(scan.prompts, [T(4)]);
});

test('planning and execution sessions of one plan form one run', () => {
  const sentence = 'Read /img/a.md. You are the orchestrator for /plans/p.md. Go.';
  const planning = sc.scanSession(text(typedCmd(1, 'orchestrate'), JSON.stringify({ type: 'assistant', timestamp: iso(2), message: { content: [{ type: 'text', text: sentence }] } })));
  const exec = sc.scanSession(text(prompt(10, sentence), prompt(12, 'ok')));
  assert.strictEqual(exec.execPlan, '/plans/p.md');
  assert.deepStrictEqual(planning.planPaths, ['/plans/p.md']);
  const lonely = sc.scanSession(text(typedCmd(1, 'orchestrate')));
  const sddScan = sc.scanSession(text(typedCmd(1, SDD)));
  const items = [planning, exec, lonely, sddScan].map((scan, i) => ({ id: `s${i}`, scan, segment: sc.segmentsOf(scan, `s${i}`)[0] }));
  const runs = sc.pairRuns(items);
  assert.strictEqual(runs.length, 3);
  const paired = runs.find((r) => r.items.length === 2);
  assert.deepStrictEqual(paired.items.map((i) => i.id), ['s0', 's1']);
  assert.strictEqual(paired.skill, 'orchestrate');
  assert.deepStrictEqual(exec.prompts, [T(12)]);
});

test('a placeholder plan path in the skill text does not pair sessions', () => {
  const a = sc.scanSession(text(typedCmd(1, 'orchestrate'), prompt(2, 'You are the orchestrator for <plan path>.')));
  assert.deepStrictEqual(a.planPaths, []);
});

test('ownCommits drops rewritten and reflog copies of work authored before the segment', () => {
  const start = Date.parse('2026-11-10T16:00:00Z');
  const before = start / 1000 - 86400;
  const after = start / 1000 + 60;
  const commits = [
    { sha: 'a', authorTime: before },
    { sha: 'b', authorTime: before, rewrite: true },
    { sha: 'c', authorTime: before, fromReflog: true },
    { sha: 'd', authorTime: after, rewrite: true },
  ];
  assert.deepStrictEqual(sc.ownCommits(commits, start).map((c) => c.sha), ['a', 'd']);
});

test('median and percent difference', () => {
  assert.strictEqual(sc.median([3, 1, 2]), 2);
  assert.strictEqual(sc.median([4, 1, null, 2, 3]), 2.5);
  assert.strictEqual(sc.median([]), null);
  assert.strictEqual(sc.pctDiff(50, 100), -50);
  assert.strictEqual(sc.pctDiff(150, 100), 50);
  assert.strictEqual(sc.pctDiff(1, 0), null);
  assert.strictEqual(sc.pctDiff(null, 5), null);
});

test('runMetrics divides by subagents and by lines, null on zero', () => {
  const r = sc.runMetrics({ mainCost: 4, subCost: 6, subagents: 5, added: 150, removed: 50, prompts: 1 });
  assert.strictEqual(r.totalCost, 10);
  assert.strictEqual(r.costPerSubagent, 2);
  assert.strictEqual(r.costPer100Lines, 5);
  const z = sc.runMetrics({ mainCost: 1, subCost: 0, subagents: 0, added: 0, removed: 0, prompts: 0 });
  assert.strictEqual(z.costPerSubagent, null);
  assert.strictEqual(z.costPer100Lines, null);
});

function run(skill, lines, cost, subagents, id) {
  return { skill, sessionIds: [id], subagents, lines, costPer100Lines: lines ? (cost / lines) * 100 : null, costPerSubagent: subagents ? cost / subagents : null };
}

test('similar-size matching uses the band, min subagents and skips lines 0', () => {
  const runs = [
    run('orchestrate', 1000, 10, 6, 'o1'),
    run('sdd', 1400, 28, 6, 's1'), // inside +-50%
    run('sdd', 1600, 16, 6, 's2'), // outside
    run('sdd', 1000, 5, 2, 's3'), // too few subagents
    run('sdd', 500, 15, 6, 's4'), // on the lower edge
  ];
  const { pairs, overall } = sc.similarSize(runs, { minSubagents: 5, band: 0.5 });
  assert.deepStrictEqual(pairs[0].matches.map((s) => s.sessionIds[0]), ['s1', 's4']);
  assert.strictEqual(pairs[0].medianMatches, 2.5);
  assert.strictEqual(overall.orchestrate, 1);
  assert.strictEqual(overall.sdd, 2.5);
  assert.strictEqual(overall.diff, -60);
});

test('similar-size matching reports no match when no SDD run is close', () => {
  const runs = [run('orchestrate', 1000, 10, 6, 'o1'), run('sdd', 100, 5, 6, 's1')];
  const sim = sc.similarSize(runs, {});
  assert.deepStrictEqual(sim.pairs[0].matches, []);
  assert.strictEqual(sim.overall.diff, null);
  const out = sc.renderText([{ ...runs[0], project: 'p', start: T(0), mainCost: 1, subCost: 0, totalCost: 10, added: 1000, removed: 0, prompts: 0 }], sc.summarise(runs, {}), sim, {});
  assert.match(out, /no SDD run of similar size/);
});

test('summarise says orchestrate costs less or more', () => {
  const runs = [run('orchestrate', 100, 5, 5, 'o'), run('sdd', 100, 10, 5, 's')];
  const s = sc.summarise(runs, { minSubagents: 5 });
  assert.strictEqual(s.diff.perSubagent, -50);
  assert.strictEqual(s.diff.per100Lines, -50);
});

test('bin/skill-cost totals a segment and counts its subagent', (t) => {
  const cfg = tmpDir(t, 'skill-cost');
  const proj = path.join(cfg, 'projects', 'demo');
  const sid = '11111111-aaaa';
  fs.mkdirSync(path.join(proj, sid, 'subagents'), { recursive: true });
  const usage = (m, id, side) => JSON.stringify({
    type: 'assistant', timestamp: iso(m), requestId: `r${id}`, isSidechain: side, sessionId: sid,
    message: { id: `m${id}`, model: 'claude-sonnet-4-5', role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 1000000, output_tokens: 0 } },
  });
  fs.writeFileSync(path.join(proj, `${sid}.jsonl`), text(prompt(0, 'hi'), skillCall(1, SDD), usage(2, 1, false), prompt(3, 'go')));
  fs.writeFileSync(path.join(proj, sid, 'subagents', 'agent-a1.jsonl'), text(usage(2, 2, true)));
  const r = spawnSync(process.execPath, [BIN, '--json', '--min-subagents', '1'], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: cfg } });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.runs.length, 1);
  assert.strictEqual(out.runs[0].subagents, 1);
  assert.strictEqual(out.runs[0].prompts, 1);
  assert.ok(out.runs[0].totalCost > 0);
  assert.strictEqual(out.runs[0].totalCost, 2 * out.runs[0].mainCost);
});

const asstText = (m, t) => JSON.stringify({ type: 'assistant', timestamp: iso(m), message: { content: [{ type: 'text', text: t }] } });
const asstBash = (m, command) => JSON.stringify({ type: 'assistant', timestamp: iso(m), message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
const toolResult = (m, t) => JSON.stringify({ type: 'user', timestamp: iso(m), message: { content: [{ type: 'tool_result', content: t }] } });
const FINISH = 'superpowers:finishing-a-development-branch';

test('a session with orchestrate then SDD gives two segments', () => {
  const scan = sc.scanSession(text(skillCall(1, 'orchestrate'), skillCall(5, SDD), prompt(9, 'x')));
  assert.deepStrictEqual(sc.segmentsOf(scan, 'abc'), [
    { skill: 'orchestrate', start: T(1), end: T(5) },
    { skill: 'sdd', start: T(5), end: T(9) },
  ]);
});

test('a reset-line orchestrate marker followed by an SDD call gives a tiny orchestrate segment', () => {
  const scan = sc.scanSession(text(prompt(0, 'You are the orchestrator for /plans/p.md. Go.'), skillCall(1, SDD), prompt(9, 'x')));
  const segs = sc.segmentsOf(scan, 'abc');
  assert.deepStrictEqual(segs.map((s) => s.skill), ['orchestrate', 'sdd']);
  assert.strictEqual(segs[0].end - segs[0].start, 60000);
  assert.strictEqual(segs[1].end, T(9));
});

test('finishing-a-development-branch ends a segment and a later marker starts a new one', () => {
  const scan = sc.scanSession(text(skillCall(1, SDD), skillCall(3, SDD), skillCall(5, FINISH), prompt(6, 'x'), skillCall(7, SDD), prompt(9, 'y')));
  assert.deepStrictEqual(sc.segmentsOf(scan, 'abc'), [
    { skill: 'sdd', start: T(1), end: T(5) },
    { skill: 'sdd', start: T(7), end: T(9) },
  ]);
});

test('plan paths come only from assistant lines', () => {
  const sentence = 'You are the orchestrator for /plans/p.md.';
  const scan = sc.scanSession(text(
    toolResult(1, 'if (x) { // You are the orchestrator for ( ) } and You are the orchestrator for /plans/leak.md.'),
    prompt(2, sentence.replace('p.md', 'user.md')),
    asstBash(3, `printf '%s' "${sentence}" > reset.txt`),
  ));
  assert.deepStrictEqual(scan.planPaths, ['/plans/p.md']);
});

test('a non-absolute or non-.md plan token is ignored', () => {
  const scan = sc.scanSession(text(
    asstText(1, 'You are the orchestrator for plans/p.md. And You are the orchestrator for /plans/p.txt. And You are the orchestrator for (.'),
    prompt(2, 'You are the orchestrator for relative/p.md.'),
  ));
  assert.deepStrictEqual(scan.planPaths, []);
  assert.strictEqual(scan.execPlan, null);
  assert.deepStrictEqual(scan.markers, []);
});

test('pairRuns merges two runs that one segment links', () => {
  const mk = (id, m, execPlan, planPaths) => ({ id, scan: { execPlan, planPaths }, segment: { skill: 'orchestrate', start: T(m), end: T(m + 1) } });
  const items = [mk('a', 1, '/p/a.md', []), mk('b', 2, '/p/b.md', []), mk('c', 3, null, ['/p/a.md', '/p/b.md'])];
  const runs = sc.pairRuns(items);
  assert.strictEqual(runs.length, 1);
  assert.deepStrictEqual(runs[0].items.map((i) => i.id), ['a', 'b', 'c']);
});

test('dropContextImages removes edits under docs/superpowers/images', () => {
  const edits = [{ file: '/r/docs/superpowers/images/x-image.md' }, { file: '/r/lib/a.js' }, { file: null }];
  assert.deepStrictEqual(sc.dropContextImages(edits), [{ file: '/r/lib/a.js' }, { file: null }]);
});

test('the overall line states the SDD run count and flags few runs', () => {
  const runs = [run('orchestrate', 1000, 10, 6, 'o1'), run('sdd', 1000, 20, 6, 's1')];
  const sim = sc.similarSize(runs, {});
  assert.strictEqual(sim.overall.sddRuns, 1);
  const out = sc.renderText([], sc.summarise(runs, {}), sim, {});
  assert.match(out, /matched SDD median \$2\.00\/100 lines over 1 run \(few runs\)/);
  const many = [runs[0], ...[1, 2, 3].map((i) => run('sdd', 1000, 20, 6, `s${i}`))];
  const out3 = sc.renderText([], sc.summarise(many, {}), sc.similarSize(many, {}), {});
  assert.match(out3, /over 3 runs \(/);
  assert.doesNotMatch(out3, /few runs/);
});

test('bin/skill-cost counts keyless calls without deduping them', (t) => {
  const cfg = tmpDir(t, 'skill-cost');
  const proj = path.join(cfg, 'projects', 'demo');
  const sid = '22222222-bbbb';
  fs.mkdirSync(proj, { recursive: true });
  const keyless = (m) => JSON.stringify({
    type: 'assistant', timestamp: iso(m), sessionId: sid,
    message: { model: 'claude-sonnet-4-5', role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 1000000, output_tokens: 0 } },
  });
  fs.writeFileSync(path.join(proj, `${sid}.jsonl`), text(skillCall(1, SDD), keyless(2), keyless(3), prompt(4, 'go')));
  const r = spawnSync(process.execPath, [BIN, '--json', '--min-subagents', '0'], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: cfg } });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.runs.length, 1);
  assert.strictEqual(out.runs[0].mainCost, 2 * costOne());
});

function costOne() {
  const { costForUsage } = require('../lib/pricing');
  return costForUsage({ input_tokens: 1000000, output_tokens: 0 }, 'claude-sonnet-4-5', T(2)).cost;
}
