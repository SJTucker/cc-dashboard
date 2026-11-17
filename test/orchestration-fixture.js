'use strict';

// Writes an orchestration into a Claude config directory, for the API tests and for
// browser checks of the Orchestration tab.
//
//   writeOrchestration(configDir, opts) -> { sessionId, transcript, imagePath, boardPath, workerIds }
//
// opts (all optional):
//   project     project directory path; default <configDir>/work/<topic>
//   topic       plan name, default 'demo'. The plan branch is <topic>, worker branches <topic>-t<N>.
//   date        date prefix of the image, plan and board files, default '2026-11-10'
//   sessionId   orchestrator session id, default a random UUID
//   workers     [{ task, title, files, steps, finished, doneWhen, tokens, merged, steer }]
//     steps     the worker's tool calls, oldest first. { tool: 'Edit', file_path: 'lib/parse.js' }
//               becomes a tool_use named tool whose input is the other keys. { text: '...' }
//               with no tool is an assistant text record.
//     finished  true writes finished: true into the .meta.json and ends the transcript with the
//               worker's report as an assistant text record.
//     tokens    the context size of the worker's last assistant record, default grows with steps.
//     lateReport true writes the worker's final report record after every worker has started, so
//               its lastActiveAt is later than the other workers' startedAt and they share its wave.
//     merged    true adds a parent Bash `git merge <topic>-t<N>`.
//     steer     a string adds a parent SendMessage to the worker with that message.
//   claims      true: workers get the fixed first message (description `orchestrate worker`) and
//               their task through the claim queue. The run folder <image>.run/claimed/ holds one task
//               file per claim, and each worker transcript has the image Read, the orch-claim Bash call
//               and its CLAIMED result. Per worker: `claim: false` leaves it unclaimed, `claims: 2` adds a
//               second claim (task number + 10).
//   reviewers   with claims: [{ task, finished, report }] reviewers started after the workers, each with
//               the fixed reviewer message and a claimed review task for that task number. A task may
//               appear more than once, one entry per review round, oldest first.
//   activity    { state: 'working'|'waiting', text? } writes <configDir>/cc-dashboard/activity/<sessionId>.json
//               in the shape lib/activity.js reads. With text, the orchestrator transcript ends with an
//               assistant text record holding it, so now.detail shows it.
//   pendingSteer { task, text } writes a steer request for that task's worker, with no result file. Its
//               at is 10 minutes after the time of writing, so lastSteer.state reads 'pending' for 10
//               minutes (a steer turns unclaimed only when now - at passes 30 s).
//   board       [{ t, from, title, body }] written to the board file, one JSON line each
//   clearedFrom session id written to the snapshot's clearedFrom
//   resetLine   true (or a string) makes the transcript's first user prompt the reset line
//               `Read <image>. You are the orchestrator for <plan>. Continue at ...`
//   live        true: the snapshot is active now and not ended, so the live rule holds.
//               false (default): the snapshot is 30 minutes old and ended.
//
// Run as `node test/orchestration-fixture.js <configDir>` to write a three-orchestration demo.
// writeDemo also writes <configDir>/skills/orchestrate/SKILL.md (a one-line placeholder), so a
// server run on that folder reports the orchestrate skill as installed and lists the runs.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CLONE = path.resolve(__dirname, '..');

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function writeOrchestration(configDir, opts = {}) {
  const topic = opts.topic ?? 'demo';
  const date = opts.date ?? '2026-11-10';
  const project = opts.project ?? path.join(configDir, 'work', topic);
  const sessionId = opts.sessionId ?? crypto.randomUUID();
  const workers = opts.workers ?? [];
  const live = opts.live === true;

  const imagePath = path.join(project, 'docs', 'superpowers', 'images', `${date}-${topic}.md`);
  const planPath = path.join(project, 'docs', 'superpowers', 'plans', `${date}-${topic}.md`);
  const boardPath = imagePath.replace(/\.md$/, '.board.jsonl');
  const projectDir = path.join(configDir, 'projects', project.replace(/[^A-Za-z0-9]/g, '-'));
  const transcript = path.join(projectDir, `${sessionId}.jsonl`);
  const subagents = path.join(projectDir, sessionId, 'subagents');

  // One clock for every record. Records are written with a placeholder time, counted
  // as they are made. Once the count is known the base is set to now (or 30 minutes
  // ago) minus count * 3 s, so the last record is at or before the end time and none
  // is in the future.
  const midnight = new Date().setHours(0, 0, 0, 0);
  const STEP_MS = 3000;
  let count = 0;
  const stamp = () => `@@${++count}@@`;

  const rec = (extra, o) => JSON.stringify({ sessionId, cwd: project, gitBranch: topic, timestamp: stamp(), ...extra, ...o });
  const parent = (o) => rec({}, o);
  const sidechain = (agentId) => (o) => rec({ isSidechain: true, agentId }, o);
  const use = (name, input, id) => ({ type: 'tool_use', id, name, input });
  const assistantOf = (make, blocks, usage) => make({ type: 'assistant', message: { role: 'assistant', content: blocks, ...(usage ? { usage } : {}) } });
  const resultOf = (make, id, extra = {}) => make({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: false }] }, ...extra });

  const lines = [];
  const prompt = opts.resetLine
    ? typeof opts.resetLine === 'string' ? opts.resetLine : `Read ${imagePath}. You are the orchestrator for ${planPath}. Continue at the next wave.`
    : `Orchestrate the ${topic} plan.`;
  lines.push(parent({ type: 'user', uuid: 'u-first', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: prompt } }));
  if (!opts.resetLine) {
    lines.push(assistantOf(parent, [use('Skill', { skill: 'orchestrate' }, 'toolu_skill')]));
    lines.push(resultOf(parent, 'toolu_skill'));
    lines.push(assistantOf(parent, [use('Write', { file_path: imagePath, content: `# ${topic}\n` }, 'toolu_image')]));
    lines.push(resultOf(parent, 'toolu_image'));
  }
  lines.push(assistantOf(parent, [use('Bash', { command: `cd ${project} && wt switch --create ${topic} --base main --no-cd` }, 'toolu_wt0')]));
  lines.push(resultOf(parent, 'toolu_wt0'));

  const runDir = imagePath.replace(/\.md$/, '.run');
  const claimed = opts.claims === true;
  const claimFiles = [];
  let seq = 0;
  const claimTask = (kind, n, title, files, doneWhen, extra = {}) => {
    const file = `${String(++seq).padStart(4, '0')}-t${n}-a1.json`;
    claimFiles.push({ file: path.join(runDir, 'claimed', file), task: { kind, task: n, title, plan: planPath, worktree: path.join(project, '.worktrees', `${topic}-t${n}`), branch: `${topic}-t${n}`, files, doneWhen, sections: [], attempt: 1, claimedAt: new Date().toISOString(), ...extra } });
    return file;
  };
  const firstMessage = (kind) => `Read ${imagePath} in full, then every file it lists under "Read before starting", in that order. Then run ${CLONE}/bin/orch-claim ${runDir} ${kind} and ${kind === 'review' ? 'review' : 'do'} the task it prints.\n`;
  // The tool records of one orch-claim call and its CLAIMED result, in a sidechain.
  const claimRecords = (side, id, kind, file) => [
    assistantOf(side, [use('Bash', { command: `${CLONE}/bin/orch-claim ${runDir} ${kind}` }, id)]),
    side({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `CLAIMED ${file}\nDo the task.`, is_error: false }] } }),
  ];
  const workerIds = [];
  const merges = [];
  const lateReports = [];
  const workerFiles = [];
  workers.forEach((w, i) => {
    const n = w.task ?? i + 1;
    const title = w.title ?? `Task ${n}`;
    const files = w.files ?? ['lib/x.js'];
    const agentId = 'a' + crypto.createHash('sha1').update(`${sessionId}:${n}`).digest('hex').slice(0, 16);
    workerIds.push(agentId);
    const worktree = path.join(project, '.worktrees', `${topic}-t${n}`);
    const description = claimed ? 'orchestrate worker' : `Task ${n} worker`;
    const workerPrompt = claimed ? firstMessage('work') : [
      `Your worktree is ${worktree}; work only there on branch ${topic}-t${n}.`,
      `Read ${imagePath} in full, then do Task ${n} of ${planPath}, "${title}".`,
      `Files this task touches: ${files.join(', ')}.`,
      `Done when: ${w.doneWhen ?? 'the tests for this task pass'}`,
    ].join('\n') + '\n';
    const workerFile = path.join(subagents, `agent-${agentId}.jsonl`);

    lines.push(assistantOf(parent, [use('Bash', { command: `cd ${project} && wt switch --create ${topic}-t${n} --base ${topic} --no-cd` }, `toolu_wt${n}`)]));
    lines.push(resultOf(parent, `toolu_wt${n}`));
    lines.push(assistantOf(parent, [use('Agent', { description, subagent_type: 'general-purpose', model: 'sonnet', prompt: workerPrompt }, `toolu_agent${n}`)]));
    lines.push(resultOf(parent, `toolu_agent${n}`, { toolUseResult: { isAsync: true, status: 'async_launched', agentId, description, resolvedModel: 'claude-sonnet-5-5', prompt: workerPrompt } }));
    lines.push(assistantOf(parent, [use('Monitor', { command: `${CLONE}/bin/transcript-index ${workerFile} --watch ${claimed ? `--run ${runDir}` : `--files ${files.join(',')}`} --budget 200000 --board ${boardPath}`, description: w.monitorDescription ?? description }, `toolu_mon${n}`)]));
    lines.push(resultOf(parent, `toolu_mon${n}`));

    // The worker's own transcript. Each assistant record carries usage, with the
    // context growing by 2000 tokens a step.
    const side = sidechain(agentId);
    const wl = [side({ type: 'user', uuid: `w${n}-u0`, message: { role: 'user', content: workerPrompt } })];
    if (claimed) {
      wl.push(assistantOf(side, [use('Read', { file_path: imagePath }, `w${n}-img`)]));
      wl.push(resultOf(side, `w${n}-img`));
      if (w.claim !== false) {
        for (const [k, num] of (w.claims === 2 ? [n, n + 10] : [n]).entries()) {
          wl.push(...claimRecords(side, `w${n}-claim${k}`, 'work', claimTask('work', num, k === 0 ? title : `Task ${num}`, k === 0 ? files : ['lib/other.js'], w.doneWhen ?? 'the tests for this task pass')));
        }
      }
    }
    const steps = w.steps ?? [];
    const usageAt = (k) => ({ input_tokens: 10, output_tokens: 100, cache_creation_input_tokens: 500, cache_read_input_tokens: 20000 + 2000 * k });
    steps.forEach((s, k) => {
      const last = k === steps.length - 1 && !w.finished;
      const usage = last && w.tokens ? { ...usageAt(k), cache_read_input_tokens: w.tokens - 510 } : usageAt(k);
      if (s.tool) {
        const { tool, ...input } = s;
        // A real worker edits absolute paths inside its worktree, so a relative file_path
        // in the step list is placed in this worker's worktree.
        if (typeof input.file_path === 'string' && !path.isAbsolute(input.file_path)) input.file_path = `${project}/.worktrees/${topic}-t${n}/${input.file_path}`;
        wl.push(assistantOf(side, [use(tool, input, `w${n}-t${k}`)], usage));
        wl.push(resultOf(side, `w${n}-t${k}`));
      } else {
        wl.push(assistantOf(side, [{ type: 'text', text: s.text ?? '' }], usage));
      }
    });
    if (w.finished) {
      const writeReport = () => {
        const usage = w.tokens ? { ...usageAt(steps.length), cache_read_input_tokens: w.tokens - 510 } : usageAt(steps.length);
        wl.push(assistantOf(side, [{ type: 'text', text: `Task ${n} done: ${title}. Tests pass.` }], usage));
      };
      if (w.lateReport) lateReports.push(writeReport);
      else writeReport();
    }
    workerFiles.push({ file: workerFile, lines: wl, meta: { agentType: 'general-purpose', description, toolUseId: `toolu_agent${n}`, spawnDepth: 1, requestShape: 'agent', model: 'claude-sonnet-5-5', ...(w.finished ? { finished: true } : {}) } });

    if (w.steer) lines.push(assistantOf(parent, [use('SendMessage', { to: agentId, summary: `Steer Task ${n}`, message: w.steer }, `toolu_send${n}`)]));
    // A merge follows the task's reviews, so it is written after the reviewer records.
    if (w.merged) {
      merges.push(() => {
        lines.push(assistantOf(parent, [use('Bash', { command: `cd ${project}/.worktrees/${topic} && git merge --no-ff ${topic}-t${n}` }, `toolu_merge${n}`)]));
        lines.push(resultOf(parent, `toolu_merge${n}`));
      });
    }
  });

  for (const writeReport of lateReports) writeReport();

  const reviewerIds = [];
  for (const [ri, rv] of (claimed ? opts.reviewers ?? [] : []).entries()) {
    const rid = `${rv.task}_${ri}`;
    const agentId = 'r' + crypto.createHash('sha1').update(`${sessionId}:review:${rid}`).digest('hex').slice(0, 16);
    reviewerIds.push(agentId);
    const description = 'orchestrate reviewer';
    const reviewPrompt = firstMessage('review');
    const reviewFile = path.join(subagents, `agent-${agentId}.jsonl`);
    lines.push(assistantOf(parent, [use('Agent', { description, subagent_type: 'general-purpose', model: 'sonnet', prompt: reviewPrompt }, `toolu_rev${rid}`)]));
    lines.push(resultOf(parent, `toolu_rev${rid}`, { toolUseResult: { isAsync: true, status: 'async_launched', agentId, description, resolvedModel: 'claude-sonnet-5-5', prompt: reviewPrompt } }));
    const side = sidechain(agentId);
    const rl = [side({ type: 'user', uuid: `r${rid}-u0`, message: { role: 'user', content: reviewPrompt } })];
    rl.push(...claimRecords(side, `r${rid}-claim`, 'review', claimTask('review', rv.task, `Review Task ${rv.task}`, ['lib/x.js'], 'the review is done')));
    if (rv.finished) rl.push(assistantOf(side, [{ type: 'text', text: rv.report ?? 'PASS: no findings.' }], { input_tokens: 10, output_tokens: 100, cache_creation_input_tokens: 500, cache_read_input_tokens: 20000 }));
    workerFiles.push({ file: reviewFile, lines: rl, meta: { agentType: 'general-purpose', description, toolUseId: `toolu_rev${rid}`, spawnDepth: 1, requestShape: 'agent', model: 'claude-sonnet-5-5', ...(rv.finished ? { finished: true } : {}) } });
  }

  for (const writeMerge of merges) writeMerge();
  if (opts.activity?.text) lines.push(assistantOf(parent, [{ type: 'text', text: opts.activity.text }]));

  const base = Date.now() - (live ? 0 : 30 * 60 * 1000) - count * STEP_MS;
  const clock = base + count * STEP_MS;
  const timed = (text) => text.replace(/"@@(\d+)@@"/g, (_, n) => JSON.stringify(new Date(base + Number(n) * STEP_MS).toISOString()));

  writeFile(imagePath, `# Context image: ${topic}\n\nPlan: ${planPath}\n`);
  writeFile(planPath, `# Plan: ${topic}\n`);
  writeFile(boardPath, (opts.board ?? []).map((p) => JSON.stringify(p)).join('\n') + (opts.board?.length ? '\n' : ''));
  for (const c of claimFiles) writeFile(c.file, JSON.stringify(c.task, null, 2) + '\n');
  writeFile(transcript, timed(lines.join('\n') + '\n'));
  for (const wf of workerFiles) {
    writeFile(wf.file, timed(wf.lines.join('\n') + '\n'));
    writeFile(wf.file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify(wf.meta));
  }

  // The session snapshot bin/record-session writes (lib/sessions.js recordSession).
  const lastActiveAt = Math.max(clock, midnight + 1000);
  const snapshot = {
    sessionId,
    lastActiveAt,
    project: path.basename(project),
    model: 'Opus',
    costUsd: 1.5,
    durationMs: 600000,
    apiDurationMs: 300000,
    linesAdded: 0,
    linesRemoved: 0,
    ...(opts.clearedFrom ? { clearedFrom: opts.clearedFrom } : {}),
    ...(live ? {} : { endedAt: lastActiveAt + 1000, endReason: 'clear' }),
  };
  writeFile(path.join(configDir, 'cc-dashboard', 'sessions', `${sessionId}.json`), JSON.stringify(snapshot));
  const mtime = new Date(live ? Date.now() : lastActiveAt);
  if (opts.activity) {
    const at = Date.now();
    writeFile(path.join(configDir, 'cc-dashboard', 'activity', `${sessionId}.json`), JSON.stringify({ sessionId, state: opts.activity.state, since: at, updatedAt: at }));
  }
  if (opts.pendingSteer) {
    const i = workers.findIndex((w, k) => (w.task ?? k + 1) === opts.pendingSteer.task);
    if (i === -1) throw new Error(`pendingSteer: no worker for task ${opts.pendingSteer.task}`);
    const id = crypto.randomUUID();
    const request = { id, agentId: workerIds[i], task: opts.pendingSteer.task, title: workers[i].title ?? null, text: opts.pendingSteer.text, at: Date.now() + 10 * 60 * 1000 };
    writeFile(path.join(configDir, 'cc-dashboard', 'steer', sessionId, `${id}.json`), JSON.stringify(request));
  }
  fs.utimesSync(transcript, mtime, mtime);
  for (const wf of workerFiles) fs.utimesSync(wf.file, mtime, mtime);

  return { sessionId, transcript, imagePath, boardPath, workerIds, reviewerIds, runDir };
}

// A demo for browser checks, three orchestrations:
//   parse-field   live, mid-wave, one wave. Task 1 merged after two review rounds, Task 2 stuck on a
//                 DRIFT event with a pending steer, Task 3 working. It has a board.
//   cache-banner  ended, in another project.
//   situational-variables-dialog  live and waiting on a question.
function writeDemo(configDir) {
  writeFile(path.join(configDir, 'skills', 'orchestrate', 'SKILL.md'), '# orchestrate\n');
  const base = '2026-11-10T09:';
  const first = writeOrchestration(configDir, {
    topic: 'parse-field',
    sessionId: 'demo-live-1',
    live: true,
    claims: true,
    workers: [
      { task: 1, title: 'Parse the field', files: ['lib/parse.js', 'test/parse.test.js'], finished: true, lateReport: true, merged: true, steps: [{ tool: 'Read', file_path: 'lib/parse.js' }, { tool: 'Edit', file_path: 'lib/parse.js' }, { tool: 'Bash', command: 'node --test test/parse.test.js' }] },
      { task: 2, title: 'Render the field', files: ['public/panels/field.mjs'], steer: 'Use formatField from public/format.mjs.', tokens: 130000, steps: [{ tool: 'Read', file_path: 'public/format.mjs' }, { tool: 'Edit', file_path: 'public/panels/field.mjs' }, { tool: 'Edit', file_path: 'lib/unrelated.js' }] },
      { task: 3, title: 'Document the field', files: ['README.md'], steps: [] },
    ],
    reviewers: [
      { task: 1, finished: true, report: 'CHANGES: parse.js drops the sign of negative fields.' },
      { task: 1, finished: true, report: 'PASS: no findings.' },
    ],
    pendingSteer: { task: 2, text: 'Leave lib/unrelated.js alone and finish public/panels/field.mjs.' },
    board: [
      { t: `${base}01:00.000Z`, from: 'Task 1', title: 'Field is a string', body: 'The API returns the field as a string, not a number.' },
      { t: `${base}04:00.000Z`, from: 'Task 2', title: 'Using formatField', body: 'Rendering with formatField from public/format.mjs.' },
    ],
  });
  const second = writeOrchestration(configDir, {
    topic: 'cache-banner',
    project: path.join(configDir, 'work', 'other-app'),
    sessionId: 'demo-ended-1',
    live: false,
    workers: [{ task: 1, title: 'Show the banner', files: ['public/banner.mjs'], finished: true, merged: true, steps: [{ tool: 'Edit', file_path: 'public/banner.mjs' }] }],
    board: [{ t: `${base}00:30.000Z`, from: 'Task 1', title: 'Banner done', body: '' }],
  });
  const third = writeOrchestration(configDir, {
    topic: 'situational-variables-dialog',
    project: path.join(configDir, 'work', 'f-forge'),
    sessionId: 'demo-waiting-1',
    live: true,
    workers: [{ task: 1, title: 'Build the dialog', files: ['public/dialog.mjs'], finished: true, merged: true, steps: [{ tool: 'Edit', file_path: 'public/dialog.mjs' }] }, { task: 2, title: 'Run Stage 1', files: ['lib/stage1.js'], steps: [{ tool: 'Read', file_path: 'lib/stage1.js' }] }],
    activity: { state: 'waiting', text: 'Task 2 needs the corpus path before Stage 1 can run. Should it use data/corpus or the indexed copy in .qmd/?' },
  });
  return [first, second, third];
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    process.stderr.write('usage: node test/orchestration-fixture.js <configDir>\n');
    process.exit(2);
  }
  for (const o of writeDemo(dir)) process.stdout.write(`${o.sessionId} ${o.transcript}\n`);
}

module.exports = { writeOrchestration, writeDemo };
