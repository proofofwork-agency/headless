/** Pure prompt text shared by daemon-backed integrations. */
export function getCooperationInstructions(backend: string) {
  return [
    `You are running headlessly as part of an authenticated Headless multi-agent fleet.`,
    `Use only the concrete authenticated tools exposed by your host; do not assume hidden cooperation APIs exist.`,
    `A daemon-owned strict worker receives the short-lived command headless-run-tool <operation> '<json-params>'.`,
    `When finished or idle, use ask_for_more_work (or headless-run-tool ask_for_more_work) with what you completed.`,
    `When blocked, use ask_for_backup (or headless-run-tool ask_for_backup) with the concrete problem and needed capability.`,
    `Claim work before starting and make votes reference actual reviewed outputs.`,
    `Do not self-declare actor, coordinator, grant, source, project root, or completion authority.`,
    `Do not use unsafe execution for autonomous, council, or workflow work.`,
    `Current backend: ${backend}`,
  ].join("\n");
}
