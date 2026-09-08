---
vars:
  BASE: string    # public bridge root
  RESUME: string  # resume bead id, e.g. resumes-zak
---
## when decided
When the promote/demote set is agreed, fetch {BASE}/fetch/{RESUME}/done and follow its output format exactly — one ## {bead-id} section per changed bullet, unchanged bullets omitted.
