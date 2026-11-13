# Product Model

This directory describes how Healthier works today, written down in the
[pdd-kit](https://pdd-kit.dev) format: who uses it, what it keeps, what it
lets people do, and which rules hold. Think of it as system documentation.
It is plain Markdown tracked in Git.

It follows the code. Where the two disagree, the code is what happens, and the
model is corrected to match, even when the code looks like a bug. Whether the
code should change is a separate question, for an issue or a pull request.

This is a first slice: it covers sync and data freshness only. `coverage.md`
names the code it describes and lists what isn't modelled yet.

## Keeping it current

When a pull request changes behaviour this model describes, it updates the
model too, the way it would update a test. The code it describes is listed in
`coverage.md` under `covered`. A change to the wording or look of a screen
needs no model change; a change to what happens does.

Two optional commands help, and nothing in the build, tests or CI needs them:

- `npx pdd-toolkit view` opens the model as a report in your browser, served
  on your own machine. It follows your edits as you save, and shows what
  changed since your branch left `main`.
- `npx pdd-toolkit lint` checks the files are well formed. A clean result
  doesn't mean the model matches the code; only reading both does.

If you use a coding agent, the optional pdd-kit skills (`npx pdd-toolkit
install`) add `pdd-verify`, which checks the code against the model and lists
the differences, and `pdd-map`, which models code the model doesn't cover yet.
Without them, read and edit the Markdown directly.

## How to read it

- A Capability is something the product lets someone do. Its Scenarios walk
  through what happens, step by step, in one situation.
- A Business Rule is something that holds across behaviours. A Rule's
  `permits` names who can perform an operation; everyone else is refused.
- A Screen's `shows` and `collects` are the facts it presents and the input
  it takes, not its layout or design.
- `availability` names the Interfaces and Experiences where a behaviour works.
- An Entity's facts and states are what the product keeps and tells apart,
  not a storage schema.
- References point to the code behind each file, for finding your way. They
  don't prove the code matches.

Start with `product.md`, then Entities, Interfaces with their Experiences and
Screens, Capabilities and their Scenarios, and Business Rules. A resource is
`<id>.md`, or `<id>/<type>.md` when it owns child resources.

Documentation of the format: https://pdd-kit.dev
