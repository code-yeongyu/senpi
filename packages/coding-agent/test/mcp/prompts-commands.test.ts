// MCP prompts → slash commands (todo 40): every listed prompt registers as
// /mcp:<server>:<prompt>; invoking collects declared arguments via ctx.ui and
// injects the prompts/get messages into the input editor; a missing required
// argument aborts with a notice instead of calling the server.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createMcpPromptCommandSync,
	type McpPromptServer,
	registerMcpPromptCommands,
	resetMcpPromptCommandsForTests,
} from "../../src/core/extensions/builtin/mcp/prompts.ts";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import { attach, awaitMcpPromptRegistration, capturingPi, mcpRoot as makeMcpRoot } from "./fixtures/register-call.ts";
import { cleanupRoots, setConfig, stdioServer, type TestRoot } from "./fixtures/service-lifecycle.ts";

const cleanupTasks: Array<() => Promise<void>> = [];

beforeEach(() => {
	resetMcpServiceForTests();
	resetMcpPromptCommandsForTests();
});

afterEach(async () => {
	await getMcpService().dispose("quit");
	resetMcpServiceForTests();
	await cleanupRoots(cleanupTasks);
});

function mcpRoot(slug: string): TestRoot {
	return makeMcpRoot(slug, cleanupTasks);
}

interface FakeCommand {
	description?: string;
	handler: (args: string, ctx: never) => Promise<void>;
}

function commandRecorder(): {
	commands: Map<string, FakeCommand>;
	registerCommand: (name: string, options: FakeCommand) => void;
} {
	const commands = new Map<string, FakeCommand>();
	return { commands, registerCommand: (name, options) => commands.set(name, options) };
}

function fakeCommandCtx(answers: Array<string | undefined>) {
	const notices: string[] = [];
	let editorText = "";
	return {
		ctx: {
			ui: {
				input: async () => answers.shift(),
				notify: (message: string) => {
					notices.push(message);
				},
				setEditorText: (text: string) => {
					editorText = text;
				},
			},
		} as never,
		getEditorText: () => editorText,
		notices,
	};
}

function promptServer(server: string, prompts: McpPromptServer["prompts"], calls: unknown[]): McpPromptServer {
	return {
		server,
		prompts,
		connection: {
			client: {
				getPrompt: async (request: unknown) => {
					calls.push(request);
					return { messages: [{ role: "user", content: { type: "text", text: "from server" } }] };
				},
			},
		},
	} as never;
}

/** The service surface prompt commands use: the live catalog, its change signal and the registered-name set. */
function fakePromptRegistry(servers: () => readonly McpPromptServer[]) {
	const names = new Set<string>();
	const listeners = new Set<() => void>();
	return {
		service: {
			getMcpPromptServers: servers,
			onMcpRegistrationChanged: (listener: () => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			isMcpPromptCommandRegistered: (name: string) => names.has(name),
			markMcpPromptCommandRegistered: (name: string) => names.add(name),
		} as never,
		catalogChanged: () => {
			for (const listener of [...listeners]) listener();
		},
		listeners: () => listeners.size,
	};
}

// senpi#7249: prompt commands follow the server's live prompt catalog after attach.
describe("mcp prompt commands follow the live catalog", () => {
	it("registers a prompt that appears in a later catalog generation, and stops listening on dispose", () => {
		let catalog: readonly McpPromptServer[] = [];
		const registry = fakePromptRegistry(() => catalog);
		const recorder = commandRecorder();

		const sync = createMcpPromptCommandSync(registry.service, recorder as never, true);
		sync.register();
		expect([...recorder.commands.keys()]).toEqual([]);

		catalog = [promptServer("fx", [{ name: "late", arguments: [] }], [])];
		registry.catalogChanged();
		expect([...recorder.commands.keys()]).toEqual(["mcp:fx:late"]);

		sync.dispose();
		expect(registry.listeners()).toBe(0);
	});

	it("invokes the prompt with the arguments the server declares now, not those at registration", async () => {
		const before: unknown[] = [];
		const after: unknown[] = [];
		let catalog: readonly McpPromptServer[] = [
			promptServer("fx", [{ name: "brief", arguments: [{ name: "name", required: true }] }], before),
		];
		const registry = fakePromptRegistry(() => catalog);
		const recorder = commandRecorder();
		const sync = createMcpPromptCommandSync(registry.service, recorder as never, true);
		sync.register();

		catalog = [promptServer("fx", [{ name: "brief", arguments: [{ name: "topic", required: true }] }], after)];
		registry.catalogChanged();
		const run = fakeCommandCtx(["tests"]);
		await recorder.commands.get("mcp:fx:brief")?.handler("", run.ctx);

		expect(before).toEqual([]);
		expect(after).toEqual([{ arguments: { topic: "tests" }, name: "brief" }]);
		expect(run.getEditorText()).toBe("from server");
	});

	it("reports a prompt the server no longer offers instead of calling it", async () => {
		const calls: unknown[] = [];
		let catalog: readonly McpPromptServer[] = [promptServer("fx", [{ name: "gone", arguments: [] }], calls)];
		const registry = fakePromptRegistry(() => catalog);
		const recorder = commandRecorder();
		createMcpPromptCommandSync(registry.service, recorder as never, true).register();

		catalog = [];
		registry.catalogChanged();
		const run = fakeCommandCtx([]);
		await recorder.commands.get("mcp:fx:gone")?.handler("", run.ctx);

		expect(calls).toEqual([]);
		expect(run.notices).toEqual(["MCP prompt gone is no longer offered by fx."]);
	});
});

describe("mcp prompts as slash commands", () => {
	it("registers /mcp:<server>:<prompt> and injects prompts/get output into the editor", async () => {
		const root = mcpRoot("prompts-live");
		setConfig(root, { fx: stdioServer(["--tools", "1"]) });
		const pi = capturingPi();
		const promptRegistration = awaitMcpPromptRegistration("fx", "fixture_prompt");
		await attach(root, pi);
		await promptRegistration;

		const recorder = commandRecorder();
		const added = registerMcpPromptCommands(recorder as never, getMcpService().getMcpPromptServers());
		expect(added).toEqual(["mcp:fx:fixture_prompt"]);

		const command = recorder.commands.get("mcp:fx:fixture_prompt");
		expect(command?.description).toContain("Fixture prompt");

		const happy = fakeCommandCtx(["World"]);
		await command?.handler("", happy.ctx);
		expect(happy.getEditorText()).toBe("Hello World");

		const aborted = fakeCommandCtx([undefined]);
		await command?.handler("", aborted.ctx);
		expect(aborted.getEditorText()).toBe("");
		expect(aborted.notices[0]).toContain("required argument 'name'");
	});
});
