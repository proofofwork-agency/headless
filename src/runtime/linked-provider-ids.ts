import { createHash } from "node:crypto";
import { ProjectIdSchema } from "../contracts/common";

const digestPattern = /^[a-f0-9]{64}$/;

export function linkedProviderHoldId(projectId: string, parentJobId: string, requestId: string) {
  return createHash("sha256")
    .update(`${ProjectIdSchema.parse(projectId)}\0${parentJobId}\0${requestId}`)
    .digest("hex");
}

export function linkedProviderOperationIds(linkId: string) {
  if (!digestPattern.test(linkId)) throw new TypeError("Linked provider hold id must be a SHA-256 digest.");
  return {
    parentOperationId: `${linkId}:parent`,
    targetOperationId: `${linkId}:target`,
    targetRunQuotaId: `headless-linked-target-${linkId}`,
  } as const;
}
