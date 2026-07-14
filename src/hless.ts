#!/usr/bin/env bun
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
const child = Bun.spawn([process.execPath, cli, ...Bun.argv.slice(2)], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.once("SIGINT", () => child.kill("SIGINT"));
process.once("SIGTERM", () => child.kill("SIGTERM"));

process.exitCode = await child.exited;
