/** The schema of `admit_external_message`, a relayed peer-agent message admitted as a delivery (senpi#6233). */

import Type from "typebox";
import { Id, literals, Opt, OptId, OptStr, Str, session } from "./method-classes-schema-fields.ts";

/** `SessionControlSender`: each kind's fields and no other, so nothing beyond the label rides along. */
const DeliverySender = Type.Union([
	Type.Object({ kind: Type.Literal("agent"), session_id: Id, name: OptId }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("command_line"), user: OptId }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("external"), platform: Id, author: OptId }, { additionalProperties: false }),
]);

export const DELIVERY_RECORD_SCHEMAS = {
	admit_external_message: session("admit_external_message", {
		deliveryId: Id,
		text: Str,
		sender: Opt(DeliverySender),
		displayText: OptStr,
		deliverAs: literals("steer", "followUp"),
		expectedTurnId: OptId,
		whenIdle: Opt(literals("start", "queue")),
		chainCount: Opt(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
	}),
};
