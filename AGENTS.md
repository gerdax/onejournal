# Project

onejournal is a Polish shared One Ring game for one GM and players, forked from
Bestiariusz Śródziemia. Supabase is authoritative; the original app stays separate.

## Stack

Static HTML, CSS and plain JavaScript globals with a service worker. SortableJS
and the 3D dice engine are vendored. Supabase PostgreSQL and an Edge Function
enforce access. GitHub Actions tests and publishes the frontend to Pages.

## Commands

- Development: `python3 -m http.server 8877`, then open `http://localhost:8877`.
- Unit tests: `node --test tests/*.test.js`.
- JavaScript syntax: `node --check <changed-file.js>`.
- Isolated browser tests: `node tests/online.cjs` and `node tests/dice-online.cjs`;
  require Playwright and Chrome. See README for environment overrides.
- Frontend build: `node scripts/build-site.mjs`.
- Backend shared sources: `node scripts/admin-build.mjs` before Edge deployment.

## Project constraints

- Keep the Polish interface and existing static frontend architecture.
- State normalization belongs in `state.js`; asynchronous persistence uses
  `cloud-store.js` and `supabase-adapter.js`. Consult `STATE_API.md`
  before changing the contract used by combat, heroes and map.
- Preserve saved data and legacy migration sources. Verify storage/restore
  changes with isolated test storage, never the user's live browser data.
- Keep service-worker assets and cache version consistent with frontend changes.
- Preserve script dependency order in `index.html` and vendored dependencies.
- `reference/*.pdf` contains private, ignored source material; do not commit it.

## Agent orchestration

- Astra / medium is the default lead: objective, ambiguity, risk, architecture,
  decomposition, ownership, conflict resolution, integration and final acceptance.
- `explorer`: Luna / low for cheap, bounded, read-heavy exploration and mechanics.
- `worker`: Sol / medium for normal implementation; use supplied findings.
- `reviewer`: Sol / high for consequential independent review or difficult bug
  diagnosis. It reports findings without edits; route fixes to an assigned worker.
- For a difficult fix needing Sol / high, use an explicit model/effort spawn
  without the medium worker role: custom agent files override spawn settings.
- Astra / high is exceptional: unresolved architecture/disagreement, repeated
  sensible-strategy failure, subtle cross-system behavior or significant security
  or data-loss uncertainty. Prefer decomposition and verification first, then
  return to medium after resolving that specific issue.

Choose the cheapest reliable model automatically; the user need not manage
routing. The escalation ladder is Luna/low → Sol/medium → Sol/high → Astra/medium
→ Astra/high; skip levels when the task is already clear. Retry failed cheap work
once only with materially improved context or strategy; otherwise escalate the
blocked portion. Task size alone does not justify higher reasoning.

Delegate only when savings, bounded isolation, useful parallelism or independent
verification outweigh coordination. Tiny actions may stay with Astra. Give each
agent an objective, relevant context, constraints, owned files, expected output
and verification criteria. Use narrow briefs and concise evidence; avoid full
history forks, duplicate investigations and repeatedly loading large files.
Parallelize independent work with stable interfaces; generally avoid overlapping
edits. The project caps concurrent subagents at two, excluding the lead.

## Workflow

Understand objective → inspect relevant context → identify ambiguity/risk →
decompose if useful → route bounded work → parallelize where beneficial →
implement → run relevant deterministic checks → independently review consequential
changes → integrate → Astra accepts.

Done means requested behavior and important edge cases are covered, relevant
checks pass, no known regressions remain, and Astra has inspected the integrated
result. Scale checks and review to risk; trivial changes need no review ceremony
or irrelevant full suite. Surface product decisions, material risks and meaningful
ambiguity; handle routine routing internally.
