export function permissionMetadataAgentScript(rejectionMarker: string): string {
	return `
		import { writeFileSync } from "node:fs";
		import { createInterface } from "node:readline";
		const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
		let promptId;
		const lines = createInterface({ input: process.stdin });
		lines.on("line", (line) => {
			const message = JSON.parse(line);
			if (message.method === "initialize") {
				send({
					jsonrpc: "2.0",
					id: message.id,
					result: {
						protocolVersion: 1,
						agentCapabilities: { loadSession: false },
						authMethods: [],
					},
				});
				return;
			}
			if (message.method === "session/new") {
				send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "permission-session" } });
				return;
			}
			if (message.method === "session/prompt") {
				promptId = message.id;
				send({
					jsonrpc: "2.0",
					method: "session/update",
					params: {
						sessionId: "permission-session",
						update: {
							sessionUpdate: "tool_call",
							toolCallId: "tool-1",
							title: "Write",
							kind: "edit",
							status: "pending",
						},
					},
				});
				send({
					jsonrpc: "2.0",
					method: "session/update",
					params: {
						sessionId: "permission-session",
						update: {
							sessionUpdate: "tool_call_update",
							toolCallId: "tool-1",
							content: [{
								type: "content",
								content: { type: "text", text: "{\\"path\\":\\"proof.txt\\",\\"content\\":\\"blocked\\"}" },
							}],
						},
					},
				});
				send({
					jsonrpc: "2.0",
					id: 99,
					method: "session/request_permission",
					params: {
						sessionId: "permission-session",
						options: [
							{ optionId: "allow", name: "Allow", kind: "allow_once" },
							{ optionId: "reject", name: "Reject", kind: "reject_once" },
						],
						toolCall: { toolCallId: "tool-1", title: "Write" },
					},
				});
				return;
			}
			if (message.id === 99) {
				if (message.result?.outcome?.optionId === "reject") {
					writeFileSync(${JSON.stringify(rejectionMarker)}, "rejected");
				}
				send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
			}
		});
	`;
}

export function streamingAgentScript(completionMarker: string): string {
	return `
		import { writeFileSync } from "node:fs";
		import { createInterface } from "node:readline";
		const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
		const lines = createInterface({ input: process.stdin });
		lines.on("line", (line) => {
			const message = JSON.parse(line);
			if (message.method === "initialize") {
				send({
					jsonrpc: "2.0",
					id: message.id,
					result: {
						protocolVersion: 1,
						agentCapabilities: { loadSession: false },
						authMethods: [],
					},
				});
				return;
			}
			if (message.method === "session/new") {
				send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "stream-session" } });
				return;
			}
			if (message.method === "session/prompt") {
				send({
					jsonrpc: "2.0",
					method: "session/update",
					params: {
						sessionId: "stream-session",
						update: {
							sessionUpdate: "agent_message_chunk",
							content: { type: "text", text: "first" },
						},
					},
				});
				setTimeout(() => {
					writeFileSync(${JSON.stringify(completionMarker)}, "done");
					send({
						jsonrpc: "2.0",
						method: "session/update",
						params: {
							sessionId: "stream-session",
							update: {
								sessionUpdate: "agent_message_chunk",
								content: { type: "text", text: "second" },
							},
						},
					});
					send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
				}, 100);
			}
		});
	`;
}
