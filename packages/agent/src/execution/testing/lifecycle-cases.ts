import type { CaseImplementation } from "../../conformance/runner.ts";
import { expectEqual } from "../../durable/testing/store-harness.ts";
import type { ScopeBinding } from "../scope-lifecycle.ts";
import type { BatchCaseAdapters } from "./batch-executor.ts";
import { batchHarness } from "./batch-harness.ts";

type LifecycleCase = CaseImplementation<BatchCaseAdapters>;

export const IDLE_TTL_MS = 30_000;

export const bindingOf = (scope: string, issuer = "brain"): ScopeBinding => ({
	issuer,
	workspace: "workspace",
	scope,
	generation: 1,
	allowedRoots: ["/work"],
});

/** LIFECYCLE-01: a call submitted after a lifecycle event runs only once the event's handler effect is committed. */
const commitBeforeNextCall: LifecycleCase = async (adapters) => {
	const h = await batchHarness(adapters);
	const scopes = await h.scopes(IDLE_TTL_MS);
	await scopes.open(bindingOf("A"));
	const order: string[] = [];
	const handlerHeld = Promise.withResolvers<void>();
	const event = scopes.lifecycle("brain", "A", "agent_end", async () => {
		order.push("handler");
		await handlerHeld.promise;
		return { revoked: true };
	});
	const call = scopes.call("A", async () => {
		order.push(`call sees ${(await scopes.read("A"))?.events.length ?? 0} committed event(s)`);
		return "ran";
	});
	handlerHeld.resolve();
	expectEqual(await event, { kind: "committed", seq: 1 }, "the event committed");
	expectEqual(await call, "ran", "the call ran");
	expectEqual(order, ["handler", "call sees 1 committed event(s)"], "the next call follows the commit");
};

/** LIFECYCLE-02: only the scope's issuer submits lifecycle events or closes it. */
const issuerOnly: LifecycleCase = async (adapters) => {
	const h = await batchHarness(adapters);
	const scopes = await h.scopes(IDLE_TTL_MS);
	await scopes.open(bindingOf("A"));
	let ran = false;
	expectEqual(
		await scopes.lifecycle("intruder", "A", "turn_start", async () => {
			ran = true;
			return null;
		}),
		{ kind: "refused", reason: "not_issuer" },
		"a lifecycle event from another party",
	);
	expectEqual(ran, false, "its handler never ran");
	expectEqual(
		await scopes.close("intruder", "A"),
		{ kind: "refused", reason: "not_issuer" },
		"a close from another party",
	);
	expectEqual((await scopes.read("A"))?.state, "open", "still open");
};

/** LIFECYCLE-03: a closed scope admits no lifecycle event and is not reopened under another binding. */
const closedIsTerminal: LifecycleCase = async (adapters) => {
	const h = await batchHarness(adapters);
	const scopes = await h.scopes(IDLE_TTL_MS);
	await scopes.open(bindingOf("A"));
	expectEqual(await scopes.close("brain", "A"), { kind: "closed" }, "closed by its issuer");
	expectEqual(
		await scopes.lifecycle("brain", "A", "turn_start", async () => null),
		{ kind: "refused", reason: "closed" },
		"no event after the close",
	);
	expectEqual(await scopes.open(bindingOf("A")), { kind: "refused", reason: "conflicting_scope" }, "not reopened");
};

export const LIFECYCLE_CASES: ReadonlyMap<string, LifecycleCase> = new Map([
	["LIFECYCLE-01", commitBeforeNextCall],
	["LIFECYCLE-02", issuerOnly],
	["LIFECYCLE-03", closedIsTerminal],
]);
