# Release runbook

Ordered steps for cutting a release. Publication is a **human** decision and is
not automated anywhere in this repository.

This exists because the ordering is not obvious and one step is easy to waste:
P.TTFV evidence is pinned to the commit it measured, so running it at the wrong
moment produces evidence that is already stale. See
[product-gate.md](../product-gate.md#pttfv-is-commit-pinned--read-this-before-a-release).

## Before you start

- `docs/plan.md` is the security oracle. **No gate publishes while a P0/P1
  security or data-integrity defect remains.** Confirm the gate you are cutting
  has its evidence recorded there, not merely believed.
- `docs/product-gate.md` is the UX oracle. It does not authorize publication.
- The current tree is unpublished private beta. Package publication is blocked by
  `private: true` and remains a deliberate human act.

## Order

The first three steps must happen in this order. Steps 4–6 may be interleaved.

1. **Land everything.** Every change that will be in the release must be merged
   first, because the next two steps are pinned to `HEAD`.

2. **Cut the version.** One commit, matching the existing convention
   (`chore: cut 0.2.0-beta.N`): bump `version` in `package.json` and promote the
   CHANGELOG `## Unreleased` heading to the new version. Do this **before** the
   live smoke, or the smoke's evidence names the pre-bump commit.

3. **Run the live TTFV smoke at the cut commit.**

   ```bash
   bun run smoke:ttfv:live
   bun scripts/product-gate.ts    # read it BEFORE committing the evidence
   ```

   Expect `product-gate: 10 pass, 0 manual, 0 fail`. This performs a real
   read-only provider exec against the operator's native logins and spends their
   quota, so it is never run unattended.

   **Read the gate now, and do NOT commit the evidence yet.** Committing it moves
   `HEAD` past the commit the evidence names, and the tag must name the commit
   that was actually measured. The evidence is committed in step 7, after the
   tag. Do not re-run chasing a green that no committed state can hold.

4. **Full release check from the final tree.**

   ```bash
   bun run release:check   # check + build + smoke:pack
   ```

   Do not carry forward an older local pass after control-plane, native-auth,
   session-driver, fleet, TUI, or package changes — `docs/plan.md` lists the
   exact surfaces that invalidate it.

5. **Confirm CI is green on the cut commit.** Required contexts on `main` are
   exactly `ubuntu-latest release gate`, `macos-latest release gate`, and
   `website build` (strict/up-to-date required; `enforce_admins: false`, so
   "required" means reported-and-visible, not impossible to bypass). The
   `x86-64 privileged bubblewrap` job is deliberately **not** required: it is
   path-filtered, and a required context that never reports would block every
   unrelated pull request.

6. **Optional regression probe.** `hosted-relay-diagnostic.yml` (manual dispatch)
   samples the combined late-socket case 10× on hosted x86-64 and re-runs the
   four cooperation cases. Not required — they all run on the ordinary Ubuntu
   gate now — but it is the only thing that samples the process tree and sockets
   *while* they run.

## Then, and only then

7. **Tag and publish the measured commit**, then commit the evidence file on top
   as the durable record.

   The order matters and is easy to get backwards. The cut commit C is what the
   live smoke measured, so C is what gets tagged. Committing the evidence first
   would produce C+1 and you would tag a commit whose evidence names its parent —
   precisely the failure this runbook warns about below. Recording the evidence
   after the tag means `main` moves on while the tag stays pinned to the
   validated tree.

   Tagging and publishing are human acts requiring explicit authorization;
   nothing in this repository performs them, and a green gate does not grant
   permission.

## Things that have gone wrong before

- **Tagging on evidence that names an earlier commit.** P.TTFV compares
  `provenance.commit` to `HEAD`; evidence from before the version bump has not
  validated the tree being tagged.
- **Running the live smoke too early.** Anything merged afterwards wastes it.
- **Reading `9 pass / 1 manual` as a regression.** After the evidence is
  committed that is the expected steady state.
- **Trusting a green suite that skipped.** `0 fail` and "everything skipped" are
  the same string. Where a claim matters, assert case names and counts.
