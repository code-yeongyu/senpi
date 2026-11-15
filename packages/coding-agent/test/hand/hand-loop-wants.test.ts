// senpi#5898: the hand tells a hosted loop which notifications its user hooks listen to (`wants`), and keeps it current:
// an extension may subscribe or unsubscribe at any time, so a reply carries the new set whenever it changed (review M1).
// The loop forwards every interceptor whatever `wants` says; only notifications are gated (`LOOP_HOOK_FORWARDING`).
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ExtensionRunner } from "../../src/core/extensions/runner.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { createLoopHookCall } from "../../src/modes/rpc/loop-hook-call.ts";
import { extensionLoopHooks } from "../../src/modes/rpc/loopless-loop-hooks.ts";
import { createInMemoryModelRegistry } from "../model-runtime-test-utils.ts";
import { createTestExtensionsResult } from "../utilities.ts";
import { hooksOf, loopEventMachine, NOTIFICATIONS, noLateEffects } from "./loop-event-fixture.ts";
import { cleanupHands } from "./remote-hand-fixture.ts";

afterEach(cleanupHands);

const LATE_SUBSCRIBER = fileURLToPath(new URL("./fixtures/late-subscriber-extension.ts", import.meta.url));

describe("the hand's wants (senpi#5898)", () => {
	it("a subscription made inside session_start reaches the loop with that reply, and the next stream reaches it", async () => {
		const user = await loopEventMachine(LATE_SUBSCRIBER);
		const before = await user.describe();

		const started = await user.send("session_start", { reason: "startup" });
		const first = await user.send("message_update", {
			seq: 1,
			message: fauxAssistantMessage(""),
			assistantMessageEvent: { type: "start" },
		});
		const done = await user.send("message_update", {
			seq: 2,
			message: fauxAssistantMessage("hi"),
			assistantMessageEvent: { type: "done", reason: "stop" },
		});

		expect(before.wants).not.toContain("message_update");
		expect(started.wants).toContain("message_update");
		expect([first.notices, first.wants]).toEqual([[{ message: "update start" }], undefined]);
		// The handler unsubscribed on `done`: that reply tells the loop to stop forwarding the stream.
		expect(done.notices).toEqual([{ message: "update done" }]);
		expect(done.wants).not.toContain("message_update");
	});

	it("lists every notification the user's extension listens to", async () => {
		const { wants } = await (await loopEventMachine()).describe();

		expect(wants).toEqual(expect.arrayContaining([...NOTIFICATIONS.map((row) => row.event), "message_update"]));
	});

	it("lists only notifications a user hook listens to: never a builtin's, an interceptor, a loop-only or a runtime event", async () => {
		const factories: { path: string; factory: ExtensionFactory }[] = [
			{ path: "<builtin:probe>", factory: (pi) => void pi.on("message_update", () => undefined) },
			{
				path: "/user/probe.ts",
				factory: (pi) => {
					pi.on("provider_stream_event", () => undefined);
					pi.on("turn_end", () => undefined);
					pi.on("before_provider_headers", () => undefined);
					pi.on("tool_call", () => undefined);
				},
			},
		];
		const loaded = await createTestExtensionsResult(factories);
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			process.cwd(),
			undefined,
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
			loaded.eventBus,
		);
		const hooks = extensionLoopHooks(runner, "hand", process.cwd(), createLoopHookCall(noLateEffects));

		expect(await hooks("describe_hooks", {})).toEqual({ wants: ["provider_stream_event"] });
	});

	describe("a change stays pending until a reply carrying it reaches the loop (review L5)", () => {
		const subscribing: ExtensionFactory = (pi) => {
			pi.on("session_before_tree", () => {
				pi.on("message_update", () => undefined);
				// No JSON form: the hand refuses this reply, so the loop never sees the change it would carry.
				return { summary: { summary: "s", details: new Map([["k", 1]]) } };
			});
			pi.on("session_start", () => {
				pi.on("message_update", () => undefined);
			});
		};
		const base = { sessionId: "s", idle: false };
		const tree = {
			...base,
			preparation: {
				targetId: "entry-5",
				oldLeafId: null,
				commonAncestorId: null,
				entriesToSummarize: [],
				userWantsSummary: true,
			},
		};

		it("a refused reply leaves the change for the next one (the review's probe)", async () => {
			const hooks = await hooksOf([{ path: "/user/sub.ts", factory: subscribing }]);
			await hooks("describe_hooks", {});

			await expect(hooks("session_before_tree", tree)).rejects.toThrow(/has no JSON form/);
			const next = (await hooks("session_parked", base)) as { wants?: string[] };

			expect(next.wants).toEqual(["message_update"]);
		});

		it("a reply to a call the loop cancelled leaves the change for the next one", async () => {
			const hooks = await hooksOf([{ path: "/user/sub.ts", factory: subscribing }]);
			await hooks("describe_hooks", {});
			const cancel = new AbortController();
			cancel.abort();

			const dropped = (await hooks("session_start", { ...base, reason: "startup" }, cancel.signal)) as {
				wants?: string[];
			};
			const next = (await hooks("session_parked", base)) as { wants?: string[] };
			const after = (await hooks("session_resumed", base)) as { wants?: string[] };

			expect([dropped.wants, next.wants, after.wants]).toEqual([["message_update"], ["message_update"], undefined]);
		});
	});
});
