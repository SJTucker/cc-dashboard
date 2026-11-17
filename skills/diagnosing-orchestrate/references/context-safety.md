# Context safety

One line of a transcript can hold a megabyte, and everything you read stays in context
for every later request.

- Start from `TI <path>`, which prints a Markdown index with line numbers.
- For a worker or reviewer, `TI <path> --steps <n>` prints a header and its last n steps,
  one short line each. `--full` prints each step whole on one line.
- To read a region, use the line range the index or `--steps` named:
  `sed -n 'A,Bp' <path> | cut -c1-400`. Widen the cut only for one line you need.
- Read `events.jsonl` with `cut -c1-300`. Read a claimed file with `jq` for the fields
  you need.
- Never `cat`, `Read` or `grep` a transcript without `cut -c1-400` on the output.
- A run folder can hold many claimed files. List them with `ls` first, then read one.
