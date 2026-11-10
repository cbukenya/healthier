---
acts: external
kind: person
relations:
- entity: profile
  verb: uses
  cardinality: one-to-one
references:
- kind: code
  role: implementation
  target: src/App.tsx#App
- kind: code
  role: implementation
  target: server/auth.ts#requireUser
- kind: code
  role: implementation
  target: server/access.ts#isAllowed
---

# Person

Someone exploring the demo or reading and maintaining their own health information.

## Information kept

- **Signed in** — Whether a current Healthier session is present.
- **Admitted** — Whether the person meets this installation’s current admission policy.
