# 061 — Reviewed publishers

**Epic:** G — Trusting and extending bundles · **Priority:** could · **Size:** M
**Depends on:** 060

## Story

As a site administrator, I want the marketplace to show which bundles come from
publishers crombolo has reviewed, and when, so that I can choose between two
attested packages on more than the fact that each was built in CI.

## Context

Provenance (060) cannot say whether the repository it names is one anyone
should trust. That is a human statement. The precedent is Umbraco's
marketplace, which marks packages from a maintained list rather than anything
cryptographic.

## Acceptance criteria

- [ ] **The list.** One JSON document at a crombolo-controlled URL,
      configurable with a default.
  - [ ] It names *publishers* rather than packages: an npm scope or user name,
        the source repositories that belong to them, the date reviewed, and a
        line on what the review covered.
  - [ ] It is fetched when the marketplace opens and cached for the session. An
        unreachable list is an empty list with a log line, never a failed
        marketplace.
- [ ] **The badge.** A listing is *reviewed by crombolo* when its publisher is on
      the list and, where 060 verified an attestation, the attested repository
      is one the list names for them.
  - [ ] When the two disagree, the badge is withheld and the log says why.
  - [ ] The badge names the date of review. A two-year-old review on a package
        with forty releases since then still reads as the true statement it is.
- [ ] **The setting.** `marketplace.require` gains `'reviewed'` and `'either'`,
      with the same refusal pattern and the same Installed view.
- [ ] **The format is documented** beside [`bundles.md`](../../bundles.md): its
      shape, how a publisher asks to be reviewed, what a review covers, and
      that a revocation is a dated entry the marketplace honours from that
      date. The list itself is not in this repository.
- [ ] **Exit:** against a recorded list:
  - [ ] A package from a listed publisher shows the badge, with its date.
  - [ ] One whose attestation names a repository the list does not give that
        publisher does not.
  - [ ] With `require: 'either'`, a self-attested build from a reviewed
        publisher and an attested build from an unreviewed one both install.
  - [ ] An unattested package from nobody known is refused.

## Out of scope

- Populating the list. That is an operations task, not this story, and it
  starts with the bundles this repository ships itself.
