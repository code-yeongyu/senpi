/**
 * senpi#3226 + #3229: an rpc monitor watching "all" reads a TERMINAL session through its control endpoint:
 * the terminal's content and status reach the monitor as lines while the monitor never attaches (the
 * terminal still counts one attachment, itself). A real interactive mode on a virtual terminal registers
 * the endpoint at session start, as OmO's thread component does.
 */
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { MonitorRegistry } from "../../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { createHarness } from "../harness.ts";

const cleanups: Array<() => unknown> = [];
beforeAll(() => initTheme("dark"));
// Stopping real hosts is bounded like the tests themselves, not by the 10 s hook default.
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}, 120_000);

async function terminal() {
	let socket: string | undefined;
	let inboxDir = "";
	const harness = await createHarness({
		persistSession: true,
		settings: { retry: { enabled: false } },
		extensionFactories: [
			(pi) => {
				pi.on("session_start", async () => {
					const registration = await pi.session.registerControlEndpoint({ inboxDir, drain: () => undefined });
					if (registration.status !== "registered") throw new Error(JSON.stringify(registration));
					cleanups.push(() => registration.dispose());
					socket = registration.socket;
				});
			},
		],
	});
	cleanups.push(() => harness.cleanup());
	inboxDir = join(harness.tempDir, "inbox");
	const runtime = Object.assign(Object.create(AgentSessionRuntime.prototype), { _session: harness.session });
	const mode = new InteractiveMode(runtime);
	const ui = new TUI(new VirtualTerminal(120, 40));
	Reflect.set(mode, "ui", ui);
	cleanups.push(() => ui.stop());
	const bind = Reflect.get(mode, "bindCurrentSessionExtensions");
	if (typeof bind !== "function") throw new TypeError("InteractiveMode lost its extension bind path");
	await bind.call(mode);
	if (socket === undefined) throw new Error("the terminal registered no control endpoint");
	return { harness, socket };
}

describe("rpc monitor over a terminal endpoint (senpi#3226)", () => {
	it("reports the terminal session's content and status without attaching to it", async () => {
		const { harness, socket } = await terminal();
		const lines: string[] = [];
		const idle = Promise.withResolvers<void>();
		const registry = new MonitorRegistry((event) => {
			if (event.type !== "line") return;
			lines.push(event.line);
			if (/status running -> idle/.test(event.line)) idle.resolve();
		});
		cleanups.push(() => registry.dispose());

		const armed = await registry.registerRpc({
			description: "every session",
			target: { kind: "all" },
			targetText: "all",
			events: "all",
			exclude: [],
			persistent: false,
			agentDir: harness.tempDir,
			endpoints: async () => [socket],
		});
		harness.setResponses([fauxAssistantMessage("hello from the terminal")]);
		await harness.session.prompt("go");
		const deadline = setTimeout(() => idle.reject(new Error(`no idle line; saw: ${lines.join(" | ")}`)), 20_000);
		await idle.promise;
		clearTimeout(deadline);

		expect(armed.rows).toEqual([expect.stringMatching(/ idle \(1 attached/)]);
		expect(lines.some((line) => / message_start \{/.test(line))).toBe(true);
		expect(lines.some((line) => /status idle -> running/.test(line))).toBe(true);
	}, 60_000);
});
