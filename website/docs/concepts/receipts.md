---
id: receipts
title: Execution Receipts
sidebar_position: 7
---

# Execution receipts

An execution receipt is Headless's answer to "prove what the agent did." It is a portable, tamper-evident record assembled for **every authorized run — read-only runs included** — binding who authorized the run, under what policy, budget, and containment, and what it produced. Its self-digest is anchored into the hash-chained ledger, and anyone can verify it: online against the live chain, or offline from a single exported file.

## What a receipt contains

A receipt is a strict `version: 1` envelope — a `body`, per-section digests, and an integrity block. The body carries:

- **Identity** — `receiptId`, `runId`, optional `sessionId`, `projectId`, and the `principal` that ran it.
- **Request echo** — the authority and policy *inputs* that admitted the run: backend, mode, model, agent, timeout, containment requirement, auth mode, approval policy, and the prompt as a content-addressed blob: exact-bytes SHA-256 digest, byte count, and a bounded redacted preview (at most 4,096 characters). The full prompt never rides in the receipt.
- **Result** — status, structured error, exit code, signal, token usage, cost attribution, the containment *evidence* actually observed (mechanism, network, credential isolation, unsafe marker), duration, truncation flags, the output as a digest-anchored blob, and — for write runs — a diff proof: patch digest and size, the file list, and the base, candidate, and resulting commit SHAs in the clear.
- **Policy trail** — up to 256 policy decisions captured from the run's policy events, each recording `allowed`, `denied`, or `deferred`, the rule, and the reason.
- **Authorization snapshot** — source-discriminated so it is never ambiguous: `root`, `foreground_lead`, or `grant`. A grant-sourced receipt must carry the `grantId` plus the grant's *immutable* terms (operations, backends, expiry, cost and iteration caps); it deliberately never carries mutable usage counters, so a receipt cannot imply remaining authority incorrectly. Merge permission and any finality decision are recorded alongside.
- **Broker-lease scope** — for broker-auth runs, a redacted snapshot of the request-time envelope the budget outcome alone does not prove: provider, models, endpoint classes, expiry, request/body/concurrency/stream/cost caps, quota caps, and a scope digest. It deliberately **excludes** the bearer token, token hash, base URL, and usage counters. `null` for native-login runs.
- **Gate manifest** — up to 64 entries, one per gate that ran: phase (`candidate` or `integration`), name, status (`passed`, `failed`, `timed_out`, `cancelled`), and digests of the gate definition and its evidence — the result, not the transcript.
- **Budget outcome** — passed or not, reasons, usage, cost, and the reservation ID.
- **Provenance** — wall-clock start and end, Headless version, platform, source commit, and backend version.

The integrity block then covers all of it: `sectionDigests` holds one SHA-256 per section (request, result, policyTrail, authorization, brokerLease, gates, budget, provenance), and `integrity.selfDigest` is the SHA-256 of the canonical body JSON. Nothing outside the body is covered and nothing in it is excluded — an external verifier hashes exactly that object, with no field-exclusion rules to get wrong.

## How anchoring works

When a run reaches terminal state, Headless appends an `execution_receipt` artifact to the project's tamper-evident ledger — the same append-only chain in which every record binds its sequence, previous hash, and SHA-256 or HMAC-SHA256 metadata. The anchor is a compact marker (bounded to 3,500 bytes) carrying the receipt ID, run ID, the receipt's self-digest, mode, status, and lite provenance; the full receipt lives in the durable receipt store. Anchoring every run — including read-only ones — stays cheap by design.

`integrity.ledgerAnchor` in the receipt records the project ID, ledger sequence, and record hash it was anchored under, closing the loop: the receipt names its anchor, and the anchor names the receipt's digest.

## Crash recovery: no silent post-terminal window

Receipt evidence is assembled after the durable job reaches terminal state, because a receipt is evidence—not authority over whether the run completed. That ordering used to leave a narrow crash window: the terminal job could be durable while its receipt and ledger anchor were not.

Headless now writes a per-job receipt-journal intent **before** the terminal job update. The owner-only, fsynced marker captures the authorization, broker lease, gates, budget, bounded capture failure, and exact at-run provenance needed to reproduce the receipt. On daemon boot, every pending marker is reconciled against the durable request and terminal result:

1. If the receipt already exists, startup marks the journal complete without re-emitting it.
2. If the receipt is missing, startup deterministically reassembles and anchors it. Receipt IDs and ledger event IDs are deterministic, so a crash after the anchor but before the receipt-store write reuses the same anchor rather than appending a duplicate.
3. If safe reassembly is impossible—for example, the persisted inputs conflict with an existing anchor—Headless records an explicit `execution_receipt_gap` artifact with a bounded reason and marks the journal `gap`.

The gap artifact is deliberately **not** an `execution_receipt` and carries no receipt-anchor marker, so verification cannot mistake it for proof. If the ledger cannot accept either recovery record (for example, a verifier-only HMAC keyring has no active writer key), the marker stays pending for a future authorized writer. One malformed marker is diagnosed and left for repair; it does not prevent unrelated daemon state from becoming ready.

:::note
Recovery preserves the evidence-is-not-authority invariant: receipt or journal failures never rewrite a successful run as failed. The durable terminal job remains the execution truth, while the journal makes missing evidence visible and repairable instead of silent.
:::

## Verification levels — and what each honestly proves

```bash
# Online: full-chain proof through the project daemon
headless experimental receipt verify <runId>

# Offline: verify a portable export, no daemon required
headless experimental receipt verify --file export.json

# Offline, upgraded: bring the ledger for full-chain proof
headless experimental receipt verify --file export.json --ledger ledger.jsonl
```

| Check | Assurance | What it proves |
| --- | --- | --- |
| `receipt verify <runId>` | **full-chain** | The receipt's digests recompute, its anchor exists in the live ledger, and the entire chain up to it verifies. |
| `receipt verify --file export.json` | **embedded-record** | The receipt's digests recompute and match the anchoring ledger record embedded in the export — without proving that record's place in the wider chain. |
| `--file` + `--ledger` | **full-chain** | The embedded record also matches the supplied ledger and the chain verifies — full proof, fully offline. |
| HMAC-signed anchor, offline, no key | **structural-only** | Structure and digests check out, but authenticity needs the live ledger and its key. Headless says so rather than overstating. |

Every verify form exits non-zero on failure, so receipts slot directly into scripts and CI. `headless verify` (stable, non-experimental) independently scans the whole ledger chain at any time.

## Private by construction

Receipts are designed to be shareable. Prompts and outputs appear as digests plus bounded redacted previews — anyone holding the original bytes can recompute the digest and match; nobody else learns the content. Diffs are anchored by digest with only file paths and commit SHAs in the clear. The broker lease omits every secret. The project appears as an opaque `projectId`, not a filesystem path. What crosses the wire when you hand someone an export is evidence, not payload.

## Working with receipts

```bash
headless experimental receipt list --limit 20            # one line per run, with anchor sequence
headless experimental receipt show <runId>               # full human summary
headless experimental receipt export <runId> --out export.json   # portable proof bundle (0600)
headless experimental receipt verify <runId>             # online, full-chain
headless experimental receipt diff <runIdA> <runIdB>     # field-level comparison
```

`export` writes a self-contained bundle: the receipt, its anchoring ledger record, and a ledger-head snapshot — everything an offline verifier needs for embedded-record assurance. `diff` compares two runs across the load-bearing fields — backend, mode, model, status, authority source, cost, token usage, containment mechanism/network/unsafe marker, gate count, exit code, and the prompt and output digests — which makes drift between "the same run, re-run" immediately visible. All subcommands accept `--json`.

:::warning
`HEADLESS_RECEIPTS=off` disables receipt assembly and anchoring. It exists only for operator recovery, and using it weakens the independently verifiable proof for every run completed while it is set. Leave it on.
:::

## Related

- [The safety model](./safety-model.md) — the containment and policy machinery a receipt attests to.
- [Quickstart](../getting-started/quickstart.md) — produce and verify your first receipt in minutes.
