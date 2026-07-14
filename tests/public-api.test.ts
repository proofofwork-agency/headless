import { describe, expect, test } from "bun:test";
import * as api from "../src/index";
import * as experimental from "../src/experimental";

describe("Beta 1 package surface", () => {
  test("keeps the root runtime export set execution-focused", () => {
    expect(Object.keys(api).sort()).toEqual([
      "HeadlessError",
      "backendChoices",
      "backendMetadata",
      "errorCode",
      "exec",
      "isHeadlessError",
      "normalizeBackend",
      "toHeadlessError",
      "toStructuredError",
    ]);
    expect("RunRequestSchema" in api).toBe(false);
    expect("registerBackendDefinition" in api).toBe(false);
  });

  test("keeps runtime schemas and extension registries experimental", () => {
    expect(typeof experimental.RunRequestSchema?.parse).toBe("function");
    expect(typeof experimental.registerBackendDefinition).toBe("function");
  });
});
