// senpi#6767 review: on the brain, a hand's wake is delivered with the guards a local notifier applies (M2), and only to
// a loop session of the scope that sent it (L3).
import { join } from "node:path";
import { WakeRefusedError } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { deliverHandWake, scopeSessionCheck } from "../../src/core/execution/wake-delivery.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";
import { openHandWakeOutbox } from "../../src/modes/hand/hand-wakes.ts";
import { createHarness, type Harness } from "../suite/harness.ts";
import { brainInbox, connect, observed, within } from "./hand-wake-fixture.ts";
import { cleanupHands, handDirs } from "./remote-hand-fixture.ts";

const cleanups: Array<() => void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	await cleanupHands();
});

const exitNotice = {
	eventId: "hand:1",
	scope: "s",
	source: "message",
	payload: {
		message: { customType: "senpi-terminal:notification", content: "finished", display: false },
		options: { triggerTurn: true, deliverAs: "followUp" },
	},
};

async function brainSession(mode: "print" | "tui") {
	let pi: ExtensionAPI | undefined;
	let ctx: ExtensionContext | undefined;
	const loop: Harness = await createHarness({
		extensionFactories: [
			(api) => {
				pi = api;
				api.on("session_start", (_event, context) => void (ctx = context));
			},
		],
	});
	cleanups.push(() => loop.cleanup());
	await loop.session.bindExtensions({ mode });
	if (pi === undefined) throw new Error("the brain's extension did not load");
	return { loop, pi, context: () => ctx };
}

describe("a hand's wake on the brain", () => {
	it("never starts a turn in a one-shot (print) session: a late exit notice cannot make it spin", async () => {
		const { loop, pi, context } = await brainSession("print");
		loop.setResponses([fauxAssistantMessage("spun")]);

		const outcome = deliverHandWake(exitNotice, {
			sendMessage: pi.sendMessage,
			sendUserMessage: pi.sendUserMessage,
			appendEntry: pi.appendEntry,
			notify: () => {},
			context,
		});
		await within(loop.session.waitForSettledSessionWork(), "the brain settling");

		expect(outcome).toBe("skipped");
		expect(loop.faux.getCallLog()).toEqual([]);
	});

	it("starts no turn in a session without a model, and still delivers what starts none", () => {
		const done: string[] = [];
		const session = {
			sendMessage: () => void done.push("message"),
			sendUserMessage: () => void done.push("user_message"),
			appendEntry: () => void done.push("entry"),
			notify: () => void done.push("notice"),
			context: () => ({ mode: "tui", model: undefined }),
		};
		const userMessage = { eventId: "hand:2", scope: "s", source: "user_message", payload: { content: "continue" } };
		const entry = { eventId: "hand:3", scope: "s", source: "entry", payload: { customType: "stop-state" } };

		expect([exitNotice, userMessage, entry].map((wake) => deliverHandWake(wake, session))).toEqual([
			"skipped",
			"skipped",
			"delivered",
		]);
		expect(done).toEqual(["entry"]);
	});

	it("refuses, and never commits, a wake naming a loop session that is not its scope's", async () => {
		const brain = await brainInbox();
		const refused = Promise.withResolvers<void>();
		const dirs = await handDirs("h3-session-check");
		const outbox = observed(await openHandWakeOutbox(join(dirs.agentDir, "hand-wakes.json")), {
			refused: refused.resolve,
		});
		const check = scopeSessionCheck((scope) => (scope === "s" ? new Set(["mine"]) : undefined));
		const link = connect(brain, outbox, { check });
		cleanups.push(() => link.close());

		await link.hand.offer({ scope: "s", source: "notice", payload: { message: "hi", sessionId: "someone-else" } });
		await within(refused.promise, "the refusal");

		expect(brain.committed.all).toEqual([]);
		expect(brain.faults).toEqual([expect.any(WakeRefusedError)]);
		expect(brain.faults[0]).toMatchObject({ reason: "not_scope_session" });
		expect(await outbox.due()).toEqual([]);
	});
});
