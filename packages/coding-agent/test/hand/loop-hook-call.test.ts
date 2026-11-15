// A loop-hook call's facts on a hand (S33): the session it binds, what its work keeps after it ended, and the late
// effects that go to its session's late route. Split from loop-hook-host.test.ts, which drives a real hand.
import { describe, expect, it } from "vitest";
import { createLoopHookCall, type LateLoopRoute } from "../../src/modes/rpc/loop-hook-call.ts";
import { LoopHookCallEndedError } from "../../src/modes/rpc/loop-hook-session.ts";

/** A late route that records what reaches it, as `[sessionId, kind, what]`. */
function recordingRoute(): { readonly late: unknown[]; readonly route: LateLoopRoute } {
	const late: unknown[] = [];
	return {
		late,
		route: (sessionId) => ({
			sendMessage: (message) => void late.push([sessionId, "message", message.content]),
			sendUserMessage: (content) => void late.push([sessionId, "user_message", content]),
			appendEntry: (customType) => void late.push([sessionId, "entry", customType]),
			notify: (message) => void late.push([sessionId, "notice", message]),
		}),
	};
}

const noLateEffects: LateLoopRoute = () => {
	throw new Error("this test's calls have no work that outlives them");
};

describe("a loop-hook call's bound session (S33, option A)", () => {
	it("is the loop session's id, read-only, during the call only", async () => {
		const call = createLoopHookCall(noLateEffects);
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

	it("sends every kind of effect its work makes after it ended to its session's late route, in order (H3)", async () => {
		const { late, route } = recordingRoute();
		const call = createLoopHookCall(route);
		let kept: ReturnType<typeof call.current>;
		const reply = await call.run({ sessionId: "loop-session-3", cwd: "/work", idle: true }, async (effects) => {
			kept = call.current();
			kept?.sendMessage({ customType: "during", content: "in the reply", display: false });
			return effects;
		});

		// A held Stop's stop state and its block follow-up are such effects: they must reach an idle loop on their own.
		expect(() => kept?.appendEntry("senpi.hooks.stop-state", { count: 7 })).not.toThrow();
		expect(() => kept?.sendUserMessage("continue: the stop hook blocked")).not.toThrow();
		kept?.notify("n0");
		kept?.sendMessage({ customType: "late", content: "m0", display: false });

		expect(reply.sent.map((entry) => entry.message.content)).toEqual(["in the reply"]);
		expect(late).toEqual([
			["loop-session-3", "entry", "senpi.hooks.stop-state"],
			["loop-session-3", "user_message", "continue: the stop hook blocked"],
			["loop-session-3", "notice", "n0"],
			["loop-session-3", "message", "m0"],
		]);
	});

	it("has pending messages only for user messages it sent; a late one goes to the late route (#6751 review L2)", async () => {
		const { late, route } = recordingRoute();
		const call = createLoopHookCall(route);
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

		expect(pending).toEqual([{ carried: 0, pending: false }, true]);
		expect(late).toEqual([["loop-session-6", "user_message", "late from an earlier call"]]);
	});

	it("keeps the session it carried for its own work after it ended, and its identity for the call only (#6751 M1)", async () => {
		const call = createLoopHookCall(noLateEffects);
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

	it("after a call that ended the loop's turn, answers idle until the loop starts another call (#6751 M1)", async () => {
		const call = createLoopHookCall(noLateEffects);
		let kept: ReturnType<typeof call.current>;
		await call.run({ sessionId: "loop-session-8", cwd: "/work", idle: false, endsTurn: true }, async () => {
			kept = call.current();
			expect(kept?.isIdle()).toBe(false);
		});
		const afterTurn = kept?.isIdle();
		await call.run({ sessionId: "loop-session-8", cwd: "/work", idle: true }, async () => {});

		expect([afterTurn, kept?.isIdle()]).toEqual([true, false]);
	});

	it("is not visible to work that runs outside the call", async () => {
		const call = createLoopHookCall(noLateEffects);
		const outside = Promise.withResolvers<ReturnType<typeof call.current>>();

		await call.run({ sessionId: "loop-session-2", cwd: "/work", idle: true }, async () => {});
		queueMicrotask(() => outside.resolve(call.current()));

		expect(await outside.promise).toBeUndefined();
	});
});
