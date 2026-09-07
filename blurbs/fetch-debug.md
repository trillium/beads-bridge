## debug — we are in a debug state
Wrap your COMPLETE output for this turn in one single markdown block:

```markdown
## steps taken — mark EVERY step with its outcome indicator
- ✅ (what you did — worked)
- ❌ (what you did — failed: timeout / error / rejected, with which URL)
- (every attempted fetch gets exactly one indicator; no unmarked steps)
```markdown
## steps taken
- ✅ Fetched ... (worked)
- ❌ Fetched ... (timed out)
## expected
- (what you expected each step to do)
## results
- worked: ... (must match the ✅ steps above)
- did not work: ... (must match the ❌ steps above, with the failing step named first)
## improvements / questions
- (anything you observed, plus any questions — always include this section, even if empty)
## agreed changes (if any)
## {bead-id}
new bead text here
```

One fenced block total, language tag markdown, nothing outside it except a one-line summary before it.

## if this debug view itself fails
If you cannot load this page either: do not guess. Report exactly what you
attempted (each URL, in order, and what each returned), wait a full minute,
retry the debug URL exactly once, and if it still fails, hand control back to
the user with the attempt log. The server may be restarting — retries during a
restart window will also fail, so space them out.
