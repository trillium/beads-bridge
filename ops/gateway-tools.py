#!/usr/bin/env python3
"""Gateway tool-count helpers shared by ops/jungle-register-bearer.sh and
ops/mcp-refresh-check.sh. The count comes from the gateway's HTTP API
(GET /api/v0/tools?server=...), never from the flaky `mcpjungle list tools`.

  gateway-tools.py names <api.json|->            enabled tool names, prefix stripped, sorted
  gateway-tools.py report <api.json|-> <live-N>  prints "beads-bridge tools via gateway: N (live M)";
                                                 exit 0 if N == M, 1 otherwise
Reads no secrets and prints none.
"""
import json, sys

PREFIX = "beads-bridge__"


def names(doc):
    tools = doc.get("tools", []) if isinstance(doc, dict) else doc
    out = []
    for t in tools:
        if not isinstance(t, dict) or t.get("enabled") is False:
            continue
        n = t.get("name", "")
        out.append(n[len(PREFIX):] if n.startswith(PREFIX) else n)
    return sorted(out)


def load(path):
    return json.load(sys.stdin if path == "-" else open(path))


def main(argv):
    if len(argv) < 3 or argv[1] not in ("names", "report"):
        print(__doc__, file=sys.stderr)
        return 2
    try:
        found = names(load(argv[2]))
    except Exception as e:  # unparseable API reply
        print(f"gateway tools reply unparseable: {e}", file=sys.stderr)
        return 2
    if argv[1] == "names":
        print("\n".join(found))
        return 0
    live = int(argv[3])
    print(f"beads-bridge tools via gateway: {len(found)} (live {live})")
    return 0 if len(found) == live else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
