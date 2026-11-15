// senpi#6754 (review L2 on #6780, L1/L3 on #6784): a call ends when its reply is built, not later when its finally
// runs. From then on its wake port and relocation host refuse with `LoopHookCallEndedError` and its messages go to the
// call's late route, so no write is accepted into effects a reply already carried.
import { describe, expect, it } from "vitest";
import type { SessionRelocationHost } from "../../src/core/session-relocation.ts";
import type { SessionWakePort } from "../../src/core/session-wakes.ts";
import { type CarriedSession, createLoopHookCall, type LateLoopRoute } from "../../src/modes/rpc/loop-hook-call.ts";
import { effectsReply, type LoopHookEffects } from "../../src/modes/rpc/loop-hook-effects.ts";
import { LoopHookCallEndedError } from "../../src/modes/rpc/loop-hook-session.ts";

const noLateEffects: LateLoopRoute = () => {
	throw new Error("this test's calls send nothing after they ended");
};

const WAKE = { id: "w1", source: "schedule_prompt", dueAt: 2, prompt: "check", createdAt: 1 } as const;
const CARRIED: CarriedSession = {
	leafId: null,
	handEntries: [],
	wakes: [],
	relocation: { targets: [{ name: "studio", online: true }] },
};
const BINDING = { sessionId: "s1", cwd: "/work", idle: false, carried: CARRIED };

describe("a call's session ports end with the call (senpi#6754)", () => {
	it("a wake port or relocation host used after its call ended refuses and changes nothing the call collected", async () => {
		const call = createLoopHookCall(noLateEffects);
		let wakes: SessionWakePort | undefined;
		let relocation: SessionRelocationHost | undefined;
		let effects: LoopHookEffects | undefined;
		let facts: ReturnType<typeof call.current>;

		await call.run(BINDING, async (collected) => {
			effects = collected;
			facts = call.current();
			wakes = call.current()?.sessionWakes();
			relocation = call.current()?.relocationHost();
			wakes?.arm({ ...WAKE });
		});

		expect(() => wakes?.arm({ ...WAKE, id: "w2" })).toThrow(LoopHookCallEndedError);
		expect(() => wakes?.cancel("w1")).toThrow(LoopHookCallEndedError);
		await expect(relocation?.request({ target: "studio", reason: "late" })).rejects.toThrow(LoopHookCallEndedError);
		// Read from outside the call's own work (this test's context), what the call carried refuses too.
		expect(() => facts?.hasPendingMessages()).toThrow(LoopHookCallEndedError);
		expect(() => facts?.getActiveTools()).toThrow(LoopHookCallEndedError);
		expect(() => facts?.getSystemPromptOptions()).toThrow(LoopHookCallEndedError);
		expect(effects?.wakes).toEqual([{ op: "arm", wake: WAKE }]);
		expect(effects?.relocation).toBeUndefined();
	});

	it("work landing after the reply was built, before the call's finally, is refused or goes to the late route", async () => {
		const late: unknown[] = [];
		const route: LateLoopRoute = (sessionId) => ({
			sendMessage: (message) => late.push([sessionId, message.content]),
			notify: () => {},
			appendEntry: () => {},
			sendUserMessage: () => {},
		});
		const call = createLoopHookCall(route);
		let effects: LoopHookEffects | undefined;

		const reply = await call.run(BINDING, async (collected) => {
			effects = collected;
			const facts = call.current();
			const wakes = facts?.sessionWakes();
			const relocation = facts?.relocationHost();
			const send = call.sender();
			wakes?.arm({ ...WAKE });
			const built = await effectsReply(collected);
			// The call's work runs on after its reply was built and before this dispatch returns to the call's finally.
			expect(() => wakes?.arm({ ...WAKE, id: "w2" })).toThrow(LoopHookCallEndedError);
			await expect(relocation?.request({ target: "studio", reason: "late" })).rejects.toThrow(
				LoopHookCallEndedError,
			);
			send?.({ customType: "late", content: "after the reply", display: true });
			return built;
		});
		const next = await call.run(BINDING, (collected) => effectsReply(collected));

		expect(reply).toEqual({ wakes: [{ op: "arm", wake: WAKE }] });
		expect(effects?.wakes).toEqual([{ op: "arm", wake: WAKE }]);
		expect(effects?.relocation).toBeUndefined();
		expect(effects?.sent).toEqual([]);
		expect(late).toEqual([["s1", "after the reply"]]);
		expect(next).toEqual({});
	});

	it("a late message reaches the loop exactly once, whether or not the next call throws", async () => {
		const late: unknown[] = [];
		const route: LateLoopRoute = (sessionId) => ({
			sendMessage: (message) => late.push([sessionId, message.content]),
			notify: () => {},
			appendEntry: () => {},
			sendUserMessage: () => {},
		});
		const call = createLoopHookCall(route);
		let send: ReturnType<typeof call.sender>;
		await call.run(BINDING, async () => {
			send = call.sender();
		});
		send?.({ customType: "late", content: "held", display: true });

		await expect(
			call.run(BINDING, async () => {
				throw new Error("dispatch failed");
			}),
		).rejects.toThrow("dispatch failed");
		const after = await call.run(BINDING, (collected) => effectsReply(collected));

		expect(late).toEqual([["s1", "held"]]);
		expect(after).toEqual({});
	});
});
