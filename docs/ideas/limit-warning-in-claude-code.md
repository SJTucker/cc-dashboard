# Plan limit warning inside Claude Code

Have the mod warn in Claude Code itself when a plan window or the day budget passes
the warning level, so the warning reaches the user without the dashboard open.
Recorded on 2026-10-10.

## What exists

- `drawLimitsBanner` in `public/panels/limits.mjs` shows "Nearing your plan limit"
  at `LIMIT_WARN_PERCENT` (75%), and "Nearing today's budget" at 19% of the week.
  Both show only on the page.
- The mod already runs `bin/record-statusline` after each main turn and whenever a
  rate-limit window moves 1 point (`mod/hooks/register.ts`), so it sees each new
  reading.
- Mods can show a toast and a band above the prompt.

## Decided on 2026-10-10

- The warning must be dismissable in Claude Code.

## How other tools do it

Found in the second round on 2026-10-10. CCSeva notifies at 70% and 90%, only when the
status gets worse, with a cooldown between notifications. Claude-Code-Usage-Monitor
exits with code 10 near the limit and 11 at the limit, so a script can act on it.

## Open questions

- Toast or band. A toast is easy to miss. A band stays until it is dismissed.
- What a dismissal covers: this threshold in this window, or every warning until
  the window resets. Whether dismissing it in one session hides it in the others.
- How often it repeats: once per window per threshold, or at each further 5 points.
- Whether the day budget warning belongs in Claude Code at all, given it is a
  personal pacing rule and not a hard limit.
- Where the "already warned" state lives, so several running sessions do not each
  show the same toast.
