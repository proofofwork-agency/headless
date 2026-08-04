import { mock } from "bun:test";
import * as fs from "node:fs";
import { basename } from "node:path";

const target = process.env.HEADLESS_ATOMIC_CLOSE_TARGET;
if (!target) throw new Error("HEADLESS_ATOMIC_CLOSE_TARGET is required");

const originalOpenSync = fs.openSync;
const originalCloseSync = fs.closeSync;
let temporaryDescriptor = null;
const temporaryPrefix = `.${basename(target)}.tmp-`;

mock.module("fs", () => ({
  ...fs,
  openSync(path, flags, mode) {
    const descriptor = mode === undefined
      ? originalOpenSync(path, flags)
      : originalOpenSync(path, flags, mode);
    if (String(path).includes(temporaryPrefix)) temporaryDescriptor = descriptor;
    return descriptor;
  },
  closeSync(descriptor) {
    if (descriptor === temporaryDescriptor) {
      temporaryDescriptor = null;
      throw new Error("injected atomic close failure");
    }
    return originalCloseSync(descriptor);
  },
}));
