import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { createEventBus } from "../../src/core/event-bus.ts";
import mcpExtension from "../../src/core/extensions/builtin/mcp/index.ts";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../../src/core/extensions/runner.ts";
import type {
	Extension,
	ExtensionCommandContext,
	ExtensionUIContext,
	SessionStartEvent,
} from "../../src/core/extensions/types.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { theme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "../suite/harness.ts";
import { toolResultTexts } from "./fixtures/register-call.ts";
import { cleanupRoots, makeRoot, setConfig, stdioServer, type TestRoot } from "./fixtures/service-lifecycle.ts";
import { stdioFixtureCommand } from "./fixtures/spawn-fixture.ts";

const cleanupTasks: Array<() => Promise<void>> = [];
const harnesses: Harness[] = [];
const originalAgentDir = process.env[ENV_AGENT_DIR];

beforeEach(() => {
	resetMcpServiceForTests();
});

afterEach(async () => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	await getMcpService().dispose("quit");
	resetMcpServiceForTests();
	if (originalAgentDir === undefined) {
		delete process.env[ENV_AGENT_DIR];
	} else {
		process.env[ENV_AGENT_DIR] = originalAgentDir;
	}
	await cleanupRoots(cleanupTasks);
});

describe("/mcp command suite", () => {
	it("registers one /mcp command without colliding with other command names", async () => {
		const extension = await loadMcpExtension();

		expect([...extension.commands.keys()]).toEqual(["mcp"]);
	});

	it("renders panel and status text from service snapshots", async () => {
		const root = makeCommandRoot("render");
		setConfig(root, {
			disabled: { ...stdioServer(["--tools", "1"]), enabled: false },
			fx: stdioServer(["--tools", "2"]),
		});
		const { command, extension } = await loadCommand();
		const ui = createUi({ selectResult: undefined });
		await emitSessionStart(extension, root);

		await command.handler("", createCtx(root, ui));
		await command.handler("status", createCtx(root, ui));

		expect(normalize(ui.selectCalls[0]?.title, root)).toMatchInlineSnapshot(`
			"MCP servers
			disabled disabled state=not_spawned source=<agentDir>/mcp.json tools=? uptime=n/a calls=0 errors=0 latency=0ms reconnects=0
			fx enabled state=connected source=<agentDir>/mcp.json tools=2 uptime=<1s calls=0 errors=0 latency=0ms reconnects=0"
		`);
		expect(normalize(lastNotification(ui)?.message, root)).toMatchInlineSnapshot(`
			"MCP status
			disabled disabled state=not_spawned source=<agentDir>/mcp.json tools=? uptime=n/a calls=0 errors=0 latency=0ms reconnects=0
			fx enabled state=connected source=<agentDir>/mcp.json tools=2 uptime=<1s calls=0 errors=0 latency=0ms reconnects=0"
		`);
	});

	it("round-trips /mcp add into global config after confirmation and aborts on cancel", async () => {
		const root = makeCommandRoot("add");
		const { command } = await loadCommand();
		const yesUi = createUi({ confirmResults: [true] });

		await command.handler("add docs https://example.test/mcp", createCtx(root, yesUi));

		const written = JSON.parse(readFileSync(join(root.agentDir, "mcp.json"), "utf8")) as {
			mcpServers?: Record<string, unknown>;
		};
		expect(written.mcpServers?.docs).toEqual({ type: "http", url: "https://example.test/mcp" });
		expect(lastNotification(yesUi)?.message).toBe("Added MCP server docs");

		const noUi = createUi({ confirmResults: [false] });
		await command.handler("add skipped node server.js", createCtx(root, noUi));

		const afterCancel = readFileSync(join(root.agentDir, "mcp.json"), "utf8");
		expect(afterCancel).toBe(`${JSON.stringify(written, null, 2)}\n`);
		expect(lastNotification(noUi)?.message).toBe("MCP add cancelled");
	});

	it("adds and refreshes provider-visible MCP tools from the /mcp add user command path", async () => {
		makeCommandRoot("add-active-tools");
		const providerToolNames: string[][] = [];
		const ui = createUi({ confirmResults: [true] });
		const harness = await createHarness({
			extensionFactories: [mcpExtension],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: ui, mode: "tui" });

		const fixture = stdioFixtureCommand();
		const addArgs = [fixture.command, ...fixture.args, "--tools", "2"].map((part) => JSON.stringify(part)).join(" ");
		await harness.session.prompt(`/mcp add fx ${addArgs}`);
		await harness.session.prompt("/mcp status");

		harness.setResponses([
			(context) => {
				providerToolNames.push((context.tools ?? []).map((toolInfo) => toolInfo.name).sort());
				return fauxAssistantMessage(fauxToolCall("mcp_fx_tool_2", { value: "added" }), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("call added MCP tool 2");

		expect(notification(ui, "Added MCP server fx")?.message).toBe("Added MCP server fx");
		expect(notification(ui, "MCP status")?.message).toContain("fx enabled state=connected");
		expect(providerToolNames[0]).toEqual(expect.arrayContaining(["mcp_fx_tool_1", "mcp_fx_tool_2"]));
		expect(toolResultTexts(harness, "mcp_fx_tool_2")).toEqual(["fixture tool_2 value=added mode=alpha"]);
	});

	it("enables, disables, tails logs, and returns helpful unknown-server errors", async () => {
		const root = makeCommandRoot("state");
		setConfig(root, { fx: stdioServer(["--tools", "1"]) });
		const { command, extension } = await loadCommand();
		const ui = createUi();
		await emitSessionStart(extension, root);

		await command.handler("disable fx", createCtx(root, ui));
		expect(JSON.parse(readFileSync(join(root.agentDir, "mcp.json"), "utf8")).mcpServers.fx.enabled).toBe(false);

		await command.handler("enable fx", createCtx(root, ui));
		expect(JSON.parse(readFileSync(join(root.agentDir, "mcp.json"), "utf8")).mcpServers.fx.enabled).toBe(true);

		await command.handler("logs fx", createCtx(root, ui));
		await command.handler("reconnect fx", createCtx(root, ui));
		await command.handler("test missing", createCtx(root, ui));

		expect(notification(ui, "Disabled MCP server fx")?.message).toBe("Disabled MCP server fx");
		expect(notification(ui, "Enabled MCP server fx")?.message).toBe("Enabled MCP server fx");
		expect(notification(ui, '"channel":"stderr"')?.message).toContain("stdio fixture ready");
		expect(notification(ui, "MCP reconnect for fx is not available until W2.")?.message).toBe(
			"MCP reconnect for fx is not available until W2.",
		);
		expect(notification(ui, "Unknown MCP server: missing")?.message).toBe(
			"Unknown MCP server: missing\nKnown MCP servers: fx",
		);
	});

	it("removes and refreshes provider-visible MCP tools when /mcp disables and enables a server", async () => {
		const root = makeCommandRoot("active-tools");
		setConfig(root, { fx: stdioServer(["--tools", "1"]) });
		const providerToolNames: string[][] = [];
		const harness = await createHarness({
			extensionFactories: [mcpExtension],
		});
		harnesses.push(harness);

		harness.setResponses([
			(context) => {
				providerToolNames.push((context.tools ?? []).map((toolInfo) => toolInfo.name).sort());
				return fauxAssistantMessage("initial");
			},
		]);
		await harness.session.prompt("initial MCP tool payload");
		expect(providerToolNames[0]).toContain("mcp_fx_tool_1");
		expect(harness.session.getActiveToolNames()).toContain("mcp_fx_tool_1");

		await harness.session.prompt("/mcp disable fx");
		expect(harness.session.getActiveToolNames()).not.toContain("mcp_fx_tool_1");

		setConfig(root, { fx: stdioServer(["--tools", "2"]) });
		harness.setResponses([
			(context) => {
				providerToolNames.push((context.tools ?? []).map((toolInfo) => toolInfo.name).sort());
				return fauxAssistantMessage("disabled");
			},
		]);
		await harness.session.prompt("disabled MCP tool payload");
		expect(providerToolNames[providerToolNames.length - 1]).not.toContain("mcp_fx_tool_1");

		await harness.session.prompt("/mcp enable fx");
		harness.setResponses([
			(context) => {
				providerToolNames.push((context.tools ?? []).map((toolInfo) => toolInfo.name).sort());
				return fauxAssistantMessage(fauxToolCall("mcp_fx_tool_2", { value: "fresh" }), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("done"),
		]);
		const firstEnabledPayloadIndex = providerToolNames.length;
		await harness.session.prompt("call fresh MCP tool 2");

		expect(providerToolNames[firstEnabledPayloadIndex]).toEqual(
			expect.arrayContaining(["mcp_fx_tool_1", "mcp_fx_tool_2"]),
		);
		expect(toolResultTexts(harness, "mcp_fx_tool_2")).toEqual(["fixture tool_2 value=fresh mode=alpha"]);
	});

	it("reports fixture test success with elapsed milliseconds", async () => {
		const root = makeCommandRoot("test-ok");
		setConfig(root, { fx: stdioServer(["--tools", "3"]) });
		const { command, extension } = await loadCommand();
		const ui = createUi();
		await emitSessionStart(extension, root);

		await command.handler("test fx", createCtx(root, ui));

		expect(lastNotification(ui)?.message).toMatch(/^MCP test fx ok \(\d+ms\): 3 tools$/);
	});

	it("bounds wedged fixture tests and keeps the command route responsive", async () => {
		const root = makeCommandRoot("test-timeout");
		setConfig(root, { wedged: stdioServer(["--wedge", "--tools", "1", "--slow-start", "10000"]) });
		const { command, extension } = await loadCommand();
		const ui = createUi();
		await emitSessionStart(extension, root);

		await command.handler("test wedged", createCtx(root, ui));
		await command.handler("status", createCtx(root, ui));

		expect(notification(ui, "MCP test wedged failed")?.message).toMatch(/^MCP test wedged failed \(\d+ms\): /);
		expect(notification(ui, "MCP status")?.message).toContain("MCP status");
	});
});

function makeCommandRoot(slug: string): TestRoot {
	const root = makeRoot(`commands-${slug}`, cleanupTasks);
	process.env[ENV_AGENT_DIR] = root.agentDir;
	mkdirSync(root.agentDir, { recursive: true });
	return root;
}

async function loadCommand(): Promise<{
	command: NonNullable<Extension["commands"] extends Map<string, infer T> ? T : never>;
	extension: Extension;
}> {
	const extension = await loadMcpExtension();
	const command = extension.commands.get("mcp");
	expect(command).toBeDefined();
	if (!command) throw new Error("missing mcp command");
	return { command, extension };
}

function loadMcpExtension(): Promise<Extension> {
	const runtime = createExtensionRuntime();
	runtime.getActiveTools = () => [];
	runtime.setActiveTools = () => {};
	return loadExtensionFromFactory(mcpExtension, process.cwd(), createEventBus(), runtime, "<mcp-command-test>");
}

async function emitSessionStart(extension: Extension, root: TestRoot): Promise<void> {
	const event: SessionStartEvent = { type: "session_start", reason: "startup" };
	for (const handler of extension.handlers.get("session_start") ?? []) {
		await handler(event, { cwd: root.cwd, isProjectTrusted: () => true });
	}
}

interface UiCall {
	message: string;
	type: "info" | "warning" | "error";
}

interface SelectCall {
	title: string;
	options: string[];
}

interface TestUi extends ExtensionUIContext {
	notifications: UiCall[];
	selectCalls: SelectCall[];
	confirmCalls: Array<{ title: string; message: string }>;
	customCalls: number;
}

function createUi(options: { confirmResults?: boolean[]; selectResult?: string | undefined } = {}): TestUi {
	const notifications: UiCall[] = [];
	const selectCalls: SelectCall[] = [];
	const confirmCalls: Array<{ title: string; message: string }> = [];
	const confirmResults = [...(options.confirmResults ?? [])];
	return {
		notifications,
		selectCalls,
		confirmCalls,
		customCalls: 0,
		async select(title, selectOptions) {
			selectCalls.push({ title, options: [...selectOptions] });
			return options.selectResult;
		},
		async confirm(title, message) {
			confirmCalls.push({ title, message });
			return confirmResults.shift() ?? false;
		},
		async custom<T>(): Promise<T> {
			this.customCalls += 1;
			throw new Error("custom UI is not used by /mcp command tests");
		},
		notify(message, type = "info") {
			notifications.push({ message, type });
		},
		input: async () => undefined,
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		theme,
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "UI not available" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

function createCtx(root: TestRoot, ui: TestUi): ExtensionCommandContext {
	const runner = new ExtensionRunner(
		[],
		createExtensionRuntime(),
		root.cwd,
		SessionManager.inMemory(),
		ModelRegistry.create(AuthStorage.create(join(root.agentDir, "auth.json"))),
	);
	runner.setUIContext(ui, "tui");
	return runner.createCommandContext();
}

function normalize(value: string | undefined, root: TestRoot): string {
	if (value === undefined) return "";
	return value
		.split(root.agentDir)
		.join("<agentDir>")
		.split(root.cwd)
		.join("<cwd>")
		.replace(/uptime=\d+(?:\.\d+)?s/g, "uptime=<1s");
}

function lastNotification(ui: TestUi): UiCall | undefined {
	return ui.notifications[ui.notifications.length - 1];
}

function notification(ui: TestUi, fragment: string): UiCall | undefined {
	return ui.notifications.find((item) => item.message.includes(fragment));
}
