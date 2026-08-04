import { resolveCommandAction } from "../argv";
import { renderCommandUsage } from "../command-specs";
import { CliUsageError, daemonClient, flagArgsBeforeSeparator, getArg, parseBackend, parseIntegerArg, requiredArg } from "../shared";

export async function runSkillCommand(args: string[]) {
  const { action, operands } = resolveCommandAction(args, "list");
  const flags = flagArgsBeforeSeparator(args);
  const client = await daemonClient(getArg(flags, "--cwd") || process.cwd(), flags);
  if (action === "list") return print(await client.call("skill.list"));
  if (action === "inspect") return print(await client.call("skill.inspect", { skill: requiredSkill(operands) }));
  if (action === "import") return print(await client.call("skill.import", { source: requiredArg(flags, "--source") }));
  if (action === "enable" || action === "revoke") return print(await client.call(action === "enable" ? "skill.enable" : "skill.revoke", { skill: requiredSkill(operands) }));
  if (action === "use") {
    const skill = requiredSkill(operands);
    const separator = args.indexOf("--");
    const argumentsText = separator >= 0 ? args.slice(separator + 1).join(" ") : "";
    return print(await client.call("skill.use", {
      skill, arguments: argumentsText,
      backend: getArg(flags, "--backend") ? parseBackend(getArg(flags, "--backend")!) : undefined,
      timeoutMs: parseIntegerArg(flags, "--timeout-ms") ?? 180_000,
    }));
  }
  throw new CliUsageError(renderCommandUsage("skill"));
}

function requiredSkill(operands: string[]) {
  const value = operands[0];
  if (!value) throw new CliUsageError("A skill id or id@version is required.");
  return value;
}
function print(value: unknown) { console.log(JSON.stringify(value, null, 2)); }
