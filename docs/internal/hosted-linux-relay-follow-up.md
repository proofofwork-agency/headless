# Hosted Linux relay follow-up

Status: open. This is a private-beta CI/runtime investigation, not a containment waiver.

GitHub-hosted Ubuntu 24.04 leaves a bubblewrap run-tool relay child alive until the complete helper or job deadline. The failure reproduces under the hosted runner's user-namespace and AppArmor environment even after `kernel.apparmor_restrict_unprivileged_userns=0`, but not on macOS, local dev, or a local two-core privileged Linux Docker container. Increasing fixed timeouts from 15 to 30 to 60 seconds did not converge; observed failures reached 105 seconds.

**A privileged-container CI step was tried and disproven.** Running the same files inside a `--privileged` `oven/bun:1.3.14` container *on the GitHub hosted runner* still failed the four `tests/daemon-run-tool.test.ts` cooperation cases (the `tests/containment-v2.test.ts` cases passed). The identical container passes locally. Therefore the incompatibility is GitHub's hosted-runner kernel/virtualization itself, **not the privilege level**, and no in-CI environment currently runs these four reliably.

The hosted-Linux test process therefore skips the four `tests/daemon-run-tool.test.ts` cooperation cases on **all** GitHub Linux (`process.platform === "linux" && process.env.GITHUB_ACTIONS === "true"`), and the one `tests/containment-v2.test.ts` late-socket case on unprivileged hosted Linux. There is no privileged-container CI step.

Because there is no privileged step, the late-socket case runs on **no CI leg at all**: its gate is `linuxBwrapTest`, so macOS skips it as Linux-only, and hosted Linux skips it as unprivileged. `HEADLESS_PRIVILEGED_CONTAINMENT_CI` is set by no workflow. That is recorded as an uncovered gate in `tests/gated-coverage.test.ts`; the four cooperation cases are different — they do run on macOS CI.

Coverage for the four cooperation cases: macOS CI, local dev, and a documented local command a maintainer can run against real bubblewrap:

```
docker run --rm --privileged --platform linux/arm64 --cpus=2 --memory=3g -v "$PWD:/repo:ro" oven/bun:1.3.14 \
  bash -lc 'apt-get update -qq && apt-get install -y -qq bubblewrap && cp -r /repo /work && cd /work && bun install --frozen-lockfile --ignore-scripts && bun test tests/daemon-run-tool.test.ts tests/containment-v2.test.ts'
```

**Pin `--platform` to the host architecture, and read the PASS count, not the fail count.** Without the pin, Docker on an Apple Silicon machine will happily reuse a cached `linux/amd64` image and run the suite under emulation. Emulated bubblewrap fails `strictContainmentAvailable()`, every gated case skips, and the run reports

```
0 pass  4 skip  0 fail
```

which is indistinguishable from success at a glance. That is a vacuous pass: it proves nothing and it is the outcome a maintainer following this file on the most common developer hardware would have got. This command is the only coverage these cases have, so it has to fail loudly rather than skip quietly — verify `4 pass` for the cooperation cases, and for the late-socket case verify that `denies a host Unix socket created after launch while broker and run tools remain reachable` appears as `(pass)` rather than `(skip)`.

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
