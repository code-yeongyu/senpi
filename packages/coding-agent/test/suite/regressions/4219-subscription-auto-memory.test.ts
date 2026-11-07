import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { createAttemptMessages } from "../../../src/core/extensions/builtin/anthropic-subscription/auth-attempt.ts";
import type {
	Options,
	SdkQueryHandle,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { loadAnthropicSubscriptionProviderSettings } from "../../../src/core/extensions/builtin/anthropic-subscription/settings.ts";
import { InMemorySettingsStorage, SettingsManager } from "../../../src/core/settings-manager.ts";

const sentinel = "FOREIGN_AUTO_MEMORY_4219_MUST_NOT_ENTER_THE_SESSION";
const reply = [
	[
		"message_start",
		{
			type: "message_start",
			message: {
				id: "memory-probe",
				type: "message",
				role: "assistant",
				model: "mock",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 1 },
			},
		},
	],
	["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
	["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }],
	["content_block_stop", { type: "content_block_stop", index: 0 }],
	[
		"message_delta",
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
	],
	["message_stop", { type: "message_stop" }],
]
	.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
	.join("");

// Public SDK isolation contract: real Claude Code memory must not reach the local model endpoint.
// A fake SDK cannot prove this: settingSources does not control the SDK's memory loader.
describe("senpi#4219 / omo#11189: subscription auto-memory is permanently off", () => {
	it.each(["resident", "auxiliary"] as const)(
		"excludes a real memory index from the %s SDK prompt despite explicit enable overrides",
		async (dispatch) => {
			const root = mkdtempSync(join(tmpdir(), "senpi-auto-memory-"));
			const cwd = join(root, "project");
			const memory = join(root, "memory");
			mkdirSync(join(cwd, ".git"), { recursive: true });
			mkdirSync(memory);
			const memoryFile = join(memory, "MEMORY.md");
			writeFileSync(memoryFile, sentinel);
			const requests: string[] = [];
			const server = createServer((request, response) => {
				if (request.method !== "POST" || !request.url?.startsWith("/v1/messages")) {
					response.writeHead(200, { "content-type": "application/json" }).end("{}");
					return;
				}
				let body = "";
				request.setEncoding("utf8");
				request.on("data", (chunk: string) => {
					body += chunk;
				});
				request.on("end", () => {
					requests.push(body);
					response.writeHead(200, { "content-type": "text/event-stream" }).end(reply);
				});
			});
			let handle: SdkQueryHandle | undefined;
			let received: Options | undefined;
			try {
				await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
				const address = server.address();
				if (!address || typeof address === "string") throw new Error("missing local probe address");
				const options: Options = {
					cwd,
					model: "claude-sonnet-4-6",
					settingSources: [],
					tools: [],
					maxTurns: 1,
					persistSession: false,
					abortController: new AbortController(),
					settings: { autoMemoryEnabled: true, autoMemoryDirectory: memory },
					env: {
						PATH: process.env.PATH ?? "",
						HOME: join(root, "home"),
						TMPDIR: root,
						CLAUDE_CONFIG_DIR: join(root, "claude"),
						ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
						ANTHROPIC_API_KEY: "local-memory-probe",
						CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
						CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0",
					},
				};
				const launch = (sdkOptions: Options) => {
					received = sdkOptions;
					handle = query({ prompt: "Reply done.", options: sdkOptions });
					return handle;
				};
				const messages = await createAttemptMessages(
					{
						prompt: "Reply done.",
						query: ({ options: sdkOptions }) => launch(sdkOptions ?? {}),
						...(dispatch === "resident"
							? {
									createAttempt: (auth) => ({
										messages: launch(auth.options),
										discard: () => handle?.close(),
									}),
								}
							: {}),
					},
					{ accountName: "ambient", accounts: [], authLane: "ambient", options },
				);
				for await (const _message of messages) {
					/* Drain the real SDK turn. */
				}
				expect(requests.length).toBeGreaterThan(0);
				expect(requests.join("\n")).not.toContain(sentinel);
				expect(received?.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
				expect(received?.settings).toMatchObject({ autoMemoryEnabled: false, autoMemoryDirectory: memory });
				expect(readFileSync(memoryFile, "utf8")).toBe(sentinel);
			} finally {
				handle?.close();
				server.closeAllConnections();
				await new Promise<void>((resolve) => server.close(() => resolve()));
				rmSync(root, { recursive: true, force: true });
			}
		},
		60_000,
	);

	it("does not expose an auto-memory provider configuration or environment switch", () => {
		const storage = new InMemorySettingsStorage();
		for (const scope of ["global", "project"] as const) {
			storage.withLock(scope, () =>
				JSON.stringify({
					anthropicSubscriptionProvider: {
						autoMemory: true,
						autoMemoryEnabled: true,
						disableAutoMemory: false,
					},
				}),
			);
		}
		expect(
			loadAnthropicSubscriptionProviderSettings(SettingsManager.fromStorage(storage), {
				SENPI_CLAUDE_SDK_OAUTH_AUTO_MEMORY: "1",
				SENPI_CLAUDE_SDK_OAUTH_AUTO_MEMORY_ENABLED: "1",
				CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0",
			}),
		).toEqual({});
	});
});
