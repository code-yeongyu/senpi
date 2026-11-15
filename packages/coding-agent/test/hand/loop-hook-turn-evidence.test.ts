// What each forwarded loop event proves about its session's turn, at the hand's real dispatch (`extensionLoopHooks`
// over `TURN_EVIDENCE`): the classification a Stop held for background work reads through `ctx.isIdle()`.
import { fauxAssistantMessage, type JsonValue } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { holdIdle } from "../../src/core/extensions/loop-hook-idle-hold.ts";
import { ExtensionRunner } from "../../src/core/extensions/runner.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { createLoopHookCall } from "../../src/modes/rpc/loop-hook-call.ts";
import { extensionLoopHooks } from "../../src/modes/rpc/loopless-loop-hooks.ts";
import { createInMemoryModelRegistry } from "../model-runtime-test-utils.ts";
import { createTestExtensionsResult } from "../utilities.ts";

describe("a forwarded loop event's turn evidence (#6770)", () => {
	// #6770 review (CLEAR) L2: a forwarded agent_start is turn evidence by itself, not only through the hooks builtin's
	// own agent_start handler (which drops a held Stop and so hides the classification at the hand level). Only a user
	// extension runs here, so this fails if TURN_EVIDENCE.agent_start stops being "running".
	it("after a forwarded agent_end, a forwarded agent_start ends the idleness its held work sees", async () => {
		const call = createLoopHookCall();
		let kept: ExtensionContext | undefined;
		let release: (() => void) | undefined;
		const loaded = await createTestExtensionsResult([
			{
				path: "/user/held-work.ts",
				factory: (pi) =>
					void pi.on("agent_end", (_event, ctx) => {
						kept = ctx;
						release = holdIdle(ctx);
					}),
			},
		]);
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			process.cwd(),
			undefined,
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
			loaded.eventBus,
		);
		runner.bindSessionlessFacts({
			getAllTools: () => [],
			loopHookCall: () => call.current(),
			loopHookSend: () => call.sender(),
			loopHookWrite: () => call.writer(),
		});
		const hooks = extensionLoopHooks(runner, "hand", process.cwd(), call);
		const session = { sessionId: "loop-session-11", idle: false };

		await hooks("agent_end", {
			...session,
			messages: JSON.parse(JSON.stringify([fauxAssistantMessage("done")])) as JsonValue,
			leafId: "leaf-11",
			handEntries: [],
		});
		const afterTurn = kept?.isIdle();
		await hooks("agent_start", session);
		const afterAgentStart = kept?.isIdle();
		release?.();

		expect([afterTurn, afterAgentStart]).toEqual([true, false]);
	});
});
