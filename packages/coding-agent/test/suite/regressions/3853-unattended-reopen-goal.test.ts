import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import goalExtension from "../../../src/core/extensions/builtin/goal/index.ts";
import { readGoal, updateGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../../src/core/extensions/builtin/goal/store-ref.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#3853 (idle quota drain): a session that stopped with an ACTIVE goal is parked, the host
// restarts and reopens it with `session_start` reason "resume" and nobody attached. Before the fix the
// goal extension queued a continuation on that reopen and every continuation queued the next: 43
// provider calls in about a minute with no client and no input. An unattended reopen must hold every
// engine-originated turn until real input or an explicit Resume. Attaching releases nothing.

const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
});

type FirstSignal = "held" | "turn";

function firstSignal(h: Harness, timeoutMs: number): Promise<FirstSignal | "timeout"> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			unsubscribe();
			resolve("timeout");
		}, timeoutMs);
		const unsubscribe = h.session.subscribe((event: AgentSessionEvent) => {
			const signal: FirstSignal | undefined =
				event.type === "agent_start"
					? "turn"
					: event.type === "entry_appended" &&
							event.entry.type === "custom" &&
							event.entry.customType === "session-notice"
						? "held"
						: undefined;
			if (signal === undefined) return;
			clearTimeout(timer);
			unsubscribe();
			resolve(signal);
		});
	});
}

async function parkedSessionWithActiveGoal(): Promise<{ readonly a: Harness; readonly file: string }> {
	const a = await createHarness({ persistSession: true, extensionFactories: [(pi) => goalExtension(pi)] });
	harnesses.push(a);
	await a.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	a.setResponses([
		fauxAssistantMessage([fauxToolCall("create_goal", { objective: "Keep the docs current" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxText("Goal created; stopping here.")]),
	]);
	await a.session.prompt("set a goal and stop");
	const file = a.sessionManager.getSessionFile();
	if (!file) throw new Error("the session was not persisted");
	return { a, file };
}

it("a host reopen with no client holds the goal continuation and makes zero provider calls", async () => {
	const { a, file } = await parkedSessionWithActiveGoal();
	a.session.dispose();

	const b = await createHarness({
		siblingOf: a,
		sessionManager: SessionManager.open(file),
		extensionFactories: [(pi) => goalExtension(pi)],
		sessionStartEvent: { type: "session_start", reason: "resume", attended: false },
	});
	harnesses.push(b);
	b.setResponses(Array.from({ length: 40 }, (_, i) => fauxAssistantMessage([fauxText(`still working ${i}`)])));
	const before = b.faux.state.callCount;
	const goalBefore = await readGoal(goalStoreRef(b.sessionManager, b.session.cwd));

	const signal = firstSignal(b, 10_000);
	await b.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });

	expect(await signal).toBe("held");
	expect(b.faux.state.callCount - before).toBe(0);
	expect(b.events.some((event) => event.type === "agent_start")).toBe(false);
	const goal = await readGoal(goalStoreRef(b.sessionManager, b.session.cwd));
	expect(goal?.consecutiveContinuations).toBe(goalBefore?.consecutiveContinuations);
});

it("Resume revalidates a goal completed while held without charging or replaying it", async () => {
	const { a, file } = await parkedSessionWithActiveGoal();
	a.session.dispose();
	const b = await createHarness({
		siblingOf: a,
		sessionManager: SessionManager.open(file),
		extensionFactories: [(pi) => goalExtension(pi)],
		sessionStartEvent: { type: "session_start", reason: "resume", attended: false },
	});
	harnesses.push(b);
	await b.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	const before = b.faux.state.callCount;
	await updateGoal(goalStoreRef(b.sessionManager, b.session.cwd), { status: "complete" }, "model");
	await b.session.resumeSession();
	expect(b.faux.state.callCount).toBe(before);
	expect(b.session.messages.filter((m) => m.role === "custom" && m.customType === "goal-continuation")).toEqual([]);
});

it("user input gets one coalesced turn before a freshly rendered current goal continuation", async () => {
	const { a, file } = await parkedSessionWithActiveGoal();
	a.session.dispose();
	const b = await createHarness({
		siblingOf: a,
		sessionManager: SessionManager.open(file),
		extensionFactories: [(pi) => goalExtension(pi)],
		sessionStartEvent: { type: "session_start", reason: "resume", attended: false },
	});
	harnesses.push(b);
	await b.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	await updateGoal(goalStoreRef(b.sessionManager, b.session.cwd), { objective: "The replacement objective" }, "user");
	for (let i = 0; i < 3; i++) {
		await b.session.sendCustomMessage(
			{ customType: "senpi-codemode:notification", content: `completion ${i}`, display: false },
			{ triggerTurn: true },
		);
	}
	b.setResponses([
		fauxAssistantMessage([fauxText("User input handled.")]),
		fauxAssistantMessage([fauxToolCall("update_goal", { status: "complete" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("Goal complete.")]),
	]);
	const before = b.faux.state.callCount;
	const completed = new Promise<void>((resolve) => {
		const unsubscribe = b.session.subscribe((event) => {
			if (event.type === "agent_idle" && b.faux.state.callCount - before === 3) {
				unsubscribe();
				resolve();
			}
		});
	});
	await b.session.prompt("continue with the replacement");
	await completed;
	expect(b.faux.state.callCount - before).toBe(3);
	expect(b.events.filter((event) => event.type === "agent_start")).toHaveLength(2);
	const continuations = b.session.messages.filter((m) => m.role === "custom" && m.customType === "goal-continuation");
	expect(continuations).toHaveLength(1);
	expect(continuations[0]).toMatchObject({ content: expect.stringContaining("The replacement objective") });
}, 15_000);
