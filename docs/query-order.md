# Query date bounds, order, and cursors

`query_store` and `GET /q/:store` share one list path (`runListQuery`).

## Bounds

`created_after`, `created_before`, `updated_after`, `updated_before` are
exclusive (`>` / `<`), matching `bd list`. A value is RFC3339 UTC
(`2026-10-16T01:02:03Z`) or `YYYY-MM-DD` (midnight UTC). Other forms are
rejected. The predicate is in the SQL `WHERE`, and on the bd fallback it is
the matching `--created-*` / `--updated-*` flag.

## Order

| Caller | Order when `order_by` is omitted |
|---|---|
| store `status` | `updated_at` descending, then priority ascending, then id |
| every other store | priority ascending, then `created_at` descending, then id (bd's default) |

`order_by` is `created_at`, `updated_at`, `priority`, or `id`. `descending`
overrides that field's usual direction (timestamps newest-first; priority and
id ascending). The last key is always the bead id, so a tie has one order.

The status default is the captain's status feed (inbox-xi2i): newest activity
first, priority only as a tie-break. Callers that omit the new options on any
other store keep today's rows and order.

## Cursor

`next_cursor` is present only when another page exists. It is opaque. It
encodes the sort columns and the last row's sort values plus the bead id.
Send it back with the same store and the same `order_by` / `descending`.
Page size stays `limit` (default 20, max 50). The SQL path is a keyset
predicate, not an offset. The bd fallback moves the primary timestamp with
an exclusive before/after flag; rows that share that exact second are paged
exactly only on the SQL path.

## published_at

Bead rows have `created_at` and `updated_at`. They do not have `published_at`.
`order_by=published_at` and `published_after` / `published_before` return an
error. The status feed's "published" time is `updated_at`.

## Sibling tools

`retrieval_search` and `retrieval_activity` (and their GET routes) take the
same four bounds, applied in the query. Search stays relevance-ordered.
Activity stays newest `updated_at` first. A full walk of one store is
`query_store` plus `next_cursor`.
