import type { SessionToolPolicy } from "./extensions/types.ts";

export const SESSION_TOOL_POLICY_ENTRY_TYPE = "session-tool-policy";

interface SessionToolPolicyEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

export function isSessionToolUseDisabled(entries: readonly SessionToolPolicyEntry[]): boolean {
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== SESSION_TOOL_POLICY_ENTRY_TYPE) continue;
		const data = entry.data;
		if (
			typeof data === "object" &&
			data !== null &&
			"version" in data &&
			data.version === 1 &&
			"tools" in data &&
			data.tools === "disabled"
		) {
			return true;
		}
	}
	return false;
}

export function isDisabledSessionToolPolicy(policy: SessionToolPolicy): boolean {
	return policy.version === 1 && policy.tools === "disabled";
}

export function applySessionToolPolicyToPromptSkills<T>(entries: readonly SessionToolPolicyEntry[], skills: T[]): T[] {
	return isSessionToolUseDisabled(entries) ? [] : skills;
}

const PROVIDER_TOOL_KEYS = ["tools", "tool_choice", "toolChoice", "parallel_tool_calls", "parallelToolCalls"] as const;

export function applySessionToolPolicyToProviderPayload(
	entries: readonly SessionToolPolicyEntry[],
	payload: unknown,
): unknown {
	if (
		!isSessionToolUseDisabled(entries) ||
		typeof payload !== "object" ||
		payload === null ||
		Array.isArray(payload)
	) {
		return payload;
	}
	const record = payload as Record<string, unknown>;
	if (!PROVIDER_TOOL_KEYS.some((key) => key in record)) return payload;
	const transformed = { ...record };
	for (const key of PROVIDER_TOOL_KEYS) {
		delete transformed[key];
	}
	return transformed;
}
