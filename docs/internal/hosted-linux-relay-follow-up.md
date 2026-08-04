# Hosted Linux relay follow-up

Status: the four cooperation cases are RESOLVED (2026-08-04). The combined late-socket case remains open. This is a private-beta CI/runtime investigation, not a containment waiver.

## RESOLVED: the four `tests/daemon-run-tool.test.ts` cooperation cases

**The cause was ours, in our own relay — not the hosted runner.** `startStreamProxy` in `src/broker/linux-relay.ts` paused the accepted client and attached the pipe only from the upstream `connect` callback. Bytes arriving in that window had no consumer and were **silently discarded**. Fixed by attaching the consumer synchronously at accept and buffering, bounded, until the upstream connects (`bridgeStreamConnection`).

Instrumenting all three processes on a hosted x86-64 runner showed every stage reporting success — relay listening, helper connected and writing, relay accepted, relay upstream connected, daemon accepted — with **zero `complete frame received` on the daemon across all four cases**, and no error anywhere. The worker then waited out its deadline and reported `run tool unavailable: run tool timeout`.

It is a **race, not an architecture property**. Fast hosts win the upstream connect and never enter the window, which is why every arm64 leg passed. It is also why raising timeouts 15 → 30 → 60s never converged: the request was already gone, so waiting longer could not help.

| environment | before | after |
| --- | --- | --- |
| GitHub-hosted x86-64, bwrap 0.9.0, kernel 6.17-azure | 4 fail, ~5.4s each | **4 pass, 0.6–1.4s** |
| arm64 Debian, bwrap 0.11.0 | 4 pass | 4 pass |
| arm64 Ubuntu 24.04, bwrap 0.9.0 | 4 pass | — |
| arm64, starved to `--cpus=0.4` | 4 pass | — |

Hosted runs `30951464184` and `30953476478` (failing, instrumented), `30954416492` (passing, after the fix). The arm64 matrix is what ruled out the two plausible confounders: bubblewrap version and general slowness.

**Corrections to what this file previously asserted.** The claim that GitHub-hosted Ubuntu "leaves a bubblewrap relay child alive until the deadline", with failures reaching 105 seconds, is disproved — the measured behaviour is a clean ~5.4s client timeout. The conclusion that "the incompatibility is GitHub's hosted-runner kernel/virtualization itself, **not the privilege level**" was wrong in both halves: privilege was indeed irrelevant, but so was the runner. The privileged-container attempt failed for the same reason the unprivileged one did, and reading that as evidence about the environment sent the investigation away from our own code for weeks. What was accurate throughout, and worth keeping, is that these four were UNEXECUTED on x86-64 Linux while having genuine off-CI arm64 coverage; that distinction is what eventually made the arm64-vs-x86-64 contrast legible.

`HOSTED_LINUX_RELAY_INCOMPATIBLE` is removed. The four cases are gated only on `strictContainmentAvailable()` and now declare both `ubuntu` and `macos` legs in `tests/gated-coverage.test.ts`.

`tests/linux-relay-stream-proxy.test.ts` pins the fix. It opens the window explicitly with a real, not-yet-connected socket, because two earlier versions could not fail: racing a real relay **passed on macOS against the defective code** (the bytes land before accept, where the kernel buffer preserves them), and a `stream.Duplex` stand-in cannot exhibit the loss at all, having correct Node buffering semantics. Both were regression tests that could not regress. The surviving version is mutation-proved: 2 of 4 fail with the old shape restored, 4 of 4 pass with the fix.

## Still open: the combined late-socket case

The COMBINED `tests/containment-v2.test.ts` late-socket case remains skipped on unprivileged hosted Linux. Whether the relay fix also resolves it has NOT been tested — its failures reported `unixError` ENOENT rather than a lost request, so do not assume it is the same fault.

The late-socket surface is now split, and the security property is covered by the ORDINARY ubuntu release gate — which installs bubblewrap and runs `probeLinuxBwrap` fail-closed — with `.github/workflows/privileged-containment.yml` adding independent privileged-container evidence on top:

- The **standalone late-created-socket denial** (`denies a host Unix socket created after launch`) is a `linuxBwrapTest`, so it runs on the ordinary ubuntu leg AND in the privileged job. It runs together with the x32 alternate-ABI case. The ordinary ubuntu leg is an ENFORCED required check on `main` (branch protection added 2026-08-04, verified via the GitHub API); the privileged job is deliberately not required, because it is path-filtered and a required context that never reports would block unrelated pull requests. Splitting it out of the combined case is what covered it; the privileged job is duplicate evidence that additionally asserts non-vacuity, which the ordinary gate does not. It depends only on bubblewrap and the inherited seccomp filter. It is mutation-proved: disabling the `prctl(SECCOMP)` install in `src/broker/linux-relay.ts` makes it fail, so it can detect its own control being removed.
- The **combined** case (`… while broker and run tools remain reachable`) is intentionally SKIPPED on hosted Linux, because its run-tool leg is repeatedly intermittent there. Raw evidence, not a rate: 3 of 9 hosted samples failed, and every diagnosed failure reported `unixError` ENOENT with `brokerStatus` 200 and `toolCode` 1 — containment held, only run-tool availability broke (runs 30941830730, 30942404411, 30942472935). Nine samples do not establish a probability, so none is claimed. It remains measured off-CI on native Linux arm64.
- The four `tests/daemon-run-tool.test.ts` cooperation cases now run on the ordinary ubuntu leg and on macOS, and are integrated x86-64 evidence as of 2026-08-04. This line previously said the opposite, and was true until the relay fix above.
- `HEADLESS_PRIVILEGED_CONTAINMENT_CI` remains a manual/self-hosted override and is deliberately UNSET in the privileged workflow — setting it would re-enable the flaky combined case. The workflow asserts that case appears as `(skip)`, which is only true when the hosted predicate actually reached the container.

Coverage for the four cooperation cases: macOS CI, local dev, and a documented local command a maintainer can run against real bubblewrap. The same command is the only RELIABLE coverage for the COMBINED late-socket + broker/run-tool case on Linux — the standalone denial runs on the ordinary ubuntu leg and in the privileged job, so it is not what this command exists for, so it asserts all five cases by name:

```bash
# Derives the platform from THIS host, refuses to run under emulation, and
# fails if the cases skip instead of passing. Do not hardcode --platform:
# pinning the wrong one silently reintroduces the emulation problem below.
HOST_PLATFORM="linux/$(uname -m | sed 's/^x86_64$/amd64/; s/^aarch64$/arm64/; s/^arm64$/arm64/')"
docker run --rm --privileged --platform "$HOST_PLATFORM" --cpus=2 --memory=3g -v "$PWD:/repo:ro" oven/bun:1.3.14 bash -lc '
  set -euo pipefail
  apt-get update -qq && apt-get install -y -qq bubblewrap
  cp -r /repo /work && cd /work
  bun install --frozen-lockfile --ignore-scripts
  # Fail closed BEFORE the suite: without real bubblewrap every gated case
  # skips and the run still exits 0.
  bun -e "import {probeLinuxBwrap} from \"./src/runtime/os-sandbox\"; const r = probeLinuxBwrap(); if (!r.ok) { console.error(\"bubblewrap unusable: \" + r.reason); process.exit(1); }"
  # NO_COLOR=1 is what makes the result lines assertable: with a terminal
  # attached (add -t and you have one) bun prints a colored check-mark line
  # instead of "(pass) <name>", and every pattern below would then miss a case
  # that really passed. Measured on bun 1.3.14; NO_COLOR does not override
  # FORCE_COLOR, so do not set that.
  NO_COLOR=1 bun test tests/daemon-run-tool.test.ts tests/containment-v2.test.ts 2>&1 | tee /tmp/out.log
  # Assert EVERY case this command is the coverage for, not just one of them.
  # The suite exit code cannot do it: a gated-out case prints "(skip) <name>"
  # and the run still exits 0. Measured: with the daemon-run-tool gate armed
  # (GITHUB_ACTIONS=true HEADLESS_PRIVILEGED_CONTAINMENT_CI=1) all four
  # cooperation cases skipped, bun exited 0, and the earlier version of this
  # command -- which grepped only the late-socket case -- still printed OK.
  # Anchor to the start of the line so "(skip)"/"(fail)" cannot satisfy it, and
  # require the trailing " [" duration so a longer name that merely starts the
  # same way cannot either: containment-v2 has both "denies a host Unix socket
  # created after launch" and the "... while broker and run tools remain
  # reachable" case asserted here.
  for case_name in \
    "daemon-owned worker cooperation > injects the scoped helper into the contained worker and revokes it at terminal state" \
    "daemon-owned worker cooperation > runs one depth-one child and omits delegation from the child credential" \
    "daemon-owned worker cooperation > returns child failure as tool data and lets the parent finish" \
    "daemon-owned worker cooperation > returns child timeout as tool data inside the parent deadline" \
    "Linux bubblewrap profiles > denies a host Unix socket created after launch while broker and run tools remain reachable"
  do
    grep -qE "^\(pass\) $case_name \[" /tmp/out.log \
      || { echo "NOT A PASS (skipped or failed): $case_name"; exit 1; }
  done
  echo "OK: all four cooperation cases and the late-socket case executed and passed"
'
```

**Why every case is asserted by name instead of trusting the exit code.** A `bun test` run whose cases were all gated out prints `0 pass 4 skip 0 fail` and exits 0, which is indistinguishable from success at a glance — that vacuous pass is what this file used to hand a maintainer. Emulation produces it too: without a correct `--platform`, Docker on Apple Silicon reuses a cached `linux/amd64` image, emulated bubblewrap fails `strictContainmentAvailable()`, and every gated case skips. Hardcoding `linux/arm64` would move the same failure onto x86-64 hosts, so the platform is derived from `uname -m`. Asserting only the late-socket case was not enough either: re-running the suite with `GITHUB_ACTIONS=true HEADLESS_PRIVILEGED_CONTAINMENT_CI=1` skips exactly the four cooperation cases while the late-socket case still passes, and the single-case version of this command printed `OK` and exited 0 on that log. "Read the output carefully" is not fail-loud; the probe and the five anchored assertions are.

**Current off-CI evidence — this command run VERBATIM at `f78a78d`** (extracted from the fenced block programmatically, not retyped), on Docker 27.4.0, `--platform linux/arm64`, real `bubblewrap 0.11.0`, privileged:

```
(pass) injects the scoped helper into the contained worker and revokes it at terminal state [484.00ms]
(pass) runs one depth-one child and omits delegation from the child credential [532.88ms]
(pass) returns child failure as tool data and lets the parent finish [499.08ms]
(pass) returns child timeout as tool data inside the parent deadline [1339.95ms]
 20 pass  7 skip  0 fail
OK: all four cooperation cases and the late-socket case executed and passed
```

Exit 0 — but the exit code is not what makes this evidence. The command's own five anchored assertions are, because a fully gated-out run also exits 0. Anchored to the CURRENT head deliberately: an earlier version of this section recorded a run against `main` @ 93c7928, taken before the late-socket case was split and before either case asserted `socketVisible`, and `tests/containment-v2.test.ts` has moved +107/-6 since. Evidence for a materially changed test is a stale claim, not history.

**Do not use emulation as evidence for the seccomp architecture check.** `rejects x32 syscall numbers before native seccomp dispatch` gates on `process.arch === "x64"`, so an arm64 host skips it. Running it under `--platform linux/amd64` on arm64 hardware **fails** (`Expected: true, Received: false`, containment-v2.test.ts:570) — and that is an emulation artifact, not a defect: the same test passes on real x86-64 in hosted Ubuntu CI (`(pass) … 108.24ms`, main @ 93c7928). Emulated x86-64 does not faithfully reproduce x32 syscall tagging, so a pass there would have been worthless and the fail is not a finding.

**Hosted x86-64 status, current.** `.github/workflows/privileged-containment.yml` runs `tests/containment-v2.test.ts` in a privileged `oven/bun:1.3.14` container on `ubuntu-latest` with `CI=true GITHUB_ACTIONS=true` and, deliberately, WITHOUT `HEADLESS_PRIVILEGED_CONTAINMENT_CI`. That combination arms the hosted predicate while leaving the flaky combined case skipped. A representative run:

```
HEADLESS_TEST_ARCH=x86_64
(pass) denies a host Unix socket created after launch [140.78ms]
(skip) denies a host Unix socket created after launch while broker and run tools remain reachable
(pass) rejects x32 syscall numbers before native seccomp dispatch [104.37ms]
```

**8 of 8 dispatched runs passed after the split** (30943170347 … 30943470199), against **3 of 9 failing before it**, when the combined case still ran here. Precision about what those 8 exercised: 7 ran `d11918f`, which had the corrected socket path and the seccomp mutation proof but not yet the per-run `socketVisible` assertion; only 30943470199 and the PR runs at `458fea2`/`c0bb126` exercised the final anti-vacuity shape. No rate is claimed from either sample; nine observations give a Wilson interval wide enough that a number would be false precision.

The job cannot pass vacuously. It asserts the architecture sentinel whole-line, the pure case anchored on its trailing duration bracket — necessary because that name is a strict prefix of the combined one — the x32 case, AND that the combined case appears as `(skip)`. That last assertion is what proves `GITHUB_ACTIONS` actually reached the container: without it, the predicate silently disarms, the combined case runs, and it usually passes, so the regression would hide behind two green assertions. The log is uploaded as an artifact.

**Why the split, and what the failures actually were.** The combined case asserts the security property AND broker reachability AND run-tool reachability together, so a flaky relay turned the security gate red. Every diagnosed failure reported `{"unixError":"ENOENT","brokerStatus":200,"toolCode":1}` — the late socket was unreachable, the broker answered, only run-tool failed. Containment held in each. Runs 30941830730, 30942404411, 30942472935.

That classification was nearly impossible: the probe originally collapsed four outcomes into `process.exit(82)`, which covers both a connectable socket (a breach) and an unreachable helper (availability), and it short-circuited the parent's own per-field assertions. The first failure is permanently unclassifiable — its observations went to stdout while only stderr reached the message, and the uploaded artifact preserved no more.

**What remains unproven on x86-64 Linux.** Only the combined late-socket case. It ran in the nine-sample hosted series but failed 3 of 9, so it lacks RELIABLE integrated x86-64 coverage and is deliberately not ongoing coverage.

The four cooperation cases are no longer in this category. They were genuinely unexecuted on x86-64 Linux — measured on macOS CI and off-CI on arm64, but never on x86-64, so they traversed the x86-64 + x32 `seccompDefinition` on no machine anyone had run them on. That is now closed: they execute and pass on the ordinary hosted x86-64 leg. Worth recording that the gap was real and the reasoning about it was not — the missing coverage was blamed on the runner for weeks while the defect sat in our relay, and it was exactly the arm64-vs-x86-64 contrast this file kept honest that made it findable.

Both issues this section previously listed as blockers are closed. The "relay child does not terminalize" fault never existed as described — the relay was discarding the request, and every process was behaving correctly given that. The `Unknown goal: goal_…` errors were fixed at source: a fire-and-forget autonomy scan survived `dispose()` and reported its own teardown as a runtime fault (`GoalRuntimeService.dispose`).

Remaining exit criteria, for the combined late-socket case only: determine whether its ENOENT failures share a cause with the relay defect, and if not, reproduce them in a hosted environment. Do not weaken bubblewrap, seccomp, socket masking, depth-one admission, or bounded runtime deadlines to satisfy the runner.
