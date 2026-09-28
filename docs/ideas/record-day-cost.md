# Record day: add the total cost

The Record day card shows the all-time record for tokens in one day, with its date.
Add the record's total cost to the same card.

## Where the numbers come from

Every entry in `data.daily` already has a `cost` field, filled by `lib/scan.js` next
to the token counts. `busiestDay()` in `public/stats.js` sums only tokens per date and
returns `{ date, tokens }`. It would also sum `cost` and return
`{ date, tokens, cost }`.

`busiestDay()` has two callers:

- `/api/records` in `server.js`, for the all-time record.
- `renderRecord()` in `public/app.js`, for the record within the range on screen, and
  for today's total on Today.

`renderRecord()` also builds a record object by hand when today's total beats the
fetched all-time record (`{ date: todayStr, tokens: todayTotal }`). That object
would need today's cost too.

## Open questions

- **Which cost.** Two readings of "record total cost":
  - The cost of the record-token day. One card, one day, two numbers.
  - The most expensive day, which can be a different day from the most tokens.
    Cache reads are about 97% of tokens and are priced low, so the two days can
    differ. This reading would need its own date line, or a second card.
- **Where it goes on the card.** A second value beside the token value, or a note
  line under the date. On Today the card is compact in the sticky header, where only
  the value and the date line show, so a note line would be hidden there.
- **The range note.** "this range: 1.2B · 9/14" could gain the range record's cost
  too, or stay tokens-only.
