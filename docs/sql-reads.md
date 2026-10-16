# SQL reads (batched bead reads over the Dolt mysql protocol)

## Why

Bead reads used to spawn one `bd` subprocess per item or per store: a default
all-stores `retrieval_*` sweep was 55 spawns, a 47-bead `retrieval_snapshot`
hundreds, and several paths used blocking `spawnSync`, freezing the single bun
event loop (a concurrent `whoami` waited >1 s behind `bead_connections`).
Every store lives in one shared Dolt database (`brain_unified`, 127.0.0.1:3307
on the brain host), so a sweep is one SELECT. Writes are untouched: they stay
in `src/lib/mutate.ts` (bd, shell-free argv, verified receipts).

## Pieces

| File | Role |
|---|---|
| `src/lib/sql.ts` | The one read-only SQL door (`Bun.SQL`, mysql protocol). `assertReadOnlySql` accepts exactly one `SELECT`/`WITH…SELECT` and rejects DML/DDL/`SET`/`CALL`, `dolt_*()` functions, `INTO OUTFILE`, `FOR UPDATE`, comments, side-effecting functions, multi-statement. `withSqlFallback` = SQL, else logged bd fallback. |
| `src/lib/sql-beads.ts` | bd read semantics ported to SQL: namespace scoping, `bd list` filters/defaults/sort, `bd search` + relevance ranking, `show --json` rows, comment counts, dep edges, children. |
| `src/lib/graph-sql.ts` | One batched BFS level load (meta, down, up, children, rendered text) for `retrieval_snapshot` / `bead_connections`. |
| `src/lib/bead-text.ts` | Rendered `bd show`/`bd comments` text for many beads with few processes (see "Hybrid text"). |
| `src/lib/spawn-stats.ts` | Counts bd spawns (total/blocking) so the benchmark table is measured, not estimated. |
| `ops/sql-parity/` | Live read-only parity + benchmark scripts (see "Evidence"). |

Ported tools: `beads_bundle`, `retrieval_search`, `retrieval_activity`,
`retrieval_claimed`, `retrieval_snapshot`, `bead_connections`, `query_store`,
`GET /q/:store`, `random`, relay project/task lookups, resume scope-label
discovery. The query path no longer uses `spawnSync` for bead reads
(`runList` is gone; `runListQuery` is SQL with a bd fallback, `runListAsync` is
the pure bd path).

## Configuration (env only; no secrets in code)

| Var | Default |
|---|---|
| `BEADS_BRIDGE_SQL` | on. `off`/`0`/`false`/`no` forces the old bd path everywhere |
| `BEADS_BRIDGE_SQL_HOST` / `_PORT` | `127.0.0.1` / `3307` |
| `BEADS_BRIDGE_SQL_USER` / `_PASSWORD` | `root` / empty |
| `BEADS_BRIDGE_SQL_DATABASE` | `brain_unified` |
| `BEADS_BRIDGE_SQL_TIMEOUT_MS` | `10000` per statement |
| `BEADS_BRIDGE_SQL_POOL` | `4` connections |

The bridge must run where the Dolt server is reachable (the brain host, or a
tunnel: `ssh -L 13307:127.0.0.1:3307 <host>` + `BEADS_BRIDGE_SQL_PORT=13307`).
Where it is not reachable the first call fails, logs, and every later call uses
bd directly during a 15 s cool-down (no per-call connect timeout).

## Fallback (automatic and logged)

`withSqlFallback(label, viaSql, viaBd)`: any SQL failure — connection refused,
timeout, SQL the port declines (`SqlUnsupported`) — logs
`[sql-fallback] <label>: <reason> — using bd subprocess path`, increments
`sqlStats.fallbacks`, and runs the old path. The bd path is the behavioural
source of truth, so SQL can change a tool's speed, never its answer. Declined
on purpose (-> bd): custom statuses/`types.infra` configured, `--status` outside
the built-in set, `since` in anything but RFC3339 UTC, a search matching more
than 1500 rows in one store (relevance ranking needs them all).

`walkGraph` swallows per-node `fetch` errors by design, so the SQL snapshot
loads each BFS level in its `prefetch` hook, whose errors propagate and trigger
the fallback; `fetch` then answers from that cache only.

## Hybrid text (why `bd show` is still spawned)

`bd show`/`bd comments` render markdown through glamour; SQL rows cannot
reproduce that byte-for-byte. Output stays byte-identical by keeping bd as the
renderer but removing the per-bead overhead: `bd show a b c…` renders up to 20
beads in one process (parts re-aligned by header id, else re-read one by one),
and one SQL statement gives every comment count so zero-comment beads skip
`bd comments` (constant `No comments on <id>`). Follow-up: render in SQL/TS.

## Deviations (deliberate, small)

1. **No CLI identity probe on the SQL path.** The store guard
   (`store-health.ts`, `<store> where`) protects against a wrapper resolving to
   a stale/wrong *copy*. SQL reads the authoritative server directly, so there
   is no copy to be wrong; the probe still guards every bd read/write.
2. **Edge order is Dolt's plan order, not a sort.** bd lists a bead's dependencies
   in the order Dolt returns `SELECT ... FROM dependencies WHERE issue_id = ?`
   (no ORDER BY, so index/plan order: not by id, created_at or target; checked
   against 240 live `bd dep list` calls). `IN (a, b, ...)`, UNION parts or a wider
   projection plan differently and reorder a bead's own edges, so
   `sqlDepEdges(..., 'down')` issues one narrow `SELECT id, <target> ... WHERE
   issue_id = ?` per bead (16 at a time) and fetches the types by row id. Up
   edges (`WHERE depends_on_... IN (...)`) already matched. Other ties (Go
   unstable sort) still break by input order then id.
   **Partial ids.** bd's `show`, `comments` and `dep list` resolve a truncated id
   (`ResolvePartialID`): the hash part is matched as a literal, case-sensitive
   substring of the store's ids (issues and wisps), an exact hash wins, one
   match resolves, several (ambiguous) or none is an error. A mention in bead
   text is often truncated by line wrapping, so the snapshot walk, the
   snapshot root and `bead_connections` resolve them (`resolvePartialId` pure
   port, `sqlResolvePartialIds` for the lookup) and skip ambiguous/unmatched
   ones, as bd does when `show` fails. `list --parent` does not resolve, so
   children are looked up by the literal id. The resolved bead keeps the
   mention as its walk key, which reproduces bd listing it at depth 1 and again
   at depth 2 (its label peers include the real id).
3. **Dolt dialect.** A lone parenthesised `(SELECT … LIMIT n)` is a syntax error
   (`unionAll` drops the parentheses for one part), and `UNION ALL … WHERE id IN
   (…)` plans as a full scan (1.4 s vs 2 ms), so issues/wisps lookups are
   parallel statements.
4. **Not ported (still bd, batched where possible):** `bd history`
   (`retrieval_activity` history lines), `attachClaimedDetail`, the text
   routes `GET /:store`, `GET /:id`, `/next`, `/action/next` (`bd()` execSync in
   `util.ts`) — tracked as follow-ups.

## Tests

- Unit (fixtures, no DB): `src/lib/sql.test.ts` (read-only guard rejects every
  non-SELECT, config, flag, fallback), `src/lib/sql-beads.test.ts` (filter
  building binds all user text, ranking, `splitShow`, `unionAll`, BFS with
  prefetch, partial-id resolution (unique / ambiguous / none / exact-hash) and the
  double listing of a resolved mention, `runListQuery` fallback with an unreachable DB).
- Scratch-store helpers (`live-test-store.ts`) set `BEADS_BRIDGE_SQL=off`:
  SQL reads the shared DB, not the scratch store.
- **Parity is a live read-only run, not fixtures**: `ops/sql-parity/run.sh`
  copies the tree to a scratch dir on the brain host (never the live app dir,
  nothing deployed or restarted) and runs OLD (`BEADS_BRIDGE_SQL=off`) and NEW on
  identical inputs, asserting byte-identical rendered output.

```sh
ops/sql-parity/run.sh bench.ts bundle                     # beads_bundle N=10, N=40
ops/sql-parity/run.sh bench.ts retrieval                  # search/activity/claimed, default sweep
RUNS=2 ops/sql-parity/run.sh bench.ts snapshot project-nuj9 status-1l1
ops/sql-parity/run.sh bench.ts connections brain-se7t task-1rk93
ops/sql-parity/run.sh list.ts                             # runListQuery vs bd, 69 filter shapes
ops/sql-parity/run.sh stall.ts connections status-6ow     # worst event-loop gap (also run on main)
ops/sql-parity/run.sh ab.ts task-0xdm4 task-2nwlw         # retrieval_snapshot SQL off vs on, both printed for diff
SAMPLE=150 ops/sql-parity/run.sh deps.ts                  # bd dep list edge ORDER vs sqlDepEdges (exit 1 on mismatch)
ops/sql-parity/run.sh partial.ts                          # bd partial-id resolution vs sqlResolvePartialIds (exit 1)
```

## Evidence (brain host, read-only; median of RUNS; spawns = bd subprocesses)

| Case | Before | After |
|---|---|---|
| `beads_bundle` N=10 | 1301 ms / 40 spawns | 388 ms / 9 |
| `beads_bundle` N=40 | 3389 ms / 110 | 1091 ms / 32 |
| `retrieval_search("bridge")` default sweep | 4152 ms / 110 | 768 ms / 0 |
| `retrieval_search("")` | 5071 ms / 110 | 374 ms / 0 |
| `retrieval_activity` | 4687 ms / 110 | 390 ms / 0 |
| `retrieval_activity` since | 4243 ms / 110 | 296 ms / 0 |
| `retrieval_claimed` | 3566 ms / 110 | 64 ms / 0 |
| `retrieval_snapshot` project-vld (48 beads) | 20002 ms / 331 | 2078 ms / 30 |
| `retrieval_snapshot` project-nuj9 (47, truncated) | 31946 ms / 461 | 2015 ms / 36 |
| `retrieval_snapshot` status-1l1 (47, truncated) | 26612 ms / 416 | 2411 ms / 38 |
| `bead_connections` (typical) | ~450 ms / ~11 | ~250–350 ms / 2–3 |
| Event-loop stall during `bead_connections` (worst gap, main → branch) | 1227–1267 ms (status-6ow, question-7eb), 853 ms (project-rjp5), 282 ms (task-1rk93) | 7–8 ms |
| Event-loop stall during `retrieval_snapshot` task-1rk93 | 365 ms gap, 26.3 s total | 11 ms gap, 2.35 s total |

Output was byte-identical in every run (rendered text and JSON).
