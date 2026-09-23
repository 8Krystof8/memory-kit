---
type: hub
status: active
description: "Questions only the owner can answer, each with a recommended answer. Agents add items; the owner answers."
updated: 2026-09-23
---
# Waiting for you
> Questions that need you, each with a recommendation. Reply after "Answer:" with yes, no or an option number.
> Agents: one item per question, at most 20 open. Once answered, record the outcome in its note
> (usually a decision with the owner's words) and remove the item; git history keeps it.

Item format:
```markdown
## W-001 Short question (sector, since YYYY-MM-DD)
Question: the question, with numbered options if there are several.
Basis: wikilinks to the notes it depends on, and why it matters.
Recommendation: one sentence with the reason.
Answer:
```
