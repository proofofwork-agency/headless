# Hosted Linux relay follow-up

Status: open. This is a private-beta CI/runtime investigation, not a containment waiver.

GitHub-hosted Ubuntu 24.04 leaves a bubblewrap run-tool relay child alive until the complete helper or job deadline. The failure reproduces under the hosted runner's user-namespace and AppArmor environment even after `kernel.apparmor_restrict_unprivileged_userns=0`, but not on macOS, local dev, or a local two-core privileged Linux Docker container. Increasing fixed timeouts from 15 to 30 to 60 seconds did not converge; observed failures reached 105 seconds.

**A privileged-container CI step was tried and disproven.** Running the same files inside a `--privileged` `oven/bun:1.3.14` container *on the GitHub hosted runner* still failed the four `tests/daemon-run-tool.test.ts` cooperation cases (the `tests/containment-v2.test.ts` cases passed). The identical container passes locally. Therefore the incompatibility is GitHub's hosted-runner kernel/virtualization itself, **not the privilege level**, and no in-CI environment currently runs these four reliably.

The hosted-Linux test process therefore skips the four `tests/daemon-run-tool.test.ts` cooperation cases on **all** GitHub Linux (`process.platform === "linux" && process.env.GITHUB_ACTIONS === "true"`), and the one `tests/containment-v2.test.ts` late-socket case on unprivileged hosted Linux. There is no privileged-container CI step.

Because there is no privileged step, the late-socket case runs on **no CI leg at all**: its gate is `linuxBwrapTest`, so macOS skips it as Linux-only, and hosted Linux skips it as unprivileged. `HEADLESS_PRIVILEGED_CONTAINMENT_CI` is set by no workflow. That is recorded as an uncovered gate in `tests/gated-coverage.test.ts`; the four cooperation cases are different — they do run on macOS CI.

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
- `tests/containment-v2.test.ts` — **15 pass / 0 fail**, including `denies a host Unix socket created after launch while broker and run tools remain reachable` (156ms). That is the `linuxRelayLifecycleTest` case which runs on no CI leg at all.

The privileged escape hatch is proven in both directions on the same host, so the documented override is known to work rather than assumed:

```
GITHUB_ACTIONS=true HEADLESS_PRIVILEGED_CONTAINMENT_CI=1  →  1 pass
GITHUB_ACTIONS=true (override unset)                      →  1 skip
```

**Do not use emulation as evidence for the seccomp architecture check.** `rejects x32 syscall numbers before native seccomp dispatch` gates on `process.arch === "x64"`, so an arm64 host skips it. Running it under `--platform linux/amd64` on arm64 hardware **fails** (`Expected: true, Received: false`, containment-v2.test.ts:570) — and that is an emulation artifact, not a defect: the same test passes on real x86-64 in hosted Ubuntu CI (`(pass) … 108.24ms`, main @ 93c7928). Emulated x86-64 does not faithfully reproduce x32 syscall tagging, so a pass there would have been worthless and the fail is not a finding.

**What remains genuinely unexecuted**, and must not be papered over: the late-socket case and the four run-tool cooperation cases are outcome-level and architecture-neutral, but they traverse the architecture-specific `seccompDefinition` — the AArch64 table on the host above, the x86-64 + x32 table on hosted Ubuntu. So the honest statement is: *complete late-socket and run-tool cooperation are measured off-CI on Linux arm64; the x86-64 native and x32 filter primitives are measured on hosted Ubuntu; the full integrated late-socket and run-tool cooperation cases remain unexecuted on x86-64 Linux.* Closing that needs real x86-64 Linux hardware, not a runner and not emulation.

Two issues need a hosted-environment reproducer before the guard can be removed:

1. Trace relay and descendant lifecycle state when the helper response has completed but the bwrap supervisor or filtered child does not terminalize. Use a non-privileged self-hosted or `act` runner that preserves the hosted AppArmor/userns shape; privileged Docker cannot reproduce it.
2. Trace `Unknown goal: goal_…` errors emitted by background goal-delegation runtime work during the long cooperation failures. Those errors are not produced by run-tool operation routing and must not leak across test/runtime ownership boundaries.

Exit criteria: fix both ownership/lifecycle faults, run the guarded cases successfully in the ordinary hosted-Ubuntu process for repeated clean CI runs, then remove the predicate and privileged duplication. Do not weaken bubblewrap, seccomp, socket masking, depth-one admission, or bounded runtime deadlines to satisfy the runner.
