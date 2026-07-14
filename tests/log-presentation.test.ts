import { describe, expect, test } from "bun:test";
import type { RunEvent } from "../src/contracts/run";
import { isErrorEvent, isFunctionalActivityEvent, parseLogDisplayMode, selectLogEvents, strictLogIdentity } from "../src/runtime/log-presentation";

describe("operator log presentation", () => {
  const lifecycle = event({ kind: "lifecycle", state: "running", detail: "worker started" });
  const stdout = event({ kind: "stdout", text: "provider token delta" });
  const stderr = event({ kind: "stderr", text: "provider disconnected" });

  test("separates clear errors from functional activity", () => {
    expect(isErrorEvent(stderr)).toBe(true);
    expect(isFunctionalActivityEvent(lifecycle)).toBe(true);
    expect(selectLogEvents([lifecycle, stdout, stderr], "verbose", "errors")).toEqual([stderr]);
    expect(selectLogEvents([lifecycle, stdout, stderr], "verbose", "activity")).toEqual([lifecycle]);
  });

  test("keeps verbose complete while compact and strict remove provider chatter", () => {
    expect(selectLogEvents([lifecycle, stdout, stderr], "verbose")).toHaveLength(3);
    expect(selectLogEvents([lifecycle, stdout, stderr], "compact")).toEqual([lifecycle, stderr]);
    expect(selectLogEvents([lifecycle, stdout, stderr], "strict")).toEqual([lifecycle, stderr]);
    expect(strictLogIdentity(stderr)).toContain("event=event-one job=job-one session=none seq=1");
    expect(parseLogDisplayMode("strict")).toBe("strict");
    expect(() => parseLogDisplayMode("noisy")).toThrow("compact, verbose, or strict");
  });
});

function event(value: Record<string, unknown>) {
  return { version: 2, eventId: "event-one", jobId: "job-one", sessionId: null, sequence: 1, timestamp: 1, redacted: true, ...value } as RunEvent;
}
