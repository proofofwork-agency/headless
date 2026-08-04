import { mock } from "bun:test";
import * as fs from "node:fs";
import { basename } from "node:path";

const target = process.env.HEADLESS_ATOMIC_CLOSE_TARGET;
if (!target) throw new Error("HEADLESS_ATOMIC_CLOSE_TARGET is required");

const originalOpenSync = fs.openSync;
const originalCloseSync = fs.closeSync;
let temporaryDescriptor = null;
let closeAttempts = 0;
const originalWriteSync = fs.writeSync;
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
      // Do NOT clear temporaryDescriptor: a retry must still be recognisable
      // as targeting the same descriptor, which is the thing under test.
      closeAttempts += 1;
      throw new Error("injected atomic close failure");
    }
    return originalCloseSync(descriptor);
  },
}));

// close(2) releases the descriptor even when it reports an error, so retrying
// it can close a number another operation has since reused. The count is
// reported on exit so the test can assert exactly one attempt.
process.on("exit", () => {
  originalWriteSync(2, `ATOMIC_CLOSE_ATTEMPTS=${closeAttempts}\n`);
});
