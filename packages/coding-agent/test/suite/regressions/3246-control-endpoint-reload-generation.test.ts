/**
 * senpi#3246: a control endpoint belongs to the extension generation that registered it. A reload
 * retires that generation, so its endpoint must go with it: a wake never runs the retired
 * generation's `drain` (which surfaced as "control endpoint drain failed: stale extension
 * generation after reload" on every wake).
 */
import { join } from "node:path";
import { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { controlRequest } from "../../helpers/session-control-client.ts";
import { createHarness, type Harness } from "../harness.ts";

const cleanups: Array<() => unknown> = [];

beforeAll(() => initTheme("dark"));

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Terminal {
	readonly harness: Harness;
	/** Sockets in registration order, one per generation that registered. */
	readonly sockets: string[];
	/** The generation each drain call came from. */
	readonly drains: number[];
}

async function terminal(): Promise<Terminal> {
	const sockets: string[] = [];
	const drains: number[] = [];
	let generations = 0;
	let inboxDir = "";
	const harness = await createHarness({
		persistSession: true,
		extensionFactories: [
			(pi) => {
				generations += 1;
				const generation = generations;
				pi.on("session_start", async (event) => {
					if (event.reason !== "startup") return;
					const registration = await pi.session.registerControlEndpoint({
						inboxDir,
						drain: () => {
							drains.push(generation);
							return undefined;
						},
					});
					if (registration.status !== "registered") throw new Error(JSON.stringify(registration));
					cleanups.push(() => registration.dispose());
					sockets.push(registration.socket);
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
	expect(sockets).toHaveLength(1);
	return { harness, sockets, drains };
}

describe.skipIf(process.platform === "win32")("senpi#3246 a control endpoint after a reload", () => {
	it("#given an endpoint registered once at startup #when the session reloads #then the retired generation's endpoint is gone and its drain never runs again", async () => {
		const { harness, sockets, drains } = await terminal();
		await harness.session.reload();
		const before = drains.length;

		// Gone: its socket secret is removed (the request cannot open) or the socket refuses it.
		const reply = await Promise.resolve()
			.then(() => controlRequest(sockets[0], { type: "wake" }))
			.then(
				(answer) => answer.kind,
				(error: unknown) => (error instanceof Error && "code" in error ? String(error.code) : "rejected"),
			);

		expect(["closed", "ENOENT", "ECONNREFUSED"]).toContain(reply);
		expect(drains.slice(before)).toEqual([]);
	});
});
