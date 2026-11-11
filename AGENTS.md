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

- Sol 6.1 / medium is the default lead: objective, ambiguity, risk, architecture,
  decomposition, ownership, conflict resolution, integration and final acceptance.
- `explorer`: Luna / low for cheap, bounded, read-only exploration, reference lookup
  and mechanical investigation.
- `simple_worker`: Luna / low for small, mechanical, clearly specified edits with
  explicit ownership and straightforward verification. The Sol 6.1 lead inspects
  its changes and verification before accepting them.
- `worker`: Sol 6.1 / medium for normal implementation; use supplied findings and
  avoid rediscovering context already established by the lead or explorer.
- `reviewer`: Sol 6.1 / high for consequential independent review or difficult bug
  diagnosis. It reports findings without edits; route fixes to an assigned worker
  or the lead.
- For difficult implementation needing Sol 6.1 / high, use an explicit
  `gpt-6.1-sol` / `high` spawn rather than the fixed medium worker role. Custom
  agent files may override spawn settings; do not rely on conflicting overrides.
- `expert`: Astra / medium for exceptionally difficult, isolated architecture or
  diagnosis: unresolved architectural choices, conflicting evidence, subtle
  cross-system behavior, repeated failure of sensible Sol approaches, or major
  security/data-loss uncertainty. It is read-only; Sol 6.1 retains integration
  and final acceptance.
- Astra / high is exceptional. Use an explicit `gpt-6-astra` / `high` spawn only
  when Astra / medium remains insufficient. Prefer decomposition, targeted
  evidence and verification first, then return control to Sol 6.1 after resolving
  that specific issue.

Choose the cheapest reliable model automatically. Default escalation is
Luna / low → Sol 6.1 / medium → Sol 6.1 / high → Astra / medium → Astra / high.
Task size alone does not justify escalation.

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
