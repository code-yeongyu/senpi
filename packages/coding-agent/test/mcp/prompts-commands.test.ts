// MCP prompts → slash commands (todo 40): every listed prompt registers as
// /mcp:<server>:<prompt>; invoking collects declared arguments via ctx.ui and
// injects the prompts/get messages into the input editor; a missing required
// argument aborts with a notice instead of calling the server.

import { type AutocompleteProvider, CombinedAutocompleteProvider, Editor, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mcpPromptAutocomplete } from "../../src/core/extensions/builtin/mcp/prompt-autocomplete.ts";
import {
	createMcpPromptCommandSync,
	type McpPromptServer,
	registeredMcpPromptCommands,
	registerMcpPromptCommands,
} from "../../src/core/extensions/builtin/mcp/prompts.ts";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import { attach, awaitMcpPromptRegistration, capturingPi, mcpRoot as makeMcpRoot } from "./fixtures/register-call.ts";
import { defaultEditorTheme } from "../../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { cleanupRoots, setConfig, stdioServer, type TestRoot } from "./fixtures/service-lifecycle.ts";

const cleanupTasks: Array<() => Promise<void>> = [];

beforeEach(() => {
	resetMcpServiceForTests();
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

/** Records every registerCommand call, so a repeated registration is visible rather than overwritten. */
function commandRecorder(): {
	commands: Map<string, FakeCommand>;
	calls: string[];
	registerCommand: (name: string, options: FakeCommand) => void;
} {
	const commands = new Map<string, FakeCommand>();
	const calls: string[] = [];
	return {
		commands,
		calls,
		registerCommand: (name, options) => {
			calls.push(name);
			commands.set(name, options);
		},
	};
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

/** The service surface prompt commands use: the live catalog and its change signal. */
function fakePromptRegistry(servers: () => readonly McpPromptServer[]) {
	const listeners = new Set<() => void>();
	return {
		service: {
			getMcpPromptServers: servers,
			onMcpRegistrationChanged: (listener: () => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
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

		const sync = createMcpPromptCommandSync(registry.service, recorder as never);
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
		const sync = createMcpPromptCommandSync(registry.service, recorder as never);
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
		createMcpPromptCommandSync(registry.service, recorder as never).register();

		catalog = [];
		registry.catalogChanged();
		const run = fakeCommandCtx([]);
		await recorder.commands.get("mcp:fx:gone")?.handler("", run.ctx);

		expect(calls).toEqual([]);
		expect(run.notices).toEqual(["MCP prompt gone is no longer offered by fx."]);
	});
});

// senpi#7249 review: dedup belongs to the registrar, not the process or the shared service.
describe("mcp prompt commands per registrar", () => {
	it("gives each of two runners on one shared service the same prompt, including a late one", () => {
		let catalog: readonly McpPromptServer[] = [promptServer("fx", [{ name: "early", arguments: [] }], [])];
		const registry = fakePromptRegistry(() => catalog);
		const first = commandRecorder();
		const second = commandRecorder();
		createMcpPromptCommandSync(registry.service, first as never).register();
		createMcpPromptCommandSync(registry.service, second as never).register();

		catalog = [
			promptServer(
				"fx",
				[
					{ name: "early", arguments: [] },
					{ name: "late", arguments: [] },
				],
				[],
			),
		];
		registry.catalogChanged();
		registry.catalogChanged();

		expect(first.calls).toEqual(["mcp:fx:early", "mcp:fx:late"]);
		expect(second.calls).toEqual(["mcp:fx:early", "mcp:fx:late"]);
	});

	it("registers the prompts again into a replacement runner after reload", () => {
		const catalog: readonly McpPromptServer[] = [promptServer("fx", [{ name: "kept", arguments: [] }], [])];
		const registry = fakePromptRegistry(() => catalog);
		const original = commandRecorder();
		const originalSync = createMcpPromptCommandSync(registry.service, original as never);
		originalSync.register();
		originalSync.dispose();

		const replacement = commandRecorder();
		createMcpPromptCommandSync(registry.service, replacement as never).register();
		registry.catalogChanged();

		expect(original.calls).toEqual(["mcp:fx:kept"]);
		expect(replacement.calls).toEqual(["mcp:fx:kept"]);
		expect(registry.listeners()).toBe(1);
	});
});

// senpi#7249 review: the TUI autocomplete snapshot misses prompts registered after it was built.
describe("mcp prompt commands in TUI slash completion", () => {
	it("suggests a prompt registered after the autocomplete snapshot and completes it", async () => {
		let catalog: readonly McpPromptServer[] = [];
		const registry = fakePromptRegistry(() => catalog);
		const recorder = commandRecorder();
		createMcpPromptCommandSync(registry.service, recorder as never).register();
		const snapshot = new CombinedAutocompleteProvider([{ name: "help", description: "Help" }], process.cwd());
		const provider = mcpPromptAutocomplete(() => registeredMcpPromptCommands(recorder as never))(snapshot);

		catalog = [promptServer("fx", [{ name: "late", description: "Late prompt", arguments: [] }], [])];
		registry.catalogChanged();
		const lines = ["/mcp:fx"];
		const suggestions = await provider.getSuggestions(lines, 0, 7, { signal: new AbortController().signal });

		expect(suggestions?.items.map((item) => item.value)).toEqual(["mcp:fx:late"]);
		const late = suggestions?.items[0];
		expect(late && provider.applyCompletion(lines, 0, 7, late, suggestions.prefix).lines).toEqual(["/mcp:fx:late "]);
	});

	it("puts a late exact match first and keeps the snapshot order otherwise", async () => {
		const recorder = commandRecorder();
		const snapshot = new CombinedAutocompleteProvider(
			[
				{ name: "mcp:fx:late-extra", description: "longer" },
				{ name: "mcp:fx:alpha", description: "a" },
			],
			process.cwd(),
		);
		const wrap = mcpPromptAutocomplete(() => registeredMcpPromptCommands(recorder as never));
		const provider = wrap(wrap(snapshot));
		const signal = new AbortController().signal;
		const before = await snapshot.getSuggestions(["/mcp:fx"], 0, 7, { signal });
		registerMcpPromptCommands(recorder as never, [promptServer("fx", [{ name: "late", arguments: [] }], [])]);

		const exact = await provider.getSuggestions(["/mcp:fx:late"], 0, 12, { signal });
		const partial = await provider.getSuggestions(["/mcp:fx"], 0, 7, { signal });

		expect(exact?.items.map((item) => item.value)).toEqual(["mcp:fx:late", "mcp:fx:late-extra"]);
		expect(partial?.items.map((item) => item.value)).toEqual([
			...(before?.items.map((item) => item.value) ?? []),
			"mcp:fx:late",
		]);
	});

	it("submits the late exact prompt, not a longer snapshot command, when Enter accepts the first row", async () => {
		const recorder = commandRecorder();
		const snapshot = new CombinedAutocompleteProvider(
			[{ name: "mcp:fx:late-extra", description: "longer" }],
			process.cwd(),
		);
		registerMcpPromptCommands(recorder as never, [promptServer("fx", [{ name: "late", arguments: [] }], [])]);
		const wrapped = mcpPromptAutocomplete(() => registeredMcpPromptCommands(recorder as never))(snapshot);
		let settle: (() => void) | undefined;
		const observed: AutocompleteProvider = {
			...wrapped,
			async getSuggestions(...args) {
				const result = await wrapped.getSuggestions(...args);
				if (result?.items[0]?.value === "mcp:fx:late") settle?.();
				return result;
			},
		};
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
		editor.setAutocompleteProvider(observed);
		const submitted: string[] = [];
		editor.onSubmit = (text) => submitted.push(text);
		const shown = new Promise<void>((resolve, reject) => {
			settle = resolve;
			setTimeout(() => reject(new Error("editor never listed the exact prompt first")), 2000);
		});

		editor.handleInput("/mcp:fx:late");
		await shown;
		await Promise.resolve();
		expect(editor.isShowingAutocomplete()).toBe(true);
		editor.handleInput("\r");

		expect(submitted.map((text) => text.trim())).toEqual(["/mcp:fx:late"]);
	});

	it("adds nothing the snapshot already lists, so a stacked wrapper does not duplicate", async () => {
		const recorder = commandRecorder();
		registerMcpPromptCommands(recorder as never, [promptServer("fx", [{ name: "known", arguments: [] }], [])]);
		const snapshot = new CombinedAutocompleteProvider([{ name: "mcp:fx:known", description: "x" }], process.cwd());
		const wrap = mcpPromptAutocomplete(() => registeredMcpPromptCommands(recorder as never));
		const provider = wrap(wrap(snapshot));

		const suggestions = await provider.getSuggestions(["/mcp:"], 0, 5, { signal: new AbortController().signal });

		expect(suggestions?.items.map((item) => item.value)).toEqual(["mcp:fx:known"]);
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
