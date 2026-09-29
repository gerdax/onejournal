# onejournal cloud state API

The browser creates `window.OneRingStore` only after successful authentication.
`state.js` exposes `window.OneRingState.createStore` as the synchronous in-memory
normalization engine; it never opens browser localStorage. The legacy contract
below documents this engine. The cloud application uses the async facade in
`cloud-store.js` and provider transport in `supabase-adapter.js`.

`getState()`, `getParticipants()` and `subscribe(fn)` remain synchronous detached
reads/notifications. All mutations return Promises and resolve only after server
confirmation; methods that used to return records retain their result values.
`saveHero(data, heroVersion?)` carries the draft version, defaulting to the current
snapshot version. A stale version rejects with HTTP 409 and refreshes server data;
the editor retains its draft until the user explicitly retries.

Additional properties: `access: {role: 'gm'|'player', heroId}`, `connection`,
`canWrite`, `heroVersions`, `selection`, `catalog` (GM only), and `rolls`.
Additional methods: `connect(secret?)`, `refresh()`, `markOffline()`, `stop()`,
`selectToken(id)`, `listLinks()`, `rotateLink(heroId)`, `revokeLink(heroId)`,
`publishRoll({id,heroId,config,raw})`. Offline mutations reject without sending.

Player snapshots have empty library/battle arrays and only the assigned hero.
`getParticipants()` is independent of those arrays: public token fields for
others, full details for the player's own participating hero. No private enemy
fields or other hero sheets are sent. Selection follows the GM for every role.
Public rolls are readable by all active members; enemy rolls only by GM.

Cloud `exportBackup()` resolves to `{format:'onejournal',version:1,state,rolls}`;
`state` is a version-2 legacy backup. `restoreBackup()` accepts this wrapper or a
legacy version-2 backup. A wrapper replaces the journal; a legacy import retains
it. Access links and authentication are not part of a gameplay backup.

## Legacy in-memory normalization engine

The legacy synchronous engine is available in Node using
`const { createStore } = require('./state.js')`. `createStore(storage)` accepts a
localStorage-compatible object and is useful for tests.

`getState()` and `exportBackup()` return plain, detached objects with version 2:
`{ version, library, battle, heroes, heroParticipants, map }`. `subscribe(fn)`
receives a new snapshot after each mutating operation and returns an unsubscribe
function. The persistent key is `one-ring-state`; legacy battle/library keys are
read once as a migration source and never removed. If an existing state payload
is malformed, `loadError` explains the startup problem and normal mutations are
blocked; call `restoreBackup(validBackup)` to explicitly recover it.

Battle and library methods are `addEnemy`, `removeParticipant`, `clearBattle`,
`clearEncounter`, `toggleDefeated`, `setEnemyWound`, `adjustResource`, `reorderEnemies`, `addLibrary`,
`removeLibrary`, and `importLibrary`. Enemy battle entries retain the legacy
fields (`endurance`, `maxEndurance`, `hate`, `maxHate`, `defeated`, and combat
metadata). `importLibrary(data)` accepts an array or `{library}` and returns the
number added.

Heroes are saved with `saveHero(data)` (which returns the saved hero), removed
with `deleteHero(id)`, and put into battle using `addHero(id)`. `getParticipants()`
combines battle enemies and hero participants. Hero participant IDs are
`hero:<heroId>`; records have `type: 'hero'` or `type: 'enemy'`.

`saveHero` accepts a partial update when `id` names an existing hero. Omitted
fields retain their values. Hero records retain the original `weapons`,
`proficiencies`, `conditions`, and `notes` text fields alongside the full sheet.
The added string fields are `age`, `treasure`, `calling`, `culturalBlessing`,
`distinctiveFeatures`, `flaws`, `patron`, `shadowPath`, `injury`, `rewards`,
`virtues`, `equipment`, `standardOfLiving`, `armourName`, `helmName`, and
`shieldName`. Added nonnegative numeric fields are `shadowScars`, `valour`,
`wisdom`, `adventurePoints`, `skillPoints`, `fellowship`, `helmProtection`,
`armourLoad`, `helmLoad`, `shieldParry`, and `shieldLoad`. `weary`, `miserable`,
and `wounded` are booleans.

The skill fields are `skillAwareness`, `skillSong`, `skillHunting`, `skillAwe`,
`skillCraft`, `skillAthletics`, `skillInsight`, `skillCourtesy`, `skillHealing`,
`skillEnhearten`, `skillBattle`, `skillTravel`, `skillScan`, `skillRiddle`,
`skillExplore`, `skillPersuade`, `skillLore`, and `skillStealth`. Each has a
matching boolean field ending in `Favoured`, such as `skillAwarenessFavoured`.
Combat ratings are `combatBows`, `combatSwords`, `combatAxes`, and
`combatSpears`. Skills and combat ratings are integer values clamped to 0–6.
Four weapon rows use flat string fields `weapon0Name`, `weapon0Damage`,
`weapon0Injury`, `weapon0Load`, `weapon0Notes`, continuing through `weapon3Notes`.
Missing sheet fields in old version-2 records and backups default to empty
strings, zero, or false; the backup version remains 2.

`setMap(map)` sets a map and resets token staging. `moveToken(id, x, y)` clamps
map-pixel coordinates to a 32px inset within its bounds. New participants use
separate staging areas, while existing positions remain unchanged. Scenes are
`forest`, `clearing`, `ruins`, `cave`; sizes are `small`, `medium`, `large`. `restoreBackup(data)` validates the entire version-2
backup before replacing state, and throws when it is invalid.

New small, medium and large maps are square: 900, 1200 and 1600 pixels per side.
Existing maps retain their dimensions until regenerated.

`clearEncounter()` atomically removes battle enemies, hero participants and the map,
while retaining hero sheets and the enemy library. `clearBattle()` retains its
original contract (participants only).

Hero `shadow` is clamped to at least `shadowScars` during normalization, including
save, load and backup restore. Raising scars raises shadow when necessary; lowering
scars does not lower the existing shadow value. The backup version remains 2.

Enemy forms always create a new record with `source` and `category` set to
`Własne`. Library category filters exclude own records, including older records
that retained a template category. Optional enemy `distinctiveFeatures` contains
free-text distinguishing features, preserved through copies and backups; missing
values display as empty. `kind` is free text and is displayed with the source.

Enemy `resourceType` is `hate` or `determination`, independent of free-text `kind`.
Old records default to determination for `Człowiek`, otherwise hate. The numeric
resource remains in `hate`/`maxHate`; the backup version remains 2.

Battle enemies have `wounds`, a boolean array with `clamp(floor(might), 0, 10)`
entries. Existing `might` values remain unchanged when outside that range.
Older battle records without wounds receive unchecked entries on load or restore;
library records never retain `wounds`. `addEnemy` starts with all wounds unchecked,
including when copying a wounded library or battle record. `setEnemyWound(id, index,
checked)` requires an integer index within that enemy's wounds and a boolean value.
Checking the last unchecked wound sets `defeated` to true in the same state update.
Unchecking a wound never revives the enemy. `toggleDefeated` changes only `defeated`,
so a manually revived enemy can retain all checked wounds through reload and backup
restore; checking an already checked wound does not defeat it again.

Explicit `saveHero({id, wounded:false})` clears `injury` atomically. Injury writes
while unwounded are cleared; unrelated saves and loading legacy data preserve
existing injury text. Editors disable and blank the injury field while unwounded.

Map scenes additionally include `forest_clearing`, `forest_crossroads`, `road`,
`river`, `river_ford`, `marsh`, and `ravine`. Optional `map.features` stores connected
paths as `{kind, width, points:[{x,y}, ...]}`: kind is `trail`, `river`, or `ford`;
width is a positive integer no larger than the larger map dimension. There are
at most 64 features, with 2–64 integer points each, within map bounds. Features
are visual terrain only; they impose no movement rules. Legacy maps without
features remain unchanged; backups still use version 2. New generation affects
only explicitly regenerated maps, never existing terrain or token positions.

Enemy records include plain-text `notes` (empty by default for legacy entries). Notes are copied with library templates into encounters and clones, preserved in backups, and included when detecting duplicate library imports. Map notes are read-only snapshots of the added enemy, like its other template fields.

Cloud store: `clearRolls()` atomically deletes all published public and private rolls.
Only GM may call it (server-enforced); the returned snapshot updates the caller,
and a public revision change synchronizes all players. Character and map data stay unchanged.
Unpublished local rolls are not records in the shared journal.

Player rolls with `config.hope` spend one Hope in the same compare-and-swap as
the journal insertion, even outside battle; zero Hope returns 409 without a write.
The hero version increments with the spend. Repeating an existing roll ID does not
spend again. GM generic rolls never change a hero. New `addEnemy`/`addLibrary`
writes accept Might only in 0–5; saved data and backup loading are not clamped.

`rollEpoch` is a non-sensitive journal generation counter included in snapshots
and prepared rolls. Clearing increments it, so retries of cleared rolls cannot
recreate entries or spend Hope again. No cleared roll contents are retained.
