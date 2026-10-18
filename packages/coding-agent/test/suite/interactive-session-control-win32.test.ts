/**
 * The interactive TUI on win32 - the platform cell of the terminal control endpoint contract.
 *
 * The session gateway is POSIX-only: a terminal's control endpoint is a Unix socket. On win32 the
 * interactive mode still installs its control host and binds extensions in `tui` mode, so an
 * extension that asks for an endpoint (a gateway extension does, on every session start) must be
 * answered `unsupported_platform` while the terminal starts and serves its session normally. Nothing
 * may be registered: no `rpc/tui` socket directory, no `rpc-host-daemon` endpoint directory, and an
 * empty endpoint registry, so no other client can ever find (and wait on) a terminal it cannot reach.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { SessionControlRegistration } from "../../src/core/extensions/session-control-types.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { listHostEndpoints } from "../../src/modes/rpc/host-endpoints.ts";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

const cleanups: Array<() => unknown> = [];

beforeAll(() => initTheme("dark"));

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startInteractive(harness: Harness): Promise<void> {
	const runtime = Object.assign(Object.create(AgentSessionRuntime.prototype), { _session: harness.session });
	const mode = new InteractiveMode(runtime);
	const ui = new TUI(new VirtualTerminal(120, 40));
	Reflect.set(mode, "ui", ui);
	cleanups.push(() => ui.stop());
	const bind = Reflect.get(mode, "bindCurrentSessionExtensions");
	if (typeof bind !== "function") throw new TypeError("InteractiveMode lost its extension bind path");
	await bind.call(mode);
}

describe.skipIf(process.platform !== "win32")("interactive TUI control endpoint on win32", () => {
	it("starts normally and registers nothing: the endpoint request answers unsupported_platform", async () => {
		const registrations: SessionControlRegistration[] = [];
		let inboxDir = "";
		const harness = await createHarness({
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async () => {
						const registration = await pi.session.registerControlEndpoint({ inboxDir, drain: () => undefined });
						if (registration.status === "registered") cleanups.push(() => registration.dispose());
						registrations.push(registration);
					});
				},
			],
		});
		cleanups.push(() => harness.cleanup());
		inboxDir = join(harness.tempDir, "inbox");
		const agentDir = harness.session.agentDir;

		await startInteractive(harness);

		expect(registrations).toEqual([{ status: "unsupported", reason: "unsupported_platform" }]);
		expect(existsSync(join(agentDir, "rpc", "tui"))).toBe(false);
		expect(existsSync(join(agentDir, "rpc-host-daemon"))).toBe(false);
		expect(existsSync(inboxDir)).toBe(false);
		expect(await listHostEndpoints(agentDir)).toEqual([]);

		harness.setResponses([fauxAssistantMessage("served on win32")]);
		await harness.session.prompt("hello");
		expect(getAssistantTexts(harness)).toEqual(["served on win32"]);
		expect(existsSync(join(agentDir, "rpc-host-daemon"))).toBe(false);
		expect(await listHostEndpoints(agentDir)).toEqual([]);
	});
});
