---
id: healthier
summary: A self-hosted dashboard that makes Google Health readings understandable through traceable arithmetic.
category: health-and-fitness
tags:
- wellness
- self-hosted
- health-data
authors:
- name: cbukenya
  url: https://github.com/cbukenya
license: AGPL-3.0-only
languages:
- en-US
limitations:
- Healthier is a personal wellness and data-visualisation tool; it is not a medical device and does not make medical decisions.
- Healthier reads health measurements from Google Health; devices and other health apps feed Google Health outside Healthier.
- Scores, insights and Labs use arithmetic on recorded data; no AI writes or guesses their results.
- Cycle phases are estimates and do not identify fertile days or provide contraception.
- Healthier sends no telemetry; the only requests that leave the server go to Google.
references:
- kind: doc
  role: intent
  target: README.md
- kind: doc
  role: intent
  target: CONTRIBUTING.md
- kind: doc
  role: intent
  target: docs/ARCHITECTURE.md
---

# Healthier

Healthier is an open-source dashboard people host themselves to understand their sleep, activity, heart rate, HRV, body measurements and cycles. It combines recent readings, longer history and explanations of the calculations, with automatic Labs that describe patterns in the person’s own data.

## Intent

“Your Google Health data, made clear.” Healthier started because the Google Health app was hard to read: all the data was there, but it took too much digging to learn what it meant. Its principles are the project's own:

- **Clear before clever.** A glance should tell the person how they slept, how much they've moved and how they're recovering, in plain sentences with the numbers inside them.
- **Arithmetic you can trace.** Every score and insight is plain arithmetic on the person's own data; the same data always gives the same answer, and every result can be followed back to the readings behind it.
- **Open algorithms.** Every formula is in the open, so anyone can check it, question it and improve it.
- **For everyone.** It runs in any browser, on a phone or a computer.
- **Yours.** People run it themselves, with no telemetry.
