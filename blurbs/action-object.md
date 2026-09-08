---
vars: {}
required-sections: [Action, Target, Source, Status, Description, Generate-bullets, External-action, Feedback-required, Completion-condition, reasoning]
source-rule: Source must list the exact source bead id (e.g. resume_bullets-bqk). An action object without one is not fileable.
---
Action: <verb + target outcome>
Target:
Source: <project-bead / story-bead / evidence source> {{MUST LIST EXACT SOURCE BEAD}}

Status: STALE
Description:
<what should be investigated, generated, verified, or changed>

Generate bullets

<candidate evidence or bullet direction>
<additional candidate evidence as needed>

External action

* <exact action the outside system/person/tool should perform>
* <tool/source to use, if known>
* <scope, date range, identifiers, or constraints>

Feedback required

<what result must be returned>

* <what evidence/source supports it>
* <which claims were verified, rejected, or changed>

<new metrics or facts discovered>
<remaining uncertainty>

Completion condition

<what must be true before this object is no longer stale>

⸻

reasoning

<why this action matters, usually tied to the target job description or resume structure>
