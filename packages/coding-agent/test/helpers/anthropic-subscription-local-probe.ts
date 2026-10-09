// Reusable local-endpoint probe for the installed Anthropic Subscription.
// Serves an ephemeral Anthropic-shaped SSE endpoint on 127.0.0.1 and runs one
// SDK turn with hermetic env (temp HOME/CLAUDE_CONFIG_DIR, no inherited
// proxy/cloud/provider-routing variables), recording every observable fact the
// regression assertions need. Probe owns its temp artifacts through try/finally.
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { HOST_TOOL_DENIAL_HOOKS } from "../../src/core/extensions/builtin/anthropic-subscription/tools.ts";

export type LocalSdkTurnObservation = {
	providerRequests: number;
	providerSawToolResult: boolean;
	partialToolUseName: string | null;
	finalizedToolUseName: string | null;
	// All emitted user-message tool_result blocks, and how many of them are real
	// executions (is_error !== true). A hook-stopped turn still emits one denial
	// tool_result carrying non_execution_kind permission-rule and is_error true;
	// only real executions count against the zero-execution invariant.
	toolResults: number;
	executedToolResults: number;
	permissionPrompts: number;
	customHandlerRuns: number;
	markerExists: boolean;
	terminalReason: string | null;
	resultSubtype: string | null;
};

function sse(events: Array<[string, unknown]>): string {
	return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

function messageStart(id: string, inputTokens: number): [string, unknown] {
	return [
		"message_start",
		{
			type: "message_start",
			message: {
				id,
				type: "message",
				role: "assistant",
				model: "mock",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: inputTokens, output_tokens: 1 },
			},
		},
	];
}

function toolUseTurn(toolName: string, inputJson: string): string {
	return sse([
		messageStart("msg_probe", 10),
		[
			"content_block_start",
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "toolu_1", name: toolName, input: {} },
			},
		],
		[
			"content_block_delta",
			{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: inputJson } },
		],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		[
			"message_delta",
			{
				type: "message_delta",
				delta: { stop_reason: "tool_use", stop_sequence: null },
				usage: { output_tokens: 4 },
			},
		],
		["message_stop", { type: "message_stop" }],
	]);
}

const endTurn = sse([
	messageStart("msg_probe_end", 20),
	["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
	["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }],
	["content_block_stop", { type: "content_block_stop", index: 0 }],
	[
		"message_delta",
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
	],
	["message_stop", { type: "message_stop" }],
]);

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

export async function runInstalledSdkLocalTurn(toolName: string): Promise<LocalSdkTurnObservation> {
	const tmpDir = await mkdtemp(join(tmpdir(), "senpi-494-"));
	const markerPath = join(tmpDir, "hook-stop-marker.txt");
	const toolInput = JSON.stringify(toolName === "Bash" ? { command: `echo hi > "${markerPath}"` } : {});
	const requestBodies: string[] = [];
	const server = createServer((req, res) => {
		if (req.method === "POST" && req.url?.startsWith("/v1/messages")) {
			let body = "";
			req.on("data", (chunk: Buffer) => {
				body += chunk.toString("utf8");
			});
			req.on("end", () => {
				requestBodies.push(body);
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end(requestBodies.length === 1 ? toolUseTurn(toolName, toolInput) : endTurn);
			});
			return;
		}
		res.writeHead(200, { "content-type": "application/json" }).end("{}");
	});
	try {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		let permissionPrompts = 0;
		let customHandlerRuns = 0;
		let partialToolUseName: string | null = null;
		let finalizedToolUseName: string | null = null;
		let toolResults = 0;
		let executedToolResults = 0;
		let terminalReason: string | null = null;
		let resultSubtype: string | null = null;
		const stream = query({
			prompt: "Call the requested tool exactly once, then stop.",
			options: {
				cwd: tmpDir,
				model: "opus",
				hooks: HOST_TOOL_DENIAL_HOOKS,
				// Mirrors the production adapter: custom Pi tools are exposed through an
				// in-process SDK MCP server, so PreToolUse hooks match mcp__custom-tools__*.
				mcpServers: {
					"custom-tools": createSdkMcpServer({
						name: "custom-tools",
						tools: [
							tool("eval", "regression probe custom tool", {}, async () => {
								customHandlerRuns++;
								return { content: [{ type: "text" as const, text: "ok" }] };
							}),
						],
					}),
				},
				// Production mode: deny-by-default with no prompts. canUseTool must stay
				// uncalled because the PreToolUse hook terminates the turn first.
				permissionMode: "dontAsk",
				settingSources: [],
				maxTurns: 5,
				includePartialMessages: true,
				canUseTool: async () => {
					permissionPrompts++;
					return { behavior: "allow", updatedInput: {} };
				},
				// Hermetic child environment: no inherited proxy, cloud, or
				// provider-routing variables; only what the CLI needs to boot.
				env: {
					PATH: process.env.PATH ?? "",
					TMPDIR: tmpDir,
					HOME: join(tmpDir, "home"),
					CLAUDE_CONFIG_DIR: join(tmpDir, "claude-config"),
					ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
					ANTHROPIC_API_KEY: "regression-probe-key",
					CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
				},
			},
		});
		for await (const message of stream) {
			if (message.type === "stream_event") {
				const { event } = message;
				if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
					partialToolUseName = event.content_block.name;
				}
			}
			if (message.type === "assistant") {
				for (const block of message.message.content) {
					if (block.type === "tool_use") finalizedToolUseName = block.name;
				}
			}
			if (message.type === "user") {
				const content = message.message.content;
				if (Array.isArray(content)) {
					for (const block of content) {
						if (block.type === "tool_result") {
							toolResults++;
							if (block.is_error !== true) executedToolResults++;
						}
					}
				}
			}
			if (message.type === "result") {
				resultSubtype = message.subtype;
				terminalReason = message.terminal_reason ?? null;
			}
		}
		return {
			providerRequests: requestBodies.length,
			providerSawToolResult: requestBodies.some((body) => body.includes('"type":"tool_result"')),
			partialToolUseName,
			finalizedToolUseName,
			toolResults,
			executedToolResults,
			permissionPrompts,
			customHandlerRuns,
			markerExists: existsSync(markerPath),
			terminalReason,
			resultSubtype,
		};
	} finally {
		await closeServer(server);
		await rm(tmpDir, { recursive: true, force: true });
	}
}
