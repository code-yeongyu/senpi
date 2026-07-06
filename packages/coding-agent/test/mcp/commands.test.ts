import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { createEventBus } from "../../src/core/event-bus.ts";
import mcpExtension from "../../src/core/extensions/builtin/mcp/index.ts";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../src/core/extensions/loader.ts";
import type {
	Extension,
	ExtensionCommandContext,
	ExtensionUIContext,
	SessionStartEvent,
} from "../../src/core/extensions/types.ts";
import { cleanupRoots, makeRoot, setConfig, stdioServer, type TestRoot } from "./fixtures/service-lifecycle.ts";

const cleanupTasks: Array<() => Promise<void>> = [];
const originalAgentDir = process.env[ENV_AGENT_DIR];

beforeEach(() => {
	resetMcpServiceForTests();
});

afterEach(async () => {
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
		const ui = createUi({ customResult: undefined, selectResult: undefined });
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
	return loadExtensionFromFactory(
		mcpExtension,
		process.cwd(),
		createEventBus(),
		createExtensionRuntime(),
		"<mcp-command-test>",
	);
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

interface TestUi extends Pick<ExtensionUIContext, "select" | "confirm" | "custom" | "notify"> {
	notifications: UiCall[];
	selectCalls: SelectCall[];
	confirmCalls: Array<{ title: string; message: string }>;
	customCalls: number;
}

function createUi(
	options: { confirmResults?: boolean[]; customResult?: boolean | undefined; selectResult?: string | undefined } = {},
): TestUi {
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
		async custom<T>() {
			this.customCalls += 1;
			return options.customResult as T;
		},
		notify(message, type = "info") {
			notifications.push({ message, type });
		},
	};
}

function createCtx(root: TestRoot, ui: TestUi, hasUI = true): ExtensionCommandContext {
	return {
		cwd: root.cwd,
		hasUI,
		isProjectTrusted: () => true,
		ui,
	} as unknown as ExtensionCommandContext;
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
