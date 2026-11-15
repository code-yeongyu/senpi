// senpi#6754 (review L2 on #6780, L1/L3 on #6784): a call ends when its reply is built, not later when its finally
// runs. From then on its wake port and relocation host refuse with `LoopHookCallEndedError` and its messages ride the
// next reply, so no write is accepted into effects a reply already carried.
import { describe, expect, it } from "vitest";
import type { SessionRelocationHost } from "../../src/core/session-relocation.ts";
import type { SessionWakePort } from "../../src/core/session-wakes.ts";
import { type CarriedSession, createLoopHookCall } from "../../src/modes/rpc/loop-hook-call.ts";
import { effectsReply, type LoopHookEffects } from "../../src/modes/rpc/loop-hook-effects.ts";
import { LoopHookCallEndedError } from "../../src/modes/rpc/loop-hook-session.ts";

const WAKE = { id: "w1", source: "schedule_prompt", dueAt: 2, prompt: "check", createdAt: 1 } as const;
const CARRIED: CarriedSession = {
	leafId: null,
	handEntries: [],
	wakes: [],
	relocation: { targets: [{ name: "studio", online: true }] },
};

describe("a call's session ports end with the call (senpi#6754)", () => {
	it("a wake port or relocation host used after its call ended refuses and changes nothing the call collected", async () => {
		const call = createLoopHookCall();
		let wakes: SessionWakePort | undefined;
		let relocation: SessionRelocationHost | undefined;
		let effects: LoopHookEffects | undefined;

		await call.run(
			"s1",
			"/work",
			false,
			async (collected) => {
				effects = collected;
				wakes = call.current()?.sessionWakes();
				relocation = call.current()?.relocationHost();
				wakes?.arm({ ...WAKE });
			},
			CARRIED,
		);

		expect(() => wakes?.arm({ ...WAKE, id: "w2" })).toThrow(LoopHookCallEndedError);
		expect(() => wakes?.cancel("w1")).toThrow(LoopHookCallEndedError);
		await expect(relocation?.request({ target: "studio", reason: "late" })).rejects.toThrow(LoopHookCallEndedError);
		expect(effects?.wakes).toEqual([{ op: "arm", wake: WAKE }]);
		expect(effects?.relocation).toBeUndefined();
	});

	it("work landing after the reply was built, before the call's finally, is refused or rides the next reply", async () => {
		const call = createLoopHookCall();
		let effects: LoopHookEffects | undefined;

		const reply = await call.run(
			"s1",
			"/work",
			false,
			async (collected) => {
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
			},
			CARRIED,
		);
		const next = await call.run("s1", "/work", false, (collected) => effectsReply(collected), CARRIED);

		expect(reply).toEqual({ wakes: [{ op: "arm", wake: WAKE }] });
		expect(effects?.wakes).toEqual([{ op: "arm", wake: WAKE }]);
		expect(effects?.relocation).toBeUndefined();
		expect(effects?.sent).toEqual([]);
		expect(next).toEqual({ sent: [{ message: { customType: "late", content: "after the reply", display: true } }] });
	});
});
