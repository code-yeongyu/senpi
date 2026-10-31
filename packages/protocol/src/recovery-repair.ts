import Type, { type Static } from "typebox";
import { Check } from "typebox/value";

/** S14/RULING-84: one wire schema shared by producer and client policy; no prompt or current-root action exists. */
export const RecoveryRepairAdviceSchema = Type.Object(
	{
		state: Type.Union([Type.Literal("ok"), Type.Literal("repair_needed"), Type.Literal("storage_unavailable")]),
		healthRevision: Type.Union([Type.String({ pattern: "^(0|[1-9][0-9]*)$" }), Type.Null()]),
		source: Type.Union([
			Type.Object(
				{ sessionEpoch: Type.String({ minLength: 1 }), sequence: Type.Integer({ minimum: 0 }) },
				{ additionalProperties: false },
			),
			Type.Null(),
		]),
		hint: Type.Literal("restart_from_catalog"),
		retryAfterMs: Type.Integer({ minimum: 0, maximum: 2_000 }),
	},
	{ additionalProperties: false },
);
export type RecoveryRepairAdvice = Readonly<Static<typeof RecoveryRepairAdviceSchema>>;
export function isRecoveryRepairAdvice(value: unknown): value is RecoveryRepairAdvice {
	return Check(RecoveryRepairAdviceSchema, value);
}
