import { afterEach, expect, it } from "vitest";
import { createGoal, updateGoal, writeGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import { GOAL_STORE_CHANGED_EVENT } from "../../../src/core/extensions/builtin/goal/store-changed-event.ts";
import { goalStoreRef } from "../../../src/core/extensions/builtin/goal/store-ref.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { nextSessionEvent } from "../lifecycle-test-harness.ts";
import { createIdentityHarness } from "../rpc-client-identity-harness.ts";

// senpi#3864: occurrence identities survive missed closes and process restoration.
type Fixture = Awaited<ReturnType<typeof createIdentityHarness>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0).reverse()) await fixture.cleanup();
});

async function setup() {
	let api: ExtensionAPI | undefined;
	const fixture = await createIdentityHarness({
		extensionFactories: [
			(pi) => {
				api = pi;
			},
		],
	});
	fixtures.push(fixture);
	await fixture.session.bindExtensions({ mode: "rpc" });
	expect(fixture.session.lifecycle).toBeDefined();
	const ref = goalStoreRef(fixture.harness.sessionManager, fixture.harness.tempDir);
	const goal = await createGoal(ref, "Complete the review");
	return {
		fixture,
		ref,
		goal,
		publish() {
			if (!api) throw new Error("The extension API must be bound");
			api.events.emit(GOAL_STORE_CHANGED_EVENT, { threadId: fixture.session.sessionId });
		},
	};
}

it("gives a blocked goal a new identity after it closed and blocked again", async () => {
	const { fixture, ref, publish } = await setup();
	const firstWait = nextSessionEvent(
		fixture.harness,
		(event) =>
			event.type === "session_lifecycle" &&
			event.lifecycle.waitingOn?.human.some((wait) => wait.kind === "goal_blocked") === true,
	);
	await updateGoal(ref, { status: "blocked", reason: "Review needed" }, "model");
	publish();
	await firstWait;
	const first = fixture.session.lifecycle.waitingOn?.human.find((wait) => wait.kind === "goal_blocked");
	expect(first).toBeDefined();
	const closed = nextSessionEvent(
		fixture.harness,
		(event) =>
			event.type === "session_lifecycle" &&
			!event.lifecycle.waitingOn?.human.some((wait) => wait.kind === "goal_blocked"),
	);
	await updateGoal(ref, { status: "active" }, "user");
	publish();
	await closed;
	const secondWait = nextSessionEvent(
		fixture.harness,
		(event) =>
			event.type === "session_lifecycle" &&
			event.lifecycle.waitingOn?.human.some(
				(wait) => wait.kind === "goal_blocked" && wait.requestId !== first?.requestId,
			) === true,
	);
	await updateGoal(ref, { status: "blocked", reason: "Review still needed" }, "model");
	publish();
	await secondWait;
	expect(fixture.session.lifecycle).toMatchObject({ state: "waiting_human", persisted: true });
});

it("preserves an open blocked occurrence across restart", async () => {
	const { fixture, ref, publish } = await setup();
	const waiting = nextSessionEvent(
		fixture.harness,
		(event) => event.type === "session_lifecycle" && event.lifecycle.state === "waiting_human",
	);
	await updateGoal(ref, { status: "blocked", reason: "Review needed" }, "model");
	publish();
	await waiting;
	const before = fixture.session.lifecycle.waitingOn?.human.find((wait) => wait.kind === "goal_blocked");
	await fixture.reopen();
	await fixture.session.bindExtensions({ mode: "rpc" });
	expect(fixture.session.lifecycle.waitingOn?.human).toContainEqual(before);
});

it("does not reuse a blocked identity when the close happened before restart", async () => {
	const { fixture, ref, publish } = await setup();
	const waiting = nextSessionEvent(
		fixture.harness,
		(event) => event.type === "session_lifecycle" && event.lifecycle.state === "waiting_human",
	);
	await updateGoal(ref, { status: "blocked", reason: "Review needed" }, "model");
	publish();
	await waiting;
	const before = fixture.session.lifecycle.waitingOn?.human[0]?.requestId;
	const closed = nextSessionEvent(
		fixture.harness,
		(event) =>
			event.type === "session_lifecycle" &&
			!event.lifecycle.waitingOn?.human.some((wait) => wait.requestId === before),
	);
	await updateGoal(ref, { status: "active" }, "user");
	publish();
	await closed;
	await fixture.reopen();
	await updateGoal(ref, { status: "blocked", reason: "Review needed again" }, "model");
	await fixture.session.bindExtensions({ mode: "rpc" });
	expect(fixture.session.lifecycle.waitingOn?.human[0]?.requestId).not.toBe(before);
	expect(fixture.session.lifecycle.waitingOn?.human[0]?.kind).toBe("goal_blocked");
});

for (const stopped of ["paused", "continuation-stopped"] as const) {
	it(`keeps a ${stopped} goal waiting on a human rather than done`, async () => {
		const { fixture, ref, goal, publish } = await setup();
		const waiting = nextSessionEvent(
			fixture.harness,
			(event) =>
				event.type === "session_lifecycle" &&
				event.lifecycle.waitingOn?.human.some((wait) => wait.kind === "goal_paused") === true,
		);
		if (stopped === "paused") await updateGoal(ref, { status: "paused" }, "user");
		else await writeGoal(ref, { ...goal, continuationStoppedAt: Date.parse("2026-10-21T00:00:00.000Z") });
		publish();
		await waiting;
		expect(fixture.session.lifecycle).toMatchObject({ state: "waiting_human" });
	});
}
