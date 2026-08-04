# Hosted Linux relay follow-up

Status: open. This is a private-beta CI/runtime investigation, not a containment waiver.

GitHub-hosted Ubuntu 24.04 leaves a bubblewrap run-tool relay child alive until the complete helper or job deadline. The failure reproduces under the hosted runner's user-namespace and AppArmor environment even after `kernel.apparmor_restrict_unprivileged_userns=0`, but not on macOS, local dev, or a local two-core privileged Linux Docker container. Increasing fixed timeouts from 15 to 30 to 60 seconds did not converge; observed failures reached 105 seconds.

**A privileged-container CI step was tried and disproven.** Running the same files inside a `--privileged` `oven/bun:1.3.14` container *on the GitHub hosted runner* still failed the four `tests/daemon-run-tool.test.ts` cooperation cases (the `tests/containment-v2.test.ts` cases passed). The identical container passes locally. Therefore the incompatibility is GitHub's hosted-runner kernel/virtualization itself, **not the privilege level**, and no in-CI environment currently runs these four reliably.

The hosted-Linux test process therefore skips the four `tests/daemon-run-tool.test.ts` cooperation cases on **all** GitHub Linux (`process.platform === "linux" && process.env.GITHUB_ACTIONS === "true"`), and the COMBINED `tests/containment-v2.test.ts` late-socket case on unprivileged hosted Linux.

A privileged hosted-x86-64 workflow now exists — `.github/workflows/privileged-containment.yml` — and the late-socket surface is split across it deliberately:

- The **standalone late-created-socket denial** (`denies a host Unix socket created after launch`) is REQUIRED there and asserted non-vacuously, together with the x32 alternate-ABI case. It depends only on bubblewrap and the inherited seccomp filter. It is mutation-proved: disabling the `prctl(SECCOMP)` install in `src/broker/linux-relay.ts` makes it fail, so it can detect its own control being removed.
- The **combined** case (`… while broker and run tools remain reachable`) is intentionally SKIPPED on hosted Linux, because its run-tool leg is repeatedly intermittent there. Raw evidence, not a rate: 3 of 9 hosted samples failed, and every diagnosed failure reported `unixError` ENOENT with `brokerStatus` 200 and `toolCode` 1 — containment held, only run-tool availability broke (runs 30941830730, 30942404411, 30942472935). Nine samples do not establish a probability, so none is claimed. It remains measured off-CI on native Linux arm64.
- The four `tests/daemon-run-tool.test.ts` cooperation cases remain macOS-CI plus off-CI arm64 evidence. They are NOT integrated x86-64 evidence.
- `HEADLESS_PRIVILEGED_CONTAINMENT_CI` remains a manual/self-hosted override and is deliberately UNSET in the required workflow — setting it would re-enable the flaky combined case. The workflow asserts that case appears as `(skip)`, which is only true when the hosted predicate actually reached the container.

Coverage for the four cooperation cases: macOS CI, local dev, and a documented local command a maintainer can run against real bubblewrap:

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
  bun test tests/daemon-run-tool.test.ts tests/containment-v2.test.ts 2>&1 | tee /tmp/out.log
  grep -qE "\(pass\).*denies a host Unix socket created after launch" /tmp/out.log \
    || { echo "late-socket case did not PASS (skipped or failed) — this run proved nothing"; exit 1; }
  echo "OK: late-socket case executed and passed"
'
```

**Why the platform is derived and the result is asserted rather than eyeballed.** Without a correct pin, Docker on an Apple Silicon machine reuses a cached `linux/amd64` image and runs under emulation; emulated bubblewrap fails `strictContainmentAvailable()`, every gated case skips, and the run reports

```
0 pass  4 skip  0 fail
```

which is indistinguishable from success at a glance. That is a vacuous pass, and it is exactly what this file produced for a maintainer on the most common developer hardware. Hardcoding `--platform linux/arm64` would simply move the same failure onto x86-64 hosts, so the command derives it from `uname -m`. And "read the output carefully" is not fail-loud: the probe and the `grep` above make a skipped case exit non-zero, because this command is the only coverage these cases have.

**Recorded evidence, 2026-08-04, against `main` @ 93c7928.** Run on Docker 27.4.0, `--platform linux/arm64`, real `bubblewrap 0.11.0`, a genuine Linux kernel via the Docker VM:

- `tests/daemon-run-tool.test.ts` — **4 pass / 0 fail**. All four cooperation/delegation cases that hosted Linux skips.
- `tests/containment-v2.test.ts` — **15 pass / 0 fail**, including `denies a host Unix socket created after launch while broker and run tools remain reachable` (156ms). That is the `linuxRelayLifecycleTest` case, which is skipped on hosted Linux and covered here.

The privileged escape hatch is proven in both directions on the same host, so the documented override is known to work rather than assumed:

```
GITHUB_ACTIONS=true HEADLESS_PRIVILEGED_CONTAINMENT_CI=1  →  1 pass
GITHUB_ACTIONS=true (override unset)                      →  1 skip
```

**Do not use emulation as evidence for the seccomp architecture check.** `rejects x32 syscall numbers before native seccomp dispatch` gates on `process.arch === "x64"`, so an arm64 host skips it. Running it under `--platform linux/amd64` on arm64 hardware **fails** (`Expected: true, Received: false`, containment-v2.test.ts:570) — and that is an emulation artifact, not a defect: the same test passes on real x86-64 in hosted Ubuntu CI (`(pass) … 108.24ms`, main @ 93c7928). Emulated x86-64 does not faithfully reproduce x32 syscall tagging, so a pass there would have been worthless and the fail is not a finding.

**Hosted x86-64 status, current.** `.github/workflows/privileged-containment.yml` runs `tests/containment-v2.test.ts` in a privileged `oven/bun:1.3.14` container on `ubuntu-latest` with `CI=true GITHUB_ACTIONS=true` and, deliberately, WITHOUT `HEADLESS_PRIVILEGED_CONTAINMENT_CI`. That combination arms the hosted predicate while leaving the flaky combined case skipped. A representative run:

```
HEADLESS_TEST_ARCH=x86_64
(pass) denies a host Unix socket created after launch [140.78ms]
(skip) denies a host Unix socket created after launch while broker and run tools remain reachable
(pass) rejects x32 syscall numbers before native seccomp dispatch [104.37ms]
```

**8 of 8 sampled runs passed after the split** (30943170347 … 30943470199), against **3 of 9 failing before it**, when the combined case still ran here. No rate is claimed from either sample; nine observations give a Wilson interval wide enough that a number would be false precision.

The job cannot pass vacuously. It asserts the architecture sentinel whole-line, the pure case anchored on its trailing duration bracket — necessary because that name is a strict prefix of the combined one — the x32 case, AND that the combined case appears as `(skip)`. That last assertion is what proves `GITHUB_ACTIONS` actually reached the container: without it, the predicate silently disarms, the combined case runs, and it usually passes, so the regression would hide behind two green assertions. The log is uploaded as an artifact.

**Why the split, and what the failures actually were.** The combined case asserts the security property AND broker reachability AND run-tool reachability together, so a flaky relay turned the security gate red. Every diagnosed failure reported `{"unixError":"ENOENT","brokerStatus":200,"toolCode":1}` — the late socket was unreachable, the broker answered, only run-tool failed. Containment held in each. Runs 30941830730, 30942404411, 30942472935.

That classification was nearly impossible: the probe originally collapsed four outcomes into `process.exit(82)`, which covers both a connectable socket (a breach) and an unreachable helper (availability), and it short-circuited the parent's own per-field assertions. The first failure is permanently unclassifiable — its observations went to stdout while only stderr reached the message, and the uploaded artifact preserved no more.

**What remains genuinely unexecuted**, and must not be papered over: the four `tests/daemon-run-tool.test.ts` cooperation cases. They are measured on macOS CI and, per the evidence above, off-CI on Linux arm64 — but not on x86-64 Linux, because the hosted-runner incompatibility at the top of this file is reproduced and unresolved, and privilege is not the cause. Those four traverse the x86-64 + x32 `seccompDefinition` only on a machine nobody has run them on. Closing that needs real, non-hosted x86-64 Linux; it is not an absence of effort and must not be described as covered.

Two issues need a hosted-environment reproducer before the guard can be removed:

1. Trace relay and descendant lifecycle state when the helper response has completed but the bwrap supervisor or filtered child does not terminalize. Use a non-privileged self-hosted or `act` runner that preserves the hosted AppArmor/userns shape; privileged Docker cannot reproduce it.
2. Trace `Unknown goal: goal_…` errors emitted by background goal-delegation runtime work during the long cooperation failures. Those errors are not produced by run-tool operation routing and must not leak across test/runtime ownership boundaries.

Exit criteria: fix both ownership/lifecycle faults, run the guarded cases successfully in the ordinary hosted-Ubuntu process for repeated clean CI runs, then remove the predicate and privileged duplication. Do not weaken bubblewrap, seccomp, socket masking, depth-one admission, or bounded runtime deadlines to satisfy the runner.
