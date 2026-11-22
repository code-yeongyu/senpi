import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { FileEntry } from "../../src/core/session-manager.ts";

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** 375 requests, 288 tool results (180 eval), ~575k peak including a 52.6k prefix. */
export function syntheticCacheSession(): FileEntry[] {
	const entries: FileEntry[] = [
		{ type: "session", version: 3, id: "cache-fixture", timestamp: new Date(0).toISOString(), cwd: "/fixture" },
	];
	let parentId: string | null = null;
	let serial = 0;
	const append = (message: AgentMessage) => {
		const id = `entry-${serial++}`;
		entries.push({ type: "message", id, parentId, timestamp: new Date(serial).toISOString(), message });
		parentId = id;
	};
	append({ role: "user", content: "setup ".repeat(30_000), timestamp: 0 });
	let tools = 0;
	for (let request = 0; request < 375; request++) {
		const toolTurn = request % 5 !== 4 && tools < 288;
		// A long eval-only gap leaves some of the last six clearable results
		// far behind the live tail when sporadic clearable results resume.
		const clearable = tools < 96 || (tools >= 210 && (tools - 210) % 7 === 0);
		const name = clearable ? ["read", "write", "edit"][tools % 3] : "eval";
		const tokens = request < 275 ? 1_435 : 815;
		const assistant: AssistantMessage = {
			role: "assistant",
			content: toolTurn
				? [{ type: "toolCall", id: `call-${request}`, name, arguments: { path: `file-${request}` } }]
				: [{ type: "text", text: "answer ".repeat(Math.floor((tokens * 4) / 7)) }],
			api: "faux-completion",
			provider: "faux",
			model: "cache-model",
			usage: { ...EMPTY_USAGE, input: 1 },
			stopReason: toolTurn ? "toolUse" : "stop",
			timestamp: request + 1,
		};
		append(assistant);
		if (toolTurn) {
			append({
				role: "toolResult",
				toolCallId: `call-${request}`,
				toolName: name,
				content: [{ type: "text", text: "result ".repeat(Math.floor((tokens * 4) / 7)) }],
				isError: false,
				timestamp: request + 1,
			});
			tools++;
		} else {
			append({ role: "user", content: "Continue.", timestamp: request + 1 });
		}
	}
	return entries;
}
