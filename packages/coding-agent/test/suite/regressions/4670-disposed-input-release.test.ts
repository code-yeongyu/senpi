import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, expect, it, vi } from "vitest";
import { AgentSessionRuntime, type AgentSessionServices } from "../../../src/core/agent-session-runtime.ts";
import { createHarness, type Harness } from "../harness.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

it("restores an unadmitted release while the original session remains live", async () => {
	// Given a held live session with a command that handles input without starting a turn.
	const h = await createHarness({
		extensionFactories: [
			(pi) => pi.registerCommand("noop", { description: "Handle input", handler: async () => {} }),
		],
	});
	cleanups.push(h.cleanup);
	await h.session.bindExtensions({ mode: "tui" });
	await h.session.stop();
	const before = h.session.holds.map((hold) => hold.key);

	// When no replacement or turn admission occurs.
	await h.session.prompt("/noop");

	// Then live-session abandon semantics still restore the released hold.
	expect(h.session.holds.map((hold) => hold.key)).toEqual(before);
	expect(h.session.paused).toBe(true);
	expect(h.faux.state.callCount).toBe(0);
});

function services(h: Harness): AgentSessionServices {
	return {
		cwd: h.tempDir,
		agentDir: h.session.agentDir,
		authStorage: h.authStorage,
		modelRegistry: h.modelRegistry,
		modelRuntime: h.session.modelRuntime,
		settingsManager: h.settingsManager,
		resourceLoader: h.session.resourceLoader,
		diagnostics: [],
	};
}

// senpi#4670: replacement relinquishes the old session's write ownership before prompt() unwinds.
it("does not append a hold or emit a hold event after a held command replaces its session", async () => {
	// Given a real held session and an extension command that replaces it through the runtime.
	let runtime: AgentSessionRuntime | undefined;
	const staleEvents: string[] = [];
	const h = await createHarness({
		persistSession: true,
		extensionFactories: [
			(pi) => {
				pi.registerCommand("replace", {
					description: "Replace this test session",
					handler: async () => {
						if (runtime === undefined) throw new Error("Runtime missing");
						await runtime.newSession();
					},
				});
				pi.on("session_hold_changed", (event) => {
					if (!h.session.extensionRunner.isActive) staleEvents.push(event.change);
				});
			},
		],
	});
	cleanups.push(h.cleanup);
	runtime = new AgentSessionRuntime(h.session, services(h), async ({ sessionManager, sessionStartEvent }) => {
		const next = await createHarness({ siblingOf: h, sessionManager, sessionStartEvent });
		cleanups.push(next.cleanup);
		return {
			session: next.session,
			services: services(next),
			extensionsResult: next.session.resourceLoader.getExtensions(),
			diagnostics: [],
		};
	});
	const ownedRuntime = runtime;
	cleanups.push(() => ownedRuntime.dispose());
	await h.session.bindExtensions({ mode: "tui" });
	h.setResponses([fauxAssistantMessage("Initial answer")]);
	await h.session.prompt("Initial request");
	await h.session.stop();
	const lateWrites: string[] = [];
	const append = h.sessionManager.appendCustomEntry.bind(h.sessionManager);
	vi.spyOn(h.sessionManager, "appendCustomEntry").mockImplementation((type, data) => {
		if (!h.session.extensionRunner.isActive) lateWrites.push(type);
		return append(type, data);
	});

	// When replacement disposes the old session while its input release is pending.
	await h.session.prompt("/replace");

	// Then no old-session write or extension event occurs after ownership was relinquished.
	expect(runtime.session).not.toBe(h.session);
	expect(lateWrites).toEqual([]);
	expect(staleEvents).toEqual([]);
});
