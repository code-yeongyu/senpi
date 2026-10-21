import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import goalExtension from "../../../src/core/extensions/builtin/goal/index.ts";
import { createGoal, readGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../../src/core/extensions/builtin/goal/store-ref.ts";
import { getTerminalNotificationDelivery } from "../../../src/core/extensions/builtin/terminal/notify.ts";
import type { ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { runAbort } from "../../../src/modes/rpc/effect-commands.ts";
import { buildRpcSessionState } from "../../../src/modes/rpc/rpc-session-state.ts";
import { createHarness } from "../harness.ts";

for (const mode of ["tui", "rpc"] as const) {
	it(`characterizes ${mode} Stop followed by an actual terminal completion delivery`, async () => {
		let releaseTool: () => void = () => {};
		let toolStarted: () => void = () => {};
		const release = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const started = new Promise<void>((resolve) => {
			toolStarted = resolve;
		});
		let api: ExtensionAPI | undefined;
		let context: ExtensionContext | undefined;
		const events: unknown[] = [];
		// given: real session lifecycle and goal extension, only the provider and tool are synthetic.
		const harness = await createHarness({
			persistSession: true,
			extensionFactories: [
				goalExtension,
				(pi) => {
					api = pi;
					pi.on("session_start", (_event, ctx) => {
						context = ctx;
					});
					pi.on("agent_end", (event) => {
						events.push({ type: "agent_end", aborted: event.aborted, abortSource: event.abortSource });
					});
				},
			],
			tools: [
				{
					name: "hold",
					label: "Hold",
					description: "Deterministic interrupt boundary",
					parameters: Type.Object({}),
					execute: async () => {
						toolStarted();
						await release;
						return { content: [{ type: "text", text: "released" }], details: {} };
					},
				},
			],
		});
		try {
			await harness.session.bindExtensions({ mode });
			const ref = goalStoreRef(harness.sessionManager, harness.tempDir);
			await createGoal(ref, "Wait for explicit user resumption");
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("Background completion started another turn"),
			]);
			harness.session.subscribe((event) => {
				if (event.type === "agent_start" || event.type === "agent_idle") events.push({ type: event.type });
			});
			const prompt = harness.session.prompt("Work on the goal");
			await started;
			events.push({ type: "user_stop", mode });
			// when: invoke the shipped TUI abort helper or the shipped desktop RPC abort command handler.
			let aborting: Promise<unknown>;
			if (mode === "tui") {
				const stop = Reflect.get(InteractiveMode.prototype, "abortAndFireQueuedMessages");
				if (typeof stop !== "function") throw new Error("TUI stop helper unavailable");
				aborting = stop.call({
					session: harness.session,
					clearAllQueues: () => harness.session.clearQueue({ abortWillFollow: true }),
					updatePendingMessagesDisplay: () => {},
					editor: { getText: () => "", setText: () => {} },
				});
			} else {
				aborting = runAbort(
					{ session: harness.session, by: { connectionId: "synthetic-desktop" } },
					{ type: "abort", id: "stop", clearQueue: true, awaitIdle: true },
					() => harness.session.abort(),
				).then((answer) => {
					events.push(answer);
				});
			}
			releaseTool();
			await Promise.all([prompt, aborting]);
			await harness.session.waitForIdle();
			const goalAfterAbort = await readGoal(ref);
			expect(goalAfterAbort?.status).toBe("paused");
			expect(buildRpcSessionState(harness.session).paused).toBe(true);
			expect(harness.faux.state.callCount).toBe(1);
			events.push({ type: "stopped", goal: goalAfterAbort?.status, calls: harness.faux.state.callCount });
			if (api === undefined || context === undefined) throw new Error("Extension binding unavailable");
			const delivery = getTerminalNotificationDelivery({
				sendMessage: api.sendMessage,
				getContext: () => context,
				getMode: () => "wake",
			});
			if (delivery === undefined) throw new Error("Interactive terminal delivery unavailable");
			// Subscribe before the exact event under test, not a sleep/polling window.
			const persisted = new Promise<void>((resolve) => {
				const unsubscribe = harness.session.subscribe((event) => {
					if (event.type !== "session_notice" || event.disposition !== "notice_persisted") return;
					expect(
						event.entryIds.every((id) => harness.sessionManager.getEntry(id)?.type === "custom_message"),
					).toBe(true);
					unsubscribe();
					resolve();
				});
			});
			events.push({ type: "late_background_completion" });
			delivery.send("Synthetic background process finished.");
			await persisted;
			// then: a paused run must not have entered the provider again.
			console.log(JSON.stringify({ mode, tempDir: harness.tempDir, events, calls: harness.faux.state.callCount }));
			expect(harness.faux.state.callCount).toBe(1);
			expect((await readGoal(ref))?.status).toBe("paused");
			expect(harness.session.pauseState).toEqual({ paused: true, noticeCount: 1 });

			await harness.session.sendUserMessage("An extension is not a human resume");
			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.session.pauseState).toEqual({ paused: true, noticeCount: 2 });

			const consumed = new Promise<void>((resolve) => {
				const unsubscribe = harness.session.subscribe((event) => {
					if (event.type !== "session_notice" || event.disposition !== "model_consumed") return;
					expect(event.entryIds).toHaveLength(2);
					unsubscribe();
					resolve();
				});
			});
			await harness.session.prompt("Resume the work");
			await consumed;
			expect(harness.faux.state.callCount).toBe(2);
			expect(harness.session.pauseState).toEqual({ paused: false, noticeCount: 0 });
			expect((await readGoal(ref))?.status).toBe("active");
		} finally {
			releaseTool();
			harness.cleanup();
		}
	}, 20_000);
}
