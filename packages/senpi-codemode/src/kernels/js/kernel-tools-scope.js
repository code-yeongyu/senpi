import { kernelToolError } from "./kernel-tools-errors.js";

/**
 * Call-scoped host-tool policy for one kernel-tool invocation (#1731). A call without a tool scope
 * refuses nothing (today's behavior); `deny` wins over `allow`; an `allow` list refuses every host
 * tool it does not name; a malformed list fails closed instead of widening the call's reach.
 */
export function hostToolRefusal(scope, toolName) {
	const tools = scope?.tools;
	if (tools === null || typeof tools !== "object") return null;
	if (tools.deny !== undefined) {
		const deny = nameList(tools.deny);
		if (deny === null || deny.includes(toolName)) return "deny";
	}
	if (tools.allow !== undefined) {
		const allow = nameList(tools.allow);
		if (allow === null || !allow.includes(toolName)) return "allow";
	}
	return null;
}

/** The typed refusal the closure sees and the invoking call reports. */
export function hostDeniedError(toolName, callId, reason) {
	return kernelToolError(
		"kernel_tool_host_denied",
		`Host tool is outside this kernel tool call's scope: ${toolName} (${reason})`,
		{ tool: toolName, call_id: callId, reason },
	);
}

function nameList(value) {
	if (!Array.isArray(value)) return null;
	return value.every((name) => typeof name === "string") ? value : null;
}
