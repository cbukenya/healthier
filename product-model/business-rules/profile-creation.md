---
appliesTo:
- type: entity
  id: profile
  effect: creates
references:
- kind: code
  role: implementation
  target: server/auth.ts#authRoutes
- kind: code
  role: implementation
  target: src/App.tsx#App
- kind: code
  role: implementation
  target: src/hooks/useHealth.ts#useHealth
permits:
- actors:
  - person
  when:
  - entity: person
    fact: Signed in
    is: true
  - entity: person
    fact: Admitted
    is: true
  - fact: Origin
    is: Connected
- actors:
  - person
  when:
  - entity: installation
    fact: Demo offered
    is: true
  - fact: Origin
    is: Demo
---

# A person opens their connected or offered demo profile

A connected profile is created when an admitted person signs in with Google. Demo profiles are available when the installation offers Demo mode.
