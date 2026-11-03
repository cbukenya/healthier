---
appliesTo:
- type: entity
  id: profile
  effect: reads
references:
- kind: code
  role: implementation
  target: server/auth.ts#requireUser
- kind: code
  role: implementation
  target: server/api.ts#apiRoutes
- kind: code
  role: implementation
  target: server/sync.ts#startScheduler
- kind: code
  role: implementation
  target: src/App.tsx#App
permits:
- related: &id001
  - verb: uses
    entity: person
  when:
  - entity: person
    fact: Signed in
    is: true
  - entity: person
    fact: Admitted
    is: true
- related: *id001
  when:
  - fact: Origin
    is: Demo
- unattended: true
  when:
  - entity: person
    fact: Admitted
    is: true
---

# Only the person and connected synchronization read their profile

The operation stays within the person’s own information through an admitted connected session. Their temporary demonstration information is also available in Demo mode. Background synchronization operates on the admitted person’s connected information.
