import { HeadlessError } from "../../runtime/headless-error";
import { assertPrincipalOwns } from "../auth";
import type { DaemonFamilyHandlerRegistrations } from "../route-dispatcher";
import type { DaemonRouteContext } from "../route-context";

type ReceiptFamilies = Pick<DaemonFamilyHandlerRegistrations, "receipt">;

export function receiptRouteHandlers(context: DaemonRouteContext): ReceiptFamilies {
  return {
    receipt: {
      "receipt.get": (params, credential) => requireReceiptFor(context, params.runId, credential),
      "receipt.list": (params, credential) => context.listReceipts({ limit: 10_000 })
        .filter((receipt) => credential.scopes.includes("admin") || receipt.body.principal === credential.principal)
        .slice(0, params.limit ?? 1_000),
      "receipt.verify": (params, credential) => {
        requireReceiptFor(context, params.runId, credential);
        return context.verifyReceipt(params.runId);
      },
      "receipt.export": (params, credential) => {
        requireReceiptFor(context, params.runId, credential);
        return context.exportReceipt(params.runId);
      },
    },
  };
}

function requireReceiptFor(
  context: DaemonRouteContext,
  runId: string,
  credential: Parameters<typeof assertPrincipalOwns>[0],
) {
  const receipt = context.getReceipt(runId);
  if (!receipt) throw new HeadlessError("INVALID_REQUEST", `Unknown receipt: ${runId}`);
  assertPrincipalOwns(credential, receipt.body.principal, "Receipt");
  return receipt;
}
