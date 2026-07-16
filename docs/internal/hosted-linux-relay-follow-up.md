# Hosted Linux relay follow-up

Status: open. This is a private-beta CI/runtime investigation, not a containment waiver.

GitHub-hosted Ubuntu 24.04 intermittently leaves a bubblewrap run-tool relay child alive until the complete helper or job deadline. The failure reproduces under the hosted runner's user-namespace and AppArmor environment even after `kernel.apparmor_restrict_unprivileged_userns=0`, but not on macOS, local Linux, or a two-core privileged Linux container. Increasing fixed timeouts from 15 to 30 to 60 seconds did not converge; observed failures reached 105 seconds.

The ordinary hosted-Linux test process therefore skips exactly these environment-incompatible lifecycle cases:

- all four cases in `tests/daemon-run-tool.test.ts`;
- `denies a host Unix socket created after launch while broker and run tools remain reachable` in `tests/containment-v2.test.ts`.

The Linux CI job runs both complete test files in a privileged `oven/bun:1.3.14` container with bubblewrap and seccomp, preserving the nested-child, socket-masking, timeout, failure, revocation, and terminalization assertions. The guard is disabled only by `HEADLESS_PRIVILEGED_CONTAINMENT_CI=1` in that dedicated step.

Two issues need a hosted-environment reproducer before the guard can be removed:

1. Trace relay and descendant lifecycle state when the helper response has completed but the bwrap supervisor or filtered child does not terminalize. Use a non-privileged self-hosted or `act` runner that preserves the hosted AppArmor/userns shape; privileged Docker cannot reproduce it.
2. Trace `Unknown goal: goal_…` errors emitted by background goal-delegation runtime work during the long cooperation failures. Those errors are not produced by run-tool operation routing and must not leak across test/runtime ownership boundaries.

Exit criteria: fix both ownership/lifecycle faults, run the guarded cases successfully in the ordinary hosted-Ubuntu process for repeated clean CI runs, then remove the predicate and privileged duplication. Do not weaken bubblewrap, seccomp, socket masking, depth-one admission, or bounded runtime deadlines to satisfy the runner.
