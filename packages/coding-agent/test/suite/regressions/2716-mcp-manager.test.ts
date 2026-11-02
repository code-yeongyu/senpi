import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type Component, getKeybindings, setKeybindings, TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import { createMcpExtension } from "../../../src/core/extensions/builtin/mcp/index.ts";
import { type McpManagerMenu, McpManagerView } from "../../../src/core/extensions/builtin/mcp/manager-view.ts";
import { McpService } from "../../../src/core/extensions/builtin/mcp/service.ts";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { initTheme, type Theme, theme } from "../../../src/modes/interactive/theme/theme.ts";
import { createUi } from "../../mcp/fixtures/commands.ts";
import {
	cleanupRoots,
	makeRoot,
	setConfig,
	stdioServer,
	writeProjectConfig,
} from "../../mcp/fixtures/service-lifecycle.ts";
import { createHarness, type Harness } from "../harness.ts";

const previousKeys = getKeybindings();
const previousAgentDir = process.env[ENV_AGENT_DIR];
const cleanup: Array<() => Promise<void>> = [];
const placeholder = "$" + "{UNSET:-fallback}";

beforeEach(() => initTheme("dark"));

afterEach(async () => {
	setKeybindings(previousKeys);
	if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = previousAgentDir;
	await cleanupRoots(cleanup);
});

function surface() {
	const terminal = new VirtualTerminal(120, 36);
	const tui = new TUI(terminal);
	const keys = new KeybindingsManager();
	setKeybindings(keys);
	let component: (Component & { dispose?(): void }) | undefined;
	const observers = new Set<() => void>();
	const text = (width = terminal.columns): string =>
		component?.render(width).map(stripVTControlCharacters).join("\n") ?? "";
	const render = (): void => {
		for (const observer of [...observers]) observer();
	};
	tui.requestRender = render;
	const ui = createUi();
	ui.custom = async <T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (value: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
	): Promise<T> => {
		return new Promise<T>((resolve, reject) => {
			const done = (result: T): void => {
				component?.dispose?.();
				component = undefined;
				resolve(result);
			};
			Promise.resolve(factory(tui, theme, keys, done)).then((view) => {
				component = view;
				render();
			}, reject);
		});
	};
	const view = new McpManagerView(tui, theme, keys);
	cleanup.push(async () => {
		component?.dispose?.();
		view.dispose();
		tui.stop();
	});
	return {
		terminal,
		keys,
		view,
		ui,
		text,
		setView: () => {
			component = view;
		},
		input: (data: string) => component?.handleInput?.(data),
		waitFor(predicate: (output: string) => boolean): Promise<void> {
			return new Promise((resolve, reject) => {
				const timeout = setTimeout(() => {
					observers.delete(check);
					reject(new Error(`manager render not observed:\n${text()}`));
				}, 5000);
				const check = (): void => {
					if (!predicate(text())) return;
					clearTimeout(timeout);
					observers.delete(check);
					resolve();
				};
				observers.add(check);
				check();
			});
		},
	};
}

function menu(items: McpManagerMenu["items"]): McpManagerMenu {
	return { title: "MCP servers", items, confirmLabel: "manage", cancelLabel: "close" };
}

describe("interactive MCP manager (senpi#2716)", () => {
	it.each(["tool", ""])("sanitizes menu text with label %j and preserves raw selected values", async (label) => {
		// Given: remote text containing terminal title and screen-clearing controls.
		const s = surface();
		s.setView();
		const controls = "\x1b]2;MCP_INJECTION\x07\x1b[2J";
		const name = `${label}${controls}`;
		const ready = s.waitFor((text) => text.includes("safe description"));
		const pending = s.view.menu(() => ({
			...menu([{ value: name, label: name, description: `safe description${controls}` }]),
			title: `MCP servers${controls}`,
			details: `first${controls}\nsecond`,
		}));
		// When: the manager renders the menu and confirms the selected tool.
		await ready;
		const output = s.view.render(120).join("\n");
		s.input("\r");
		// Then: display text is safe, multiline details survive, and identity stays raw.
		expect(output).not.toContain("MCP_INJECTION");
		expect(output).not.toContain("\x1b[2J");
		expect(stripVTControlCharacters(output)).toMatch(/first[ \t]*\n.*second/);
		expect(await pending).toBe(name);
	});

	it("removes terminal controls from status and empty-menu text", async () => {
		// Given: a view that receives display-only status and empty-state text.
		const s = surface();
		s.setView();
		const controls = "\x1b]2;MCP_INJECTION\x07\x1b[2J";
		// When: it renders the status and then an empty menu.
		s.view.status(`status${controls}`, `message${controls}`);
		const status = s.view.render(120).join("\n");
		const ready = s.waitFor((text) => text.includes("empty"));
		const pending = s.view.menu(() => ({ ...menu([]), empty: `empty${controls}` }));
		await ready;
		const empty = s.view.render(120).join("\n");
		s.input("\x1b");
		await pending;
		// Then: neither rendering emits the untrusted controls.
		for (const output of [status, empty]) {
			expect(output).not.toContain("MCP_INJECTION");
			expect(output).not.toContain("\x1b[2J");
		}
	});

	it("preserves selected identity across event refreshes and releases the subscription on exit", async () => {
		// Given: a real menu with a state-change signal and configured navigation.
		const s = surface();
		s.setView();
		let items = [
			{ value: "a", label: "a" },
			{ value: "b", label: "b" },
		];
		let refresh = (): void => {};
		let listeners = 0;
		const ready = s.waitFor((text) => text.includes("→ a"));
		const pending = s.view.menu(
			() => menu(items),
			(listener) => {
				refresh = listener;
				listeners++;
				return () => listeners--;
			},
		);
		await ready;
		s.input("\x1b[B");
		// When: a new server sorts before the selected server while it changes state.
		items = [
			{ value: "z", label: "z" },
			{ value: "a", label: "a" },
			{ value: "b", label: "b connected" },
		];
		const changed = s.waitFor((text) => text.includes("→ b connected"));
		refresh();
		await changed;
		s.input("\r");
		// Then: Enter selects b, not its former index, and the listener is removed.
		expect(await pending).toBe("b");
		expect(listeners).toBe(0);
	});

	it.each(["resolve", "reject"])("ignores an old async menu %s after a newer refresh or disposal", async (outcome) => {
		// Given: an unresolved catalog snapshot.
		const s = surface();
		s.setView();
		let oldResult: (value: McpManagerMenu) => void = () => {};
		let oldFailure: (error: Error) => void = () => {};
		const old = new Promise<McpManagerMenu>((resolve, reject) => {
			oldResult = resolve;
			oldFailure = reject;
		});
		let refresh = (): void => {};
		let calls = 0;
		const pending = s.view.menu(
			() => (++calls === 1 ? old : menu([{ value: "new", label: "new" }])),
			(listener) => {
				refresh = listener;
				return () => {};
			},
		);
		// When: a newer event resolves before the older catalog.
		const ready = s.waitFor((text) => text.includes("→ new"));
		refresh();
		await ready;
		if (outcome === "resolve") oldResult(menu([{ value: "old", label: "old" }]));
		else oldFailure(new Error("superseded catalog failure"));
		await old.catch(() => undefined);
		s.input("\r");
		// Then: the stale snapshot never replaces the selected new item.
		expect(await pending).toBe("new");
		const closing = s.view.menu(() => old);
		s.view.dispose();
		expect(await closing).toBeUndefined();
		expect(await s.view.menu(() => menu([{ value: "reopened", label: "reopened" }]))).toBeUndefined();
	});

	it("scrolls long catalogs, fits narrow terminals, and honors configured confirm/cancel bindings", async () => {
		// Given: 20 long server names and non-default action keys.
		const s = surface();
		s.setView();
		s.keys.setUserBindings({ "tui.select.confirm": "ctrl+y", "tui.select.cancel": "ctrl+x" });
		const ready = s.waitFor((text) => text.includes("server-0"));
		const pending = s.view.menu(() =>
			menu(
				Array.from({ length: 20 }, (_, i) => ({
					value: String(i),
					label: `server-${i}-${"長".repeat(20)}`,
					description: "connected · 44 tools · search · global",
				})),
			),
		);
		await ready;
		// When: selection reaches a server outside the first page, then width shrinks.
		for (let i = 0; i < 15; i++) s.input("\x1b[B");
		expect(s.text()).toContain("→ server-15");
		s.terminal.resize(28, 18);
		expect(
			s
				.text(28)
				.split("\n")
				.every((line) => visibleWidth(line) <= 28),
		).toBe(true);
		// Default Enter must not confirm 15 and default Esc must not cancel; navigation continues.
		s.input("\r");
		s.input("\x1b[B");
		expect(s.text(28)).toContain("→ server-16");
		s.input("\x1b");
		s.input("\x1b[B");
		expect(s.text(28)).toContain("→ server-17");
		s.input("\x19");
		// Then: only configured confirm chooses 17 (wrong Enter gives 15, wrong Esc gives undefined).
		expect(await pending).toBe("17");
		const emptyReady = s.waitFor((text) => text.includes("Nothing to show."));
		let live = 0;
		const empty = s.view.menu(
			() => menu([]),
			() => {
				live++;
				return () => live--;
			},
		);
		await emptyReady;
		s.input("\x1b");
		expect(live).toBe(1);
		s.input("\x18");
		expect(live).toBe(0);
		expect(await empty).toBeUndefined();
	});

	it("routes the real slash command into menus and edits only the selected project's config", async () => {
		// Given: global and project definitions with the same name, both initially disabled.
		const root = makeRoot("manager-project", cleanup);
		process.env[ENV_AGENT_DIR] = root.agentDir;
		setConfig(root, { fx: { ...stdioServer(["--tools", "1"]), enabled: false, exposure: "direct" } });
		const service = new McpService();
		const s = surface();
		let harness: Harness | undefined;
		cleanup.push(async () => {
			await service.dispose("quit");
			harness?.cleanup();
		});
		harness = await createHarness({ extensionFactories: [createMcpExtension(service)] });
		writeProjectConfig(harness.tempDir, {
			fx: {
				...stdioServer(["--tools", "1"]),
				enabled: false,
				exposure: "search",
				env: { PLACEHOLDER: placeholder },
			},
		});
		await harness.session.bindExtensions({ uiContext: s.ui, mode: "tui" });
		const ready = s.waitFor((text) => text.includes("→ fx") && text.includes("project"));
		const command = harness.session.prompt("/mcp");
		await ready;
		// When: Enter opens fx, then its Exposure action selects proxy and saves.
		const actions = s.waitFor((text) => text.includes("Exposure") && text.includes("Enable"));
		s.input("\r");
		await actions;
		for (let i = 0; i < 3; i++) s.input("\x1b[B");
		const choices = s.waitFor((text) => text.includes("→ search"));
		s.input("\r");
		await choices;
		s.input("\x1b[B");
		const saved = s.waitFor((text) => text.includes("Configuration saved."));
		s.input("\r");
		await saved;
		s.input("\x1b");
		await s.waitFor((text) => text.includes("MCP servers"));
		s.input("\x1b");
		await command;
		// Then: only the project definition changes, and its interpolation expression survives.
		const project = JSON.parse(readFileSync(join(harness.tempDir, ".senpi", "mcp.json"), "utf8"));
		const global = JSON.parse(readFileSync(join(root.agentDir, "mcp.json"), "utf8"));
		expect(project.mcpServers.fx.exposure).toBe("proxy");
		expect(project.mcpServers.fx.env.PLACEHOLDER).toBe(placeholder);
		expect(global.mcpServers.fx.exposure).toBe("direct");
	});
});
