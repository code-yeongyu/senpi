import { DEFAULT_SLOT_BLOCK_MS, MAX_SLOT_BLOCK_MS } from "@earendil-works/pi-ai/auth/pool/failover";
import { NonemptyConfigValueSchema } from "@earendil-works/pi-ai/utils/config-reference";
import { type Static, Type } from "typebox";

/** Policy defaults shared with the pool engine so schema and runtime cannot drift. */
export const CREDENTIAL_POLICY_DEFAULTS = {
	rotation: true,
	affinity: true,
	cooldownBaseMs: DEFAULT_SLOT_BLOCK_MS,
	cooldownCapMs: MAX_SLOT_BLOCK_MS,
} as const;

const CredentialSlotRefSchema = Type.Object(
	{
		env: Type.Optional(Type.String({ minLength: 1 })),
		value: Type.Optional(NonemptyConfigValueSchema),
	},
	{ additionalProperties: false },
);

/**
 * Policy only: named slots REFERENCE env vars or command values; key material
 * itself stays in auth.json or the environment, and unknown keys (for example
 * a literal `apiKey`) are rejected outright.
 */
export const CredentialPolicySchema = Type.Object(
	{
		rotation: Type.Optional(Type.Boolean()),
		affinity: Type.Optional(Type.Boolean()),
		cooldownBaseMs: Type.Optional(Type.Number({ minimum: 0 })),
		cooldownCapMs: Type.Optional(Type.Number({ minimum: 0 })),
		slots: Type.Optional(Type.Record(Type.String({ minLength: 1 }), CredentialSlotRefSchema)),
	},
	{ additionalProperties: false },
);

export type ModelsJsonCredentialPolicy = Static<typeof CredentialPolicySchema>;
