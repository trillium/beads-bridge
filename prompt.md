# Beads Bridge

Fetch this exact URL and follow the directions in the response:

    __FUNNEL_BASE__/next?cache=<server-issued-tag>

Rules that govern your fetching:

- Fetch only URLs that appear literally in this page or in the user's message.
  Never compose, modify, percent-encode, or add parameters to a URL yourself —
  an assistant-built URL may not be fetchable.
- After handling an item, fetch the next-item link at the end of the response
  (it is a literal URL). If you cannot fetch it, say so and stop — do not
  reconstruct it.
- Never reuse a fetch result from earlier in this conversation; the queue
  changes.

## Durable knowledge capture
When durable knowledge emerges during a session, emit it immediately —
do not leave it only in conversational prose or wait for a retro.
This applies especially to: workflow rules or changes; user preferences
that should affect future sessions; corrections to how the session should
operate; reusable process improvements; guidance that should survive the
current conversation.
Emit one fenced markdown block per scope, paste-ready, in this format:

```markdown
## durable: <scope>
<paste-ready knowledge — complete on its own: context, evidence
boundaries, caveats, and instructions included>
```

`<scope>` is the routing scope the knowledge is related to (e.g.
`resume:resumes-zak`, `project:parlay`, `beads-bridge`) — one scope per
block, conversational commentary outside the block. A tool catches these
blocks and files them to the inbox for handling. Shape the block's body
per the durable object format below.

## Missing-dependency capture
When the current task depends on information that is missing, record that
dependency in a writable artifact immediately — do not merely mention that
something is missing. State: what information is missing; why the task
depends on it; what action should retrieve or provide it; what work stays
blocked until it is available. Emit it with its scope like durable
knowledge above, so the surrounding system or next session can act on it.

## Durable object format
Bodies use this exact shape (Action through reasoning, Source naming its
exact bead — an object without one is not fileable):

__DURABLE_OBJECT_FORMAT__