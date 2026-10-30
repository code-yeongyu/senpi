import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoggingVirtualTerminal } from "../../../tui/test/mux-scrollback-harness.ts";
import { registerTerminalExtension } from "../../src/core/extensions/builtin/terminal/extension.ts";
import type { MonitorSnapshotEntry } from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import { formatMonitorStatus } from "../../src/core/extensions/builtin/terminal/monitor-status.ts";
import { MonitorStatusTicker } from "../../src/core/extensions/builtin/terminal/monitor-status-ticker.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";
import type { ReadonlyFooterDataProvider } from "../../src/core/footer-data-provider.ts";
import { FooterComponent } from "../../src/modes/interactive/components/footer.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createFooterData, createFooterSession } from "../helpers/footer-test-fixtures.ts";

const T0 = 1_000_000;
const entry: MonitorSnapshotEntry = { id: "bash_1", description: "deploy errors", paused: false, startedAtMs: T0 };
const glyphOf = (status: string | undefined) => status?.match(/[◉◎○] watching/)?.[0]?.[0];

describe("monitor watching pulse", () => {
	afterEach(() => vi.useRealTimers());

	it("cycles the watch glyph one frame per elapsed second when animated", () => {
		const glyphs = [0, 1, 2, 3, 4].map((second) => glyphOf(formatMonitorStatus([entry], T0 + second * 1000, true)));
		expect(glyphs).toEqual(["◉", "◎", "○", "◎", "◉"]);
		expect(formatMonitorStatus([entry], T0 + 1000, true)).toBe("◎ watching deploy errors (1s)");
	});

	it("keeps the static glyph when not animated", () => {
		const glyphs = [0, 1, 2].map((second) => glyphOf(formatMonitorStatus([entry], T0 + second * 1000)));
		expect(glyphs).toEqual(["◉", "◉", "◉"]);
	});

	it("re-reads the animate gate on every tick", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		let animate = true;
		const labels: Array<string | undefined> = [];
		const ticker = new MonitorStatusTicker({ render: (status) => labels.push(status), animate: () => animate });

		ticker.sync([entry]);
		vi.advanceTimersByTime(1_000);
		animate = false;
		vi.advanceTimersByTime(1_000);
		ticker.stop();

		expect(labels.map(glyphOf)).toEqual(["◉", "◎", "◉"]);
	});
});

describe("terminal extension pulse gating", () => {
	const savedForcePipe = process.env.SENPI_PTY_FORCE_PIPE;
	const savedAgentDir = process.env.SENPI_CODING_AGENT_DIR;
	let tmp: string;
	let cwd: string;
	let shutdown: (() => Promise<void>) | undefined;

	beforeEach(() => {
		initTheme("dark");
		process.env.SENPI_PTY_FORCE_PIPE = "1";
		tmp = mkdtempSync(join(tmpdir(), "senpi-monitor-pulse-"));
		process.env.SENPI_CODING_AGENT_DIR = join(tmp, "agent-home");
		cwd = join(tmp, "project");
		mkdirSync(join(cwd, ".senpi"), { recursive: true });
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
		vi.setSystemTime(T0);
	});

	afterEach(async () => {
		vi.useRealTimers();
		await shutdown?.();
		shutdown = undefined;
		rmSync(tmp, { recursive: true, force: true });
		if (savedForcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
		else process.env.SENPI_PTY_FORCE_PIPE = savedForcePipe;
		if (savedAgentDir === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
		else process.env.SENPI_CODING_AGENT_DIR = savedAgentDir;
	});

	async function watchGlyphs(options: {
		reducedMotion?: boolean;
		busy?: boolean;
	}): Promise<Array<string | undefined>> {
		writeFileSync(
			join(cwd, ".senpi", "settings.json"),
			JSON.stringify({ terminal: { notify: "off" }, reducedMotion: options.reducedMotion }),
		);
		type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
		type MonitorTool = { execute: (id: string, input: Record<string, unknown>) => Promise<{ isError?: boolean }> };
		const handlers = new Map<string, Handler[]>();
		const tools = new Map<string, MonitorTool>();
		let activeTools: string[] = [];
		const pi = {
			registerTool: (tool: MonitorTool & { name: string }) => tools.set(tool.name, tool),
			registerMessageRenderer: () => {},
			on: (eventType: string, handler: Handler) =>
				handlers.set(eventType, [...(handlers.get(eventType) ?? []), handler]),
			sendMessage: () => {},
			sendUserMessage: () => {},
			getActiveTools: () => activeTools,
			setActiveTools: (next: string[]) => {
				activeTools = next;
			},
		} as unknown as ExtensionAPI;
		registerTerminalExtension(pi);
		const statuses: Array<string | undefined> = [];
		const ctx = {
			cwd,
			hasUI: true,
			mode: "tui",
			sessionManager: { getSessionId: () => "session-pulse", getSessionFile: () => undefined },
			ui: {
				setStatus: (_key: string, text: string | undefined) => statuses.push(text),
				notify: () => {},
				theme: { bg: (_color: string, text: string) => text, fg: (_color: string, text: string) => text },
			},
		} as unknown as ExtensionContext;
		const emit = async (eventType: string, payload: Record<string, unknown>) => {
			for (const handler of handlers.get(eventType) ?? []) await handler(payload, ctx);
		};
		shutdown = () => emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		await emit("session_start", { type: "session_start", reason: "startup" });
		if (options.busy) await emit("agent_start", { type: "agent_start" });
		const started = await tools.get("monitor")?.execute("call_1", { description: "build", command: "cat" });
		expect(started?.isError).toBeFalsy();
		for (let second = 0; second < 3; second++) vi.advanceTimersByTime(1_000);
		return statuses.filter((status) => status !== undefined).map(glyphOf);
	}

	it("pulses while the agent idles on monitors", async () => {
		expect(await watchGlyphs({})).toEqual(["◉", "◎", "○", "◎"]);
	});

	it("stays static when reducedMotion is enabled", async () => {
		expect(await watchGlyphs({ reducedMotion: true })).toEqual(["◉", "◉", "◉", "◉"]);
	});

	it("stays static while the agent is busy", async () => {
		expect(await watchGlyphs({ busy: true })).toEqual(["◉", "◉", "◉", "◉"]);
	});
});

describe("monitor pulse footer repaint", () => {
	it("rewrites only the status line on a pulse frame, never the whole footer", async () => {
		initTheme("dark");
		const statuses = new Map<string, string>();
		const footerData: ReadonlyFooterDataProvider = {
			...createFooterData(1),
			getExtensionStatuses: () => statuses,
		};
		const footer = new FooterComponent(createFooterSession({ sessionName: "", cwd: "/work/pulse" }), footerData);
		const terminal = new LoggingVirtualTerminal(100, 10);
		const tui = new TUI(terminal);
		tui.addChild(footer);
		statuses.set("monitors", formatMonitorStatus([entry], T0, true) ?? "");
		tui.start();
		tui.renderNow();
		await terminal.flush();
		const redrawsBefore = tui.fullRedraws;
		expect(terminal.getWrites()).toContain("/work/pulse");
		expect(terminal.getWrites()).toContain("test-model");
		terminal.clearWrites();

		statuses.set("monitors", formatMonitorStatus([entry], T0 + 1000, true) ?? "");
		tui.renderNow();
		await terminal.flush();
		const writes = terminal.getWrites();
		tui.stop();

		expect(tui.fullRedraws).toBe(redrawsBefore);
		expect(writes).toContain("◎ watching deploy errors (1s)");
		expect(writes).not.toContain("/work/pulse");
		expect(writes).not.toContain("test-model");
	});
});
