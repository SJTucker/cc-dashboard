---
name: orch-grill
description: Grill the owner relentlessly about a plan, decision or idea, building the project's glossary and ADRs as you go, and end with a written spec that orch-plan and orchestrate read. Use when the owner types /orch-grill or asks to grill a design before planning it. A fork of the grill plugin's grilling and domain-modeling skills.
disable-model-invocation: true
---

# orch-grill

Interview the owner relentlessly until you reach a shared understanding. Build the project's domain model while you do, and end by writing a spec that `/orch-plan` turns into a plan for `orchestrate`.

This skill replaces `grill-with-docs` for work the owner plans with `orchestrate`. Every file it names sits beside this `SKILL.md`.

## 1. Start in the plan branch's worktree

Other work can merge into `main` while the session runs. Create the plan branch's worktree first, and read code there.

1. Run `git fetch origin`.
2. Pick the base: the base the project's `CLAUDE.md` names for worktrees, else local `main`. Never pull into or reset local `main`, because another session may be working in the main checkout.
3. Check whether the plan branch exists (a dropped or resumed grill leaves it behind, and `wt switch --create` fails with `Branch ... already exists`):
   - When the branch has a worktree, reuse it, taking the path from `wt list --format json`.
   - When the branch exists with no worktree, run `wt switch <plan branch> --no-cd` without `--create`, then read the path from `wt list --format json`.
   - Otherwise run `wt switch --create <plan branch> --base <base> --no-cd`, then read the worktree path from `wt list --format json`. The plan branch name is the topic slug.

During the session:

- Every code read, every command and every Explore prompt names the worktree path. An Explore subagent searches the main checkout unless its prompt says otherwise.
- Run commands in the worktree as `(cd <worktree> && …)` or `git -C <worktree> …`, and stay in the launch folder. Claude Code keeps a bare `cd` that ends inside the project, and `.worktrees/` is inside it. Never run a bare `cd <worktree> && …`.
- The spec goes in the main checkout's `docs/superpowers/specs/`, because that folder is git-ignored and a worktree's ignored files are deleted with the worktree.
- If the owner drops the plan, the worktree stays. Say so, and name `wt remove <plan branch>`.

## 2. The design tree

Map the topic as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Each round holds the frontier's questions, numbered, each with your recommended answer. Then wait for the owner's answers before the next round.

Word each question so "yes" accepts your recommended answer.

Each round the owner answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and run the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round.

Finding _facts_ is your job, never the owner's. When a frontier question needs a fact from the environment (the code, the tools, the filesystem), dispatch an Explore subagent to find it. State its depth in the prompt (`quick`, `medium` or `very thorough`). Explore runs on Haiku. Pass `model: "sonnet"` only after a Haiku run on the same question came back incomplete or wrong. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait. The _decisions_ are the owner's.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the owner confirms you have reached a shared understanding.

## 3. Investigate before asking

The owner finds grilling worth it, and finds "too many rounds and questions that seem like they could have been answered from claude thinking more for itself or answered from the code". Two rules keep the rounds short.

### The uncertainty rule

When you are unsure or confused about anything during the session (how a function behaves, two parts of the code that seem to disagree, a step you cannot picture), treat that as a reason to investigate before you ask:

1. Name what is unclear as one specific question.
2. Reason it through from what you already know. If that does not settle it, read the code in the worktree or send an Explore subagent with the question and a stated depth.
3. If the investigation settles it, the answer goes in the next round as a found fact with file and line. If you are still unsure, it becomes a question to the owner that says what you checked and what is still open.

### The three piles

Before each round, put every frontier question in one pile:

1. **The code answers it.** Investigate and report it as a found fact, with file and line.
2. **Claude can make the call.** A sensible default exists, or a wrong answer is cheap to change later. Also any question whose recommended answer the owner would almost certainly accept. These go in the round as "my calls": one line each, with the reason.
3. **Only the owner knows.** The answer changes what gets built, and investigation did not settle it. Only these become questions.

A round with no questions in pile 3 still goes out if it has calls. The frontier is empty when pile 3 is empty, no calls remain, no investigation is still running, and recomputing the frontier adds nothing.

## 4. Ask each round

When the `Artifact` tool is available, ask each round on a page instead of in chat. The owner answers there by clicking, and the page sends the answers back. Use the chat format only when the tool is missing or the owner asks for chat.

In chat, format a round like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

🔧 **C1** - **<the call>**: <one-line reason>
```

### The round page

`round.html` beside this file is the finished page. Publish it as it is: change only its `<title>` and the JSON in its `grill-data` block, and don't restyle it.

1. **First round.** Copy `round.html` to `grill-<topic-slug>.html` in your scratchpad. Set `<title>` to `Grill · <topic>`. Fill `grill-data`. Publish with `capabilities: {"comments": {}}` and `icon: "question"`. In chat, give the link and one line per question title, then end your turn.
2. **Answers arrive.** Submit round sends a comment to Claude, and this session wakes with an `artifact-auto-react` task notification naming a thread. Read that thread with `ArtifactComments` `read`. An automatic reply may already be in the thread; ignore it. The owner may answer in the terminal instead, and those answers count the same.
3. **Next round.** Edit the same file and publish it to the same path, which keeps the URL. Leave out `capabilities` and `icon`. Then resolve the thread.
4. **Done.** When the frontier is empty, publish with `"questions": []` and `"calls": []`, and ask in chat whether you have reached a shared understanding.

Inside `grill-data`, write every `<` as the JSON escape `\u003c` (`JSON.parse` turns it back into `<`), so a string containing `</script>` cannot end the block.

`grill-data` holds:

```json
{
  "topic": "Round page for the grilling skill",
  "round": 2,
  "questions": [
    {
      "id": "Q1",
      "title": "Where should the round page come from?",
      "body": "Plain text. Blank lines separate paragraphs.",
      "options": ["A template filled each round", "A new page each round"],
      "recommended": 0,
      "recommendation": "A template filled each round",
      "why": "Every round looks the same."
    }
  ],
  "calls": [
    { "id": "C1", "call": "Keep the file name as it is", "why": "Renaming it changes nothing the plan builds." }
  ],
  "history": [
    { "round": 1, "items": [{ "id": "Q1", "title": "How should answers reach Claude?", "answer": "A comment sent to Claude" }] }
  ]
}
```

- `options` may be empty for an open question. `recommended` is the index of the recommended option, or `null`.
- `recommendation` is always set. It is the answer the owner gets by pressing Accept.
- Number `id` from Q1 each round, and calls from C1. Move every settled question into `history`, with its answer written out in full.
- `calls` holds pile 2. Each item is `{ "id": "C1", "call": "<the decision>", "why": "<one line>" }`. Leave the key out, or leave it empty, when the round has no calls.

The page shows calls in their own section. That section has an "Accept all calls" control and an overrule field for each call. The header's "Accept all unanswered" button does not touch calls.

The comment holds one line per question: `Q1 accept`, `Q2 other: <option text>`, `Q3 own: <text>` or `Q4 unanswered`. Ask an unanswered question again next round.

It adds one line per overruled call: `C1 overrule: <text>`. A call with no line is accepted.

Move calls into `history` when the round is settled:

- An accepted call becomes `{ "id": "C1", "title": "<the call>", "answer": "<why>", "by": "claude" }`. The page shows it as Claude's call.
- An overruled call becomes `{ "id": "C1", "title": "<the call>", "answer": "<the owner's overrule text>" }`, with no `by`.

When an answer matches no line format, read it as the owner's own words about that question or call. If its meaning is unclear, ask again next round.

## 5. Build the domain model as you go

Actively build and sharpen the project's domain model. Challenge terms, invent edge-case scenarios, and write the glossary and decisions down the moment they crystallise. Do this in the plan branch's worktree.

### File structure

Most repos have a single context:

```
/
├── GLOSSARY.md
├── docs/
│   └── adr/
│       ├── 0001-event-sourced-orders.md
│       └── 0002-postgres-for-write-model.md
└── src/
```

If a `GLOSSARY-MAP.md` exists at the root, the repo has multiple contexts. The map points to where each one lives:

```
/
├── GLOSSARY-MAP.md
├── docs/
│   └── adr/                          ← system-wide decisions
├── src/
│   ├── ordering/
│   │   ├── GLOSSARY.md
│   │   └── docs/adr/                 ← context-specific decisions
│   └── billing/
│       ├── GLOSSARY.md
│       └── docs/adr/
```

Create files lazily: only when you have something to write. If no `GLOSSARY.md` exists, create one when the first term is resolved. If no `docs/adr/` exists, create it when the first ADR is needed.

### Challenge against the glossary

When the owner uses a term that conflicts with the existing language in `GLOSSARY.md`, call it out immediately. "Your glossary defines 'cancellation' as X, but you seem to mean Y. Which is it?"

### Sharpen fuzzy language

When the owner uses vague or overloaded terms, propose a precise canonical term. "You're saying 'account': do you mean the Customer or the User? Those are different things."

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the owner to be precise about the boundaries between concepts. Keep a list of every edge case and scenario the session raises, with the behaviour the owner chose or the call you made. The spec needs it.

### Cross-reference with code

When the owner states how something works, check whether the code agrees. If you find a contradiction, surface it: "Your code cancels entire Orders, but you just said partial cancellation is possible. Which is right?"

### Update GLOSSARY.md inline

When a term is resolved, update `GLOSSARY.md` right there. Don't batch these up. Use the format in `GLOSSARY-FORMAT.md`.

`GLOSSARY.md` holds no implementation details. It is a glossary, not a spec, a scratch pad or a place for implementation decisions.

### Offer ADRs sparingly

Only offer to create an ADR when all three are true:

1. **Hard to reverse**: the cost of changing your mind later is meaningful.
2. **Surprising without context**: a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off**: there were genuine alternatives and you picked one for specific reasons.

If any of the three is missing, skip the ADR. Use the format in `ADR-FORMAT.md`.

## 6. Write the spec

When the frontier is empty and the owner confirms a shared understanding, write `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` in the main checkout. Leave it untracked.

Cover the points brainstorming's written design covers: intent, goals, non-goals, anti-goals, constraints, approaches, the decided parts of the how, and what is left to the builder. Add these sections:

- `## Decisions`: each decision with the owner's answer quoted verbatim and its round number. List Claude's accepted calls separately, marked as Claude's.
- `## Edge cases`: every edge case and scenario the session raised, each with the behaviour the owner chose or the call Claude made.
- `## Glossary and ADRs`: the path of `GLOSSARY.md` and of each ADR the session created or changed. Write "None." when there are none.

Put this line near the top of the spec, where `/orch-plan` reads it:

``**Plan branch:** `<branch>`, worktree `<absolute path>` ``

`/orch-plan` reads that exact format, so write it the same way every time.

### Commit the glossary and ADRs

When the session created or changed `GLOSSARY.md` or an ADR, commit them on the plan branch, so every worker worktree branched from it has them and the main checkout's git status does not change:

```bash
git -C <worktree> add <each file the session wrote or changed>
git -C <worktree> commit -m "docs: record the <topic> glossary terms and decisions"
```

Run `git add` on only the files the session wrote or changed, including the files of any `GLOSSARY-MAP.md` context, then `git commit` with a plain message. The commit message carries no attribution trailer: no `Co-Authored-By` line and no other trailer, even if your own instructions ask for one. Skip the commit when the session created or changed neither.

### Last message

The spec's last line tells the owner the next step: `/orch-plan <spec path>`. The owner starts it. Do not start `/orch-plan`, `/plan-review` or `orchestrate` yourself. Your last message gives the spec path, repeats that line, and says that dropping the plan means `wt remove <plan branch>`.
