// A loop-hook call's facts on a hand (S33): the session it binds, what its work keeps after it ended, and the late
// effects one loop session holds until its next reply. Split from loop-hook-host.test.ts, which drives a real hand.
import { describe, expect, it } from "vitest";
import { createLoopHookCall, LATE_PER_SESSION, LoopHookCallEndedError } from "../../src/modes/rpc/loop-hook-call.ts";

describe("a loop-hook call's bound session (S33, option A)", () => {
	it("is the loop session's id, read-only, during the call only", async () => {
		const call = createLoopHookCall();
		let during: { id: string; file: string | undefined; idle: boolean } | undefined;
		let captured: ReturnType<typeof call.current>;

		await call.run({ sessionId: "loop-session-1", cwd: "/work", idle: true }, async () => {
			captured = call.current();
			const facts = captured;
			if (facts === undefined) throw new Error("no facts inside the call");
			during = {
				id: facts.sessionManager.getSessionId(),
				file: facts.sessionManager.getSessionFile(),
				idle: facts.isIdle(),
			};
			expect(() => facts.sessionManager.getEntries()).toThrow(/loop-side/);
			expect(() => {
				(facts.sessionManager as unknown as Record<string, unknown>).getSessionId = () => "forged";
			}).toThrow(TypeError);
		});

		expect(during).toEqual({ id: "loop-session-1", file: undefined, idle: true });
		expect(call.current()).toBeUndefined();
		expect(() => captured?.sessionManager.getSessionId()).toThrow(LoopHookCallEndedError);
		expect(() => captured?.sessionManager.getSessionId()).toThrow(
			expect.objectContaining({ name: "LoopHookCallEndedError", member: "sessionManager.getSessionId" }),
		);
		expect(captured?.signal.aborted).toBe(true);
	});

	it("holds late messages up to its cap, then drops the oldest and counts them, never throwing", async () => {
		const call = createLoopHookCall();
		let kept: ReturnType<typeof call.current>;
		await call.run({ sessionId: "loop-session-3", cwd: "/work", idle: true }, async () => {
			kept = call.current();
		});

		for (let index = 0; index < LATE_PER_SESSION + 2; index++)
			expect(() => kept?.sendMessage({ customType: "late", content: `m${index}`, display: false })).not.toThrow();
		const next = await call.run({ sessionId: "loop-session-3", cwd: "/work", idle: true }, async (effects) => ({
			sent: effects.sent.map((entry) => entry.message.content),
			dropped: effects.dropped,
		}));

		expect(next.dropped).toBe(2);
		expect(next.sent).toHaveLength(LATE_PER_SESSION);
		expect(next.sent[0]).toBe("m2");
	});

	it("past its cap drops held notices before any message: messages reach the model, notices only the UI", async () => {
		const call = createLoopHookCall();
		let kept: ReturnType<typeof call.current>;
		await call.run({ sessionId: "loop-session-4", cwd: "/work", idle: true }, async () => {
			kept = call.current();
		});

		kept?.notify("oldest-notice");
		for (let index = 0; index < LATE_PER_SESSION; index++)
			kept?.sendMessage({ customType: "late", content: `m${index}`, display: false });
		const next = await call.run({ sessionId: "loop-session-4", cwd: "/work", idle: true }, async (effects) => ({
			sent: effects.sent.map((entry) => entry.message.content),
			notices: effects.notices.map((entry) => entry.message),
			dropped: effects.dropped,
		}));

		expect(next).toEqual({
			sent: Array.from({ length: LATE_PER_SESSION }, (_, index) => `m${index}`),
			notices: [],
			dropped: 1,
		});
	});

	it("past its cap drops notices, then messages, then user messages, and a held entry last (#6751 review L3)", async () => {
		const call = createLoopHookCall();
		let kept: ReturnType<typeof call.current>;
		await call.run({ sessionId: "loop-session-5", cwd: "/work", idle: true }, async () => {
			kept = call.current();
		});

		// The oldest held effect is a stop-state entry: dropping it would lower the Stop reentry count.
		kept?.appendEntry("senpi.hooks.stop-state", { count: 7 });
		kept?.notify("notice");
		kept?.sendMessage({ customType: "late", content: "m0", display: false });
		kept?.sendMessage({ customType: "late", content: "m1", display: false });
		for (let index = 0; index < LATE_PER_SESSION; index++) kept?.sendUserMessage(`u${index}`);
		const next = await call.run({ sessionId: "loop-session-5", cwd: "/work", idle: true }, async (effects) => ({
			entries: effects.entries.map((entry) => entry.customType),
			notices: effects.notices.length,
			sent: effects.sent.length,
			userMessages: effects.userMessages.map((entry) => entry.content),
			dropped: effects.dropped,
		}));

		expect(next).toEqual({
			entries: ["senpi.hooks.stop-state"],
			notices: 0,
			sent: 0,
			userMessages: Array.from({ length: LATE_PER_SESSION - 1 }, (_, index) => `u${index + 1}`),
			dropped: 4,
		});
	});

	it("has pending messages only for user messages it sent, not late ones it carries (#6751 review L2)", async () => {
		const call = createLoopHookCall();
		let kept: ReturnType<typeof call.current>;
		await call.run({ sessionId: "loop-session-6", cwd: "/work", idle: true }, async () => {
			kept = call.current();
		});
		kept?.sendUserMessage("late from an earlier call");

		const pending = await call.run({ sessionId: "loop-session-6", cwd: "/work", idle: true }, async (effects) => {
			const facts = call.current();
			const before = { carried: effects.userMessages.length, pending: facts?.hasPendingMessages() };
			facts?.sendUserMessage("its own");
			return [before, facts?.hasPendingMessages()];
		});

		expect(pending).toEqual([{ carried: 1, pending: false }, true]);
	});

	it("keeps the session it carried for its own work after it ended, and its identity for the call only (#6751 M1)", async () => {
		const call = createLoopHookCall();
		const handEntries = [
			{ type: "custom" as const, id: "h1", parentId: null, timestamp: "t", customType: "x", data: 1 },
		];
		const resume = Promise.withResolvers<void>();
		let kept: ReturnType<typeof call.current>;
		let ownWork: Promise<unknown> | undefined;
		await call.run(
			{ sessionId: "loop-session-7", cwd: "/work", idle: false, carried: { leafId: "leaf-7", handEntries } },
			async () => {
				const facts = call.current();
				kept = facts;
				// Work the call started, which runs after it ended (a Stop held for background work).
				ownWork = resume.promise.then(() => {
					const session = facts?.sessionManager;
					let identity: unknown = "answered";
					try {
						session?.getSessionId();
					} catch (error) {
						identity = error;
					}
					const entries = session?.reduceHistory({ initial: () => 0, add: (count: number) => count + 1 });
					return { leafId: session?.getLeafId(), entries, identity };
				});
			},
		);
		resume.resolve();

		expect(await ownWork).toEqual({
			leafId: "leaf-7",
			entries: 1,
			identity: expect.objectContaining({ name: "LoopHookCallEndedError", member: "sessionManager.getSessionId" }),
		});
		// The same reader from any other work is refused: a kept context does not carry the session elsewhere.
		expect(() => kept?.sessionManager.getLeafId()).toThrow(LoopHookCallEndedError);
	});

	it("for work that holds it, answers idle after a turn's end until a turn is seen running (#6751 M1, L2; #6770 M1)", async () => {
		const call = createLoopHookCall();
		const session = { sessionId: "loop-session-8", cwd: "/work" };
		let kept: ReturnType<typeof call.current>;
		let release: (() => void) | undefined;
		await call.run({ ...session, idle: false, turn: "ended" }, async () => {
			kept = call.current();
			release = kept?.holdIdle();
			expect(kept?.isIdle()).toBe(false);
		});
		const afterTurn = kept?.isIdle();
		// A call that proves no running turn (an input the loop handles itself, a preview) leaves the session idle.
		await call.run({ ...session, idle: true }, async () => {});
		const afterOtherCall = kept?.isIdle();
		await call.run({ ...session, idle: false, turn: "running" }, async () => {});
		const afterRunning = kept?.isIdle();
		release?.();

		expect([afterTurn, afterOtherCall, afterRunning]).toEqual([true, true, false]);
	});

	it("without a hold, keeps the idle value it carried after it ended", async () => {
		const call = createLoopHookCall();
		let kept: ReturnType<typeof call.current>;
		await call.run({ sessionId: "loop-session-10", cwd: "/work", idle: false, turn: "ended" }, async () => {
			kept = call.current();
		});

		expect(kept?.isIdle()).toBe(false);
	});

	it("a turn that starts while the call ending the previous one still runs wins over it (#6770 review L2)", async () => {
		const call = createLoopHookCall();
		const session = { sessionId: "loop-session-9", cwd: "/work" };
		const release = Promise.withResolvers<void>();
		let kept: ReturnType<typeof call.current>;
		let hold: (() => void) | undefined;
		const ending = call.run({ ...session, idle: false, turn: "ended" }, async () => {
			kept = call.current();
			hold = kept?.holdIdle();
			await release.promise;
		});
		// The loop gave up on a slow agent_end and started the next turn while the hand still runs it.
		await call.run({ ...session, idle: false, turn: "running" }, async () => {});
		release.resolve();
		await ending;
		const idle = kept?.isIdle();
		hold?.();

		expect(idle).toBe(false);
	});

	it("is not visible to work that runs outside the call", async () => {
		const call = createLoopHookCall();
		const outside = Promise.withResolvers<ReturnType<typeof call.current>>();

		await call.run({ sessionId: "loop-session-2", cwd: "/work", idle: true }, async () => {});
		queueMicrotask(() => outside.resolve(call.current()));

		expect(await outside.promise).toBeUndefined();
	});
});
