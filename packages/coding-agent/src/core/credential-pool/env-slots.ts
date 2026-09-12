import { getApiKeyEnvVars } from "@earendil-works/pi-ai";

export const MAX_ENV_SLOT_INDEX = 16;

export type EnvCredentialSlot = {
	name: string;
	envVarName: string;
	key: string;
	source: "env";
};

/**
 * Anthropic maps to bearer/OAuth token vars ahead of its API-key var; numbered
 * slots must extend the API-key lane, so prefer the `*_API_KEY` entry when the
 * canonical mapping lists several variables.
 */
export function primaryEnvVar(providerId: string): string | undefined {
	if (providerId === "claude-sdk-oauth") return "CLAUDE_CODE_OAUTH_TOKEN";
	const envVars = getApiKeyEnvVars(providerId);
	if (!envVars || envVars.length === 0) return undefined;
	return envVars.find((name) => name.endsWith("_API_KEY")) ?? envVars[0];
}

/**
 * Discovers numbered env credential slots: the primary var yields slot `env`,
 * and `<VAR>_2` .. `<VAR>_16` yield `env-2` .. `env-16`. Discovery is
 * gap-tolerant - a configured `<VAR>_3` with no `<VAR>_2` is still found and no
 * slot is invented for the gap. Stored credentials keep outranking every env
 * slot because resolution consults env only when nothing is stored.
 */
export function discoverEnvSlots(providerId: string, env: (name: string) => string | undefined): EnvCredentialSlot[] {
	const primary = primaryEnvVar(providerId);
	if (!primary) return [];
	const slots: EnvCredentialSlot[] = [];
	const base = env(primary);
	if (base) slots.push({ name: "env", envVarName: primary, key: base, source: "env" });
	for (let index = 2; index <= MAX_ENV_SLOT_INDEX; index++) {
		const envVarName = `${primary}_${index}`;
		const value = env(envVarName);
		if (value) slots.push({ name: `env-${index}`, envVarName, key: value, source: "env" });
	}
	return slots;
}
