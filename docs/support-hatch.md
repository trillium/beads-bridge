# Independent support hatch

Use the support hatch when normal Beads/Beads Bridge operations cannot produce or verify a reliable result: total Beads/store outage; malformed tool/MCP responses; manifest or schema mismatch; authentication or routing failure; or partial degradation where one or more operations fail. Do not send routine work, general notes, or arbitrary data through this endpoint. It is a narrow support/debug intake, not a replacement store.

## Run separately from beads-bridge

The hatch is an isolated module under `src/support-hatch/` and runs as its own process. It imports no bridge or Beads code and writes only ordinary files. Run it on a host/network reachable by the agent even when the bridge process is stopped:

```sh
SUPPORT_HATCH_TOKEN='use-a-random-secret-of-at-least-24-characters' \
SUPPORT_HATCH_DIR="$HOME/.local/share/beads-bridge/support-hatch" \
SUPPORT_HATCH_PORT=31339 bun src/support-hatch/server.ts
```

The MCP endpoint is `http://<hatch-host>:31339/mcp`; `/health` is a non-sensitive process check. Supply `Authorization: Bearer <SUPPORT_HATCH_TOKEN>` to MCP requests. The token must be at least 24 characters. Keep the service on a trusted/private network or behind an independently managed TLS/authenticated ingress; do not expose the endpoint without protecting the token. Storage defaults to `~/.local/share/beads-bridge/support-hatch`, uses mode `0700` for the directory and `0600` for files, and should be backed up/retained according to support policy.

Configure the MCP client against this endpoint as a separate server/tool surface. Since it is a separate process, stopping beads-bridge does not stop the hatch. The hatch deliberately has no route through bridge health, Beads CLI, any Beads store, bridge OAuth state, or bridge service key.

## Tools and receipt

- `support_report_submit`: provide `user_description`, `failing_operation`, and `exact_response` (verbatim, including malformed/raw output). Optionally add `timestamp`, `bridge_version`, `backend_version`, `manifest_schema_metadata`, `recent_call_context`, `client_identity`, and `reproduction_steps`. Inputs are bounded; unknown fields or missing required fields are rejected without storing a report. Never include passwords, bearer tokens, private keys, or other credentials.
- `support_report_get`: retrieve by the returned `receipt.report_id`. The response includes the report, receipt, and `verified: true` only after recomputing the report's SHA-256 against the independently stored receipt.

A submit response is a receipt only after both the report and receipt files were published. If local storage is unavailable or either write fails, the tool returns an error and issues no receipt; retry only after checking storage availability. If a report or receipt is missing/incomplete, retrieval returns not found. If bytes do not match the receipt, retrieval reports an integrity error and never claims success. The hatch never repairs or rewrites a report silently.

## Failure handling

The hatch is independent, not magic: if its own process, network, credential, or disk is unavailable, there is no accepted report and no receipt. Preserve the diagnostic locally and retry when the hatch is reachable. Invalid/malformed submissions are rejected; schema incompatibilities should be recorded in `exact_response` and `manifest_schema_metadata`. For auth/routing failures, record the exact status/body and a sanitized route/client description; never copy credentials. Partial degradation is reported with the failed operation and relevant recent calls, not by claiming the entire bridge is down. Receipt verification detects file corruption/tampering but is not a signature or a remote proof of delivery; keep the receipt with the report ID for support follow-up.

## Validation

`bun test src/support-hatch/support-hatch.test.ts` checks import isolation, file receipt verification/tampering, auth rejection, and a live MCP HTTP submit/retrieve round-trip using only the standalone hatch app. That test does not import or start the bridge, so the Beads/bridge process may be stopped while it runs.
