import { describe, expect, test } from "bun:test";
import { safeJsonParse } from "../src/runtime/safe-json";

describe("depth-bounded JSON parsing", () => {
  test("round-trips valid JSON without treating string delimiters as structure", () => {
    const value = safeJsonParse<{ text: string; values: number[] }>(JSON.stringify({
      text: "quoted [brackets] and {braces}",
      values: [1, 2, 3],
    }));

    expect(value).toEqual({ text: "quoted [brackets] and {braces}", values: [1, 2, 3] });
  });

  test("accepts the configured depth boundary and rejects deeper structures", () => {
    expect(safeJsonParse("[[[[0]]]]", 4)).toEqual([[[[0]]]]);
    expect(() => safeJsonParse("[[[[[0]]]]]", 4)).toThrow("JSON nesting depth exceeds limit of 4");

    const defaultDepthBomb = `${"{".repeat(101)}0${"}".repeat(101)}`;
    expect(() => safeJsonParse(defaultDepthBomb)).toThrow("JSON nesting depth exceeds limit of 100");
  });

  test("rejects malformed JSON", () => {
    expect(() => safeJsonParse('{"value":]')).toThrow();
  });
});
