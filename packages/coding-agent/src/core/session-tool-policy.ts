import type { SessionEntry } from "./session-manager.ts";

export const SESSION_TOOL_POLICY_ENTRY_TYPE = "session-tool-policy";

export interface SessionToolPolicy {
	version: 1;
	tools: "disabled";
}

export function isSessionToolUseDisabled(entries: readonly SessionEntry[]): boolean {
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
