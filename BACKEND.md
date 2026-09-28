# Onejournal backend

This clone runs the existing state and dice rules on a Supabase Edge Function. The browser needs only the Supabase URL and publishable/anon key. Never put the service role key or encryption key in a browser file.

## Setup

1. Create a Supabase project and enable anonymous sign-ins in Auth.
2. Apply `supabase/migrations/202609280001_onejournal.sql` with the Supabase CLI or SQL editor. Keep the `onejournal_private` schema out of the exposed API schemas.
3. Generate an encryption key with `openssl rand -base64 32`. Set `ONEJOURNAL_ENCRYPTION_KEY` and `ONEJOURNAL_ALLOWED_ORIGINS` (comma-separated exact origins) as Edge Function secrets. The Edge runtime also needs `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`.
4. Run `node scripts/admin-build.mjs` to copy the shared rules into the function directory, then deploy `supabase/functions/onejournal` as an Edge Function. Its URL is `/functions/v1/onejournal`. Rerun the build script after changing `state.js`, `dice-rules.js`, or `server-core.js`.
5. From a trusted terminal, set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and the same `ONEJOURNAL_ENCRYPTION_KEY`; run `node scripts/admin-bootstrap.mjs`. If only the SQL editor is available, set the encryption key and run `node scripts/admin-bootstrap.mjs --sql`, then execute its generated SQL in the project SQL editor. Save the printed GM invitation secret. Running either mode again rotates the GM link and revokes earlier GM grants.

The browser signs in anonymously with Supabase Auth, then posts `{ "action": "exchange", "secret": "..." }` to the function with its bearer JWT. The secret is bound to that Auth user. Every later request rechecks the active grant and link version. A GM creates or rotates player links by hero ID with `rotateLink`, lists links with `links`, and disables them with `revokeLink`.

## Protocol

All calls use `POST`, JSON, and `Authorization: Bearer <user access token>`. Error responses are `{ "error": "..." }`; stale hero sheets and roll-ID conflicts return HTTP 409. `snapshot` returns `{state,participants,access,revision,heroVersions,selection,rolls}`. GM snapshots also include `catalog` and full participant records. Player snapshots contain only their hero in `state.heroes`, empty library and battle arrays, public map geometry and positions, and their own full hero participant. Other participants have only `id`, `type`, `heroId`, `name`, `defeated`. The public defeated flag controls gray tokens and carries no private resource values. The player's `revision` is the public revision; enemy rolls and access administration do not advance it.

`command` accepts `{action:"command",method,args,heroVersion?}` and returns the snapshot plus `result`. All store mutation methods in `STATE_API.md` are supported, as is `selectToken(id)`. Only the GM can use general mutations. Players can call `saveHero` for their assigned existing hero with its current `heroVersion`. The version changes when a hero sheet or hero resource changes; a stale save returns 409 so the client can retain its draft. Resource deltas use `adjustResource` under database compare-and-swap retries. `restoreBackup` accepts a version-2 state backup or the Onejournal export wrapper.

`roll` accepts `{action:"roll",id,heroId,config,raw}`. `id` is a client-generated unique ID. Repeating the same ID with the same actor and payload returns the original snapshot without a duplicate; using it differently returns 409. Dice interpretation runs on the server. Players roll only as their assigned named hero. The GM rolls as a generic `hero` (public), `npc` (private, using hero dice mechanics), or `enemy` (private), without selecting a hero. New GM entries have `heroId: null`; old-client GM requests containing a hero ID are accepted and retain that request ID in the idempotency payload. Historic named entries remain readable after backup restore. Private NPC and enemy rolls are excluded from player snapshots and public realtime updates. The journal retains up to 10,000 rolls; when full, further rolls return 409 without discarding earlier history.

`export` returns `{format:"onejournal",version:1,state,rolls}` to a GM. `clearEncounter` leaves the journal intact. A restore is atomic with the state change and invalidates player grants for heroes absent from the restored state.

Realtime uses `public.onejournal_updates`, one row (`id=1`) with a `revision` counter. RLS allows only active linked Auth users to read it. Subscribe to Postgres changes for this table, then request a fresh snapshot. The row contains no game payload; enemy-only rolls and link administration do not update it. The canonical state, journal, links and grants live in private tables. Only the service role can call the transaction RPC functions. The Edge Function checks origins, verifies Auth sessions with Supabase Auth, validates command inputs, and uses a 1 MiB request limit.

## Local verification

Run `node --test tests/server-core.test.js` and `node --check server-core.js`. The Edge Function and migration require a configured Supabase project for integration testing; this repository does not include a local Supabase runtime.
