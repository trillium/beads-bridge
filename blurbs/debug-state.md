---
vars:
  ATTEMPTS: bullet-list  # one ✅/❌ line per attempt, in order
  STEPS: bullet-list     # same markers, inside the copyable block
  RESULTS: bullet-list   # worked: / did not work: lines
  RETRY: bullet-list     # retry literals, one per line
---
## debug — a fetch failed. You are in a debug state. Do not guess contents. Do not retry blindly more than once.

Attempt log (in order):

{ATTEMPTS}

Copy the block below, keep the ✅/❌ markers accurate, and follow it:

```markdown
## steps taken — EVERY step carries one outcome indicator, no unmarked steps
{STEPS}
## expected
- (what each step was supposed to do)
## results
{RESULTS}
## improvements / questions
- (anything observed, plus any questions — always include this section, even if empty)
## agreed changes (if any)
```

Retry these literals one at a time:

{RETRY}
