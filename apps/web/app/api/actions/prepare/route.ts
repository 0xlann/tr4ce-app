import { prepareActionRequestSchema } from "@tr4ce/domain";

import { prepareAction } from "../../../../src/api/client";
import { invalidRequest, readJson, respond } from "../../../../src/api/route-helpers";

/**
 * Prepare the unsigned calls for a deposit or a redemption.
 *
 * Idempotent on the binding: `prepared_action_live_binding_key` is a unique index over the calldata
 * hash while an action is still `prepared` or `simulated`, so asking twice under unchanged
 * conditions names the action that already exists. That stops holding once a hash has been
 * reported — which is why nothing re-prepares an action to recover its calldata after submission.
 *
 * The full response, including every transaction, is returned to the browser. That is the point:
 * the caller has to see the exact bytes before approving them, and this is the only response in the
 * contract that carries them.
 */

export async function POST(request: Request): Promise<Response> {
  const parsed = prepareActionRequestSchema.safeParse(await readJson(request));

  if (!parsed.success) {
    return invalidRequest(parsed.error, "The prepare request does not match the schema.");
  }

  return respond(await prepareAction(parsed.data));
}
