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
