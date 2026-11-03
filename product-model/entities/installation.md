---
singleton: true
references:
- kind: code
  role: implementation
  target: server/config.ts#loadConfig
---

# Installation

The settings the host supplies for this Healthier installation.

## Information kept

- **Demo offered** — Whether Demo mode is offered; enabled by default.
- **Sign-in note** — Optional host-provided plain-text joining information, up to 600 characters.
- **Terms address** — Optional web address of the installation's terms.
- **Privacy notice address** — Optional web address of the installation's privacy notice.
- **Allowed emails** — Optional email addresses and domains admitted by the host.
- **Sync interval** — Minutes between background syncs; 60 by default, zero disables scheduled sync.
- **History days** — Daily history retention and import span; 730 by default, between 62 and 3650.
