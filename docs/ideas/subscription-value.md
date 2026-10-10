# Plan value

Compare the API-price cost of the usage with what the subscription costs, per month.
Recorded on 2026-10-10.

## Why

Every cost on the page is what the calls would cost at API prices. A user on a Pro or
Max plan pays a flat fee, so the dollar figures do not say what they paid. The ratio
of API-price cost to the plan fee answers whether the plan is worth its price, and
whether a cheaper or more expensive plan fits the usage.

## What exists

- Daily cost at API prices for any range, from `lib/pricing.js`.
- The Plan usage panel knows the user has a subscription login, because rate limits
  are only reported for one. It does not know which plan.

## How other tools do it

Found in the second round on 2026-10-10. ClaudeCodeAnalytics compares the charge with
the API-price cost per billing cycle, and estimates the same week on Pro, Max 5x and
Max 20x. It reads the billing date from a value Claude Code caches. That source was
not checked.

## Open questions

- Where the plan and its price come from. Claude Code may keep the subscription type
  in `.claude.json`. Otherwise a setting in the dashboard.
- Billing months start on the subscription date, not on the 1st.
- How weekly limit use relates: a month at 40% of the weekly limit and 10 times the
  plan fee in API prices says more than either number alone.
