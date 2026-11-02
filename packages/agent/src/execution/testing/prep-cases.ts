import type { JsonObject } from "@earendil-works/pi-ai";
import type { CaseImplementation } from "../../conformance/runner.ts";
import { expectEqual } from "../../durable/testing/store-harness.ts";
import type { ExecutionEntry, FrozenCall } from "../ledger-types.ts";

/**
 * PREP-01..04: the prepared executor runs today's preparation once, in today's order, under the execution ledger.
 * The cases drive an executor adapter around one fixture tool, `qa`: inactive until the executor activates it, with a
 * shim that maps `{legacy:"42"}` to `{value:42}`, a schema that requires a number, and an ordered `tool_call` chain.
 * No conformance host provides the executor adapter yet, so these cases are run by the executor's own tests and are
 * not in `CONFORMANCE_REGISTRY`.
 */
export interface PrepFixtureOptions {
	/** A last `tool_call` handler replaces the call's arguments with these values. */
	readonly rewrite?: JsonObject;
	/** A last `tool_call` handler blocks the call with this reason. */
	readonly block?: string;
}

export type PrepOutcome =
	| { readonly kind: "prepared"; readonly call: FrozenCall }
	| { readonly kind: "blocked"; readonly reason: string }
	| { readonly kind: "refused"; readonly reason: string };

export type ReleaseOutcome =
	| { readonly kind: "settled"; readonly text: string; readonly isError: boolean }
	| { readonly kind: "replayed" }
	| { readonly kind: "refused"; readonly reason: string };

export interface PrepFixture {
	/** The `tool_call` chain's own trace steps, in registration order (for example a PreToolUse shell hook). */
	readonly handlerSteps: readonly string[];
	prepare(id: string, args: JsonObject): Promise<PrepOutcome>;
	release(id: string): Promise<ReleaseOutcome>;
	/** `effect` when effect_possible became durable, then `activate`, `shim`, each handler step and `body(<value>)`. */
	trace(): readonly string[];
	/** Replace the executor with a fresh instance over the same store, after the ledger's restart recovery. */
	restart(): Promise<void>;
	/** The execution row read through a ledger reopened on the same store. */
	row(id: string): Promise<ExecutionEntry | undefined>;
}

export interface PrepCaseAdapters {
	readonly executor: { open(options?: PrepFixtureOptions): Promise<PrepFixture> };
}

type PrepCase = CaseImplementation<PrepCaseAdapters>;

const LEGACY = { legacy: "42" } as const;

function preparedCall(outcome: PrepOutcome): FrozenCall {
	if (outcome.kind !== "prepared") throw new Error(`expected a prepared call, got ${JSON.stringify(outcome)}`);
	return outcome.call;
}

function count(trace: readonly string[], step: string): number {
	return trace.filter((entry) => entry === step).length;
}

const shim: PrepCase = async ({ executor }) => {
	const fixture = await executor.open();
	const call = preparedCall(await fixture.prepare("prep-01", LEGACY));
	expectEqual({ name: call.name, args: call.args }, { name: "qa", args: { value: 42 } }, "shim output is frozen");
	const trace = fixture.trace();
	expectEqual(count(trace, "shim"), 1, "the shim runs once");
	expectEqual(trace.indexOf("effect") < trace.indexOf("shim"), true, "the shim runs after effect_possible");

	const invalid = await executor.open();
	expectEqual((await invalid.prepare("prep-01-invalid", { value: "bad" })).kind, "blocked", "validation blocks");
	expectEqual(invalid.trace(), ["effect", "activate", "shim"], "no handler runs after a failed validation");
	const row = await invalid.row("prep-01-invalid");
	const outcome = row?.progress.state === "settled" ? row.progress.outcome.reason : row?.progress.state;
	expectEqual(
		{ outcome, effectPossible: row?.effectPossible },
		{ outcome: "blocked", effectPossible: true },
		"an invalid call settles blocked, with nothing frozen",
	);
};

const activationOrder: PrepCase = async ({ executor }) => {
	const fixture = await executor.open();
	preparedCall(await fixture.prepare("prep-02", LEGACY));
	const prepared = ["effect", "activate", "shim", ...fixture.handlerSteps];
	expectEqual(fixture.trace(), prepared, "preparation runs in today's order after effect_possible");
	expectEqual((await fixture.release("prep-02")).kind, "settled", "release runs the body");
	expectEqual(fixture.trace(), [...prepared, "body(42)"], "the body follows the frozen preparation");
};

const handlersOnce: PrepCase = async ({ executor }) => {
	const fixture = await executor.open();
	const [first, concurrent] = await Promise.all([
		fixture.prepare("prep-03", LEGACY),
		fixture.prepare("prep-03", LEGACY),
	]);
	const resent = await fixture.prepare("prep-03", LEGACY);
	expectEqual([concurrent, resent], [first, first], "a re-sent prepare returns the stored reply");
	const released = await fixture.release("prep-03");
	expectEqual(released.kind, "settled", "first release settles");
	expectEqual((await fixture.release("prep-03")).kind === "settled", false, "a re-sent release never reruns the body");
	expectEqual(
		(await fixture.prepare("prep-03", LEGACY)).kind === "blocked",
		false,
		"a prepare after release never reruns preparation",
	);
	const trace = fixture.trace();
	for (const step of ["effect", "activate", "shim", ...fixture.handlerSteps, "body(42)"]) {
		expectEqual(count(trace, step), 1, `${step} runs exactly once`);
	}
};

const frozenCall: PrepCase = async ({ executor }) => {
	const plain = preparedCall(await (await executor.open()).prepare("prep-04", LEGACY));
	const fixture = await executor.open({ rewrite: { value: 43 } });
	const raw: { legacy: string } = { legacy: "42" };
	const call = preparedCall(await fixture.prepare("prep-04", raw));
	expectEqual(call.args, { value: 43 }, "the frozen call is what the tool_call chain left");
	expectEqual(call.digest === plain.digest, false, "the digest binds the frozen arguments");
	expectEqual((await fixture.row("prep-04"))?.progress, { state: "prepared", call }, "the frozen call is durable");
	raw.legacy = "7";
	expectEqual(await fixture.release("prep-04"), { kind: "settled", text: "qa:43", isError: false }, "body result");
	expectEqual(fixture.trace().at(-1), "body(43)", "release runs the body with the frozen arguments");

	const blocked = await executor.open({ block: "held by policy" });
	expectEqual(
		await blocked.prepare("prep-04-blocked", LEGACY),
		{ kind: "blocked", reason: "held by policy" },
		"block",
	);
	expectEqual((await blocked.release("prep-04-blocked")).kind, "refused", "a blocked call cannot be released");
	expectEqual(
		blocked.trace().some((step) => step.startsWith("body(")),
		false,
		"a blocked call never reaches the body",
	);
};

const storedReplies: PrepCase = async ({ executor }) => {
	for (const [options, args] of [
		[{}, LEGACY],
		[{ block: "held by policy" }, LEGACY],
		[{}, { value: "bad" }],
	] as const) {
		const fixture = await executor.open(options);
		const first = await fixture.prepare("prep-05", args);
		const steps = fixture.trace();
		await fixture.restart();
		expectEqual(await fixture.prepare("prep-05", args), first, `re-sent ${first.kind} reply after restart`);
		expectEqual(fixture.trace(), steps, "a re-sent prepare after restart reruns no preparation step");
		const row = await fixture.row("prep-05");
		expectEqual(
			row?.progress.state === "preparing",
			false,
			`a ${first.kind} preparation leaves no row in preparing for restart recovery`,
		);
	}
};

export const PREP_CASES: ReadonlyMap<string, PrepCase> = new Map([
	["PREP-01", shim],
	["PREP-02", activationOrder],
	["PREP-03", handlersOnce],
	["PREP-04", frozenCall],
	["PREP-05", storedReplies],
]);
