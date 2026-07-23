import { existsSync } from "node:fs";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigReloadHandoffRegistry } from "../src/core/extensions/builtin/config-reload/index.ts";
import { configureMcpElicitation } from "../src/core/extensions/builtin/mcp/elicitation.ts";
import { applyMcpOutputGuard } from "../src/core/extensions/builtin/mcp/guard/output-guard.ts";
import { registerMcpPromptCommands } from "../src/core/extensions/builtin/mcp/prompts.ts";
import { McpService } from "../src/core/extensions/builtin/mcp/service.ts";
import { clearConfigValueCache, resolveConfigValue } from "../src/core/resolve-config-value.ts";
import { capturingPi } from "./mcp/fixtures/register-call.ts";
import { cleanupRoots, makeRoot, setConfig, stdioServer } from "./mcp/fixtures/service-lifecycle.ts";

const cleanupTasks: Array<() => Promise<void>> = [];
const services: McpService[] = [];

afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.dispose("quit")));
	await cleanupRoots(cleanupTasks);
	clearConfigValueCache();
});

function createService(): McpService {
	const service = new McpService();
	services.push(service);
	return service;
}

function commandRecorder() {
	const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
	return {
		commands,
		registerCommand: (name: string, command: { handler: (args: string, ctx: never) => Promise<void> }) =>
			commands.set(name, command),
	};
}

async function waitForConnection(service: McpService, name: string): Promise<void> {
	const connection = service.getConnection(name);
	if (!connection) throw new Error(`missing ${name} connection`);
	if (connection.state === "connected") return;
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(`${name} did not connect`)), 10_000);
		const unsubscribe = connection.onStateChange((event) => {
			if (event.state !== "connected") return;
			clearTimeout(timeout);
			unsubscribe();
			resolve();
		});
	});
}

function spilledPath(result: readonly { type: string; text?: string }[]): string {
	const text = result[0]?.text ?? "";
	const match = /Full output saved to: (.+)/.exec(text);
	if (!match?.[1]) throw new Error("expected spill path");
	return match[1];
}

describe("MCP session isolation", () => {
	it("keeps B's connection, prompts, and elicitation alive when A closes", async () => {
		const rootA = makeRoot("session-a", cleanupTasks);
		const rootB = makeRoot("session-b", cleanupTasks);
		setConfig(rootA, { shared: { ...stdioServer(["--tools", "1"]), lifecycle: "eager" } });
		setConfig(rootB, { shared: { ...stdioServer(["--tools", "2"]), lifecycle: "eager" } });
		const alpha = createService();
		const bravo = createService();
		const piA = capturingPi();
		const piB = capturingPi();

		await alpha.attachSession(
			{ type: "session_start", reason: "startup" },
			{ cwd: rootA.cwd, isProjectTrusted: () => true },
			piA,
			{
				agentDir: rootA.agentDir,
			},
		);
		await bravo.attachSession(
			{ type: "session_start", reason: "startup" },
			{ cwd: rootB.cwd, isProjectTrusted: () => true },
			piB,
			{
				agentDir: rootB.agentDir,
			},
		);
		await waitForConnection(alpha, "shared");
		await waitForConnection(bravo, "shared");

		const sharedPromptServer = {
			connection: {
				client: {
					getPrompt: async ({ arguments: args }: { arguments?: Record<string, string> }) => ({
						messages: [{ content: { text: `Hello ${args?.name ?? ""}`, type: "text" }, role: "user" }],
					}),
				},
			},
			prompts: [{ arguments: [{ name: "name", required: true }], name: "fixture_prompt" }],
			server: "shared",
		};
		const alphaRecorder = commandRecorder();
		registerMcpPromptCommands(alpha, alphaRecorder as never, [sharedPromptServer] as never);
		const recorder = commandRecorder();
		registerMcpPromptCommands(bravo, recorder as never, [sharedPromptServer] as never);
		const prompt = recorder.commands.get("mcp:shared:fixture_prompt");
		expect(prompt).toBeDefined();

		bravo.setMcpElicitationUiProvider(() => ({ input: async () => "from-b" }) as never);
		let elicitationHandler:
			| ((request: { params: Record<string, unknown> }) => Promise<{ action: string }>)
			| undefined;
		const client = {
			setRequestHandler: (_schema: unknown, handler: typeof elicitationHandler) => {
				elicitationHandler = handler;
			},
		} as unknown as Client;
		configureMcpElicitation(client, bravo);

		await alpha.dispose("quit");
		expect(bravo.getConnection("shared")?.state).toBe("connected");
		let editorText = "";
		await prompt?.handler("", {
			ui: {
				input: async () => "B",
				notify: () => {},
				setEditorText: (text: string) => {
					editorText = text;
				},
			},
		} as never);
		expect(editorText).toBe("Hello B");
		const elicitation = await elicitationHandler?.({
			params: { message: "B asks", requestedSchema: { properties: { value: { type: "string" } } } },
		});
		expect(elicitation).toMatchObject({ action: "accept", content: { value: "from-b" } });
	});

	it("keys reload handoffs, OAuth guards, and artifacts by session", async () => {
		const handoffs = new ConfigReloadHandoffRegistry<string>();
		const [aHandoff, bHandoff] = await Promise.all([
			Promise.resolve().then(() => {
				handoffs.set("A", "handoff-a");
				return handoffs.take("A");
			}),
			Promise.resolve().then(() => {
				handoffs.set("B", "handoff-b");
				return handoffs.take("B");
			}),
		]);
		expect(aHandoff).toBe("handoff-a");
		expect(bHandoff).toBe("handoff-b");

		const alpha = createService();
		const bravo = createService();
		expect(alpha.beginInteractiveAuth("shared")).toBe(true);
		expect(bravo.beginInteractiveAuth("shared")).toBe(true);
		expect(alpha.beginInteractiveAuth("shared")).toBe(false);
		alpha.endInteractiveAuth("shared");
		bravo.endInteractiveAuth("shared");

		const rootA = makeRoot("artifacts-a", cleanupTasks);
		const rootB = makeRoot("artifacts-b", cleanupTasks);
		const huge = "x".repeat(60_000);
		const aPath = spilledPath(
			await applyMcpOutputGuard([{ type: "text", text: huge }], {
				agentDir: rootA.agentDir,
				artifacts: alpha.getMcpOutputArtifacts(),
				server: "shared",
			}),
		);
		const bPath = spilledPath(
			await applyMcpOutputGuard([{ type: "text", text: huge }], {
				agentDir: rootB.agentDir,
				artifacts: bravo.getMcpOutputArtifacts(),
				server: "shared",
			}),
		);
		await alpha.dispose("quit");
		expect(existsSync(aPath)).toBe(false);
		expect(existsSync(bPath)).toBe(true);
	});

	it("does not cache command results across explicit session environments", () => {
		const command = '!printf "$MCP_SESSION_VALUE"';
		expect(resolveConfigValue(command, { MCP_SESSION_VALUE: "A" })).toBe("A");
		expect(resolveConfigValue(command, { MCP_SESSION_VALUE: "B" })).toBe("B");
	});
});
