# Dimension: worker stumbles

Question: what did workers do twice, get wrong, or read that the image should have given them?

Use `REPORT` rows to pick the workers with the highest attempts, the most `Watch` events or
the longest runtime. For each, read `TI <transcript> --steps 40` and the line ranges it
names.

Look for:
- The same file read, the same command run, or the same edit made more than once.
- Failed commands and what the worker did next (STUCK events, the same error three times).
- Files read outside the image (the `Read outside image` list in `REPORT`) and whether the
  image's "Read before starting" or "Orientation" should have listed them.
- A worker that edited outside its task's `files` (DRIFT events).
- A worker that took a second task or ignored the claimed task's `doneWhen`.

Cite the transcript line range of each stumble.
