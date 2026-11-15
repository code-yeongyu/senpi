// senpi#6754 (review L2 on #6780): a wake port or relocation host kept past its call cannot change the session any
// more: the call's writes were already sent with its reply, so a late arm, cancel or move is refused with
// `LoopHookCallEndedError` instead of being recorded where nothing reads it.
import { describe, expect, it } from "vitest";
import type { SessionRelocationHost } from "../../src/core/session-relocation.ts";
import type { SessionWakePort } from "../../src/core/session-wakes.ts";
import { createLoopHookCall, type LateLoopRoute } from "../../src/modes/rpc/loop-hook-call.ts";
import { LoopHookCallEndedError } from "../../src/modes/rpc/loop-hook-session.ts";

const noLateEffects: LateLoopRoute = () => {
	throw new Error("this test's calls send nothing after they ended");
};

const WAKE = { id: "w1", source: "schedule_prompt", dueAt: 2, prompt: "check", createdAt: 1 } as const;

describe("a call's session ports end with the call (senpi#6754)", () => {
	it("a wake port or relocation host used after its call ended refuses, and the reply is unchanged", async () => {
		const call = createLoopHookCall(noLateEffects);
		let wakes: SessionWakePort | undefined;
		let relocation: SessionRelocationHost | undefined;
		let reply: string | undefined;

		const carried = {
			leafId: null,
			handEntries: [],
			wakes: [],
			relocation: { targets: [{ name: "studio", online: true }] },
		};
		await call.run({ sessionId: "s1", cwd: "/work", idle: false, carried }, async (effects) => {
			wakes = call.current()?.sessionWakes();
			relocation = call.current()?.relocationHost();
			wakes?.arm({ ...WAKE });
			reply = JSON.stringify({ wakes: effects.wakes, relocation: effects.relocation });
		});

		expect(() => wakes?.arm({ ...WAKE, id: "w2" })).toThrow(LoopHookCallEndedError);
		expect(() => wakes?.cancel("w1")).toThrow(LoopHookCallEndedError);
		await expect(relocation?.request({ target: "studio", reason: "late" })).rejects.toThrow(LoopHookCallEndedError);
		expect(reply).toBe(JSON.stringify({ wakes: [{ op: "arm", wake: WAKE }] }));
	});
});
