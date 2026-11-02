import { describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT, withCancel } from "../src/context/index.ts";
import {
	type Context,
	type ReplicatedState,
	type ReplicatedStateDelivery,
	type ReplicatedStateSourceFrame,
	replicatedState,
} from "../src/index.ts";
import { ReplicatedStateReplica } from "../src/services/state.ts";
import { getReplicatedStateInternals } from "../src/services/state-internals.ts";

type Value = { value: number };
type Kind = "mutable" | "attached" | "replica";

function deferred() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((accept, fail) => {
		resolve = accept;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function fixture(kind: Kind, onError: (error: Error) => void = () => {}) {
	let state: ReplicatedState<Value>;
	let publish: (value: Value, context: Context) => void;
	if (kind === "mutable") {
		const mutable = replicatedState({ value: 0 });
		state = mutable;
		publish = (value, context) => mutable.replace(context, value);
	} else if (kind === "attached") {
		let receive!: (frame: ReplicatedStateSourceFrame<Value>) => void;
		state = replicatedState<Value>(
			{
				attach: () => ({
					snapshot: { value: { value: 0 }, cursor: 0 },
					activate: (listener) => {
						receive = listener;
					},
					dispose() {},
				}),
			},
			{ onError },
		);
		publish = (value, context) =>
			receive({ value, cursor: value.value, ops: [["s", ["value"], value.value]], context });
	} else {
		const replica = new ReplicatedStateReplica<Value>(onError);
		replica.hydrate(0, [["r", { value: 0 }]], BACKGROUND_CONTEXT);
		state = replica;
		publish = (value, context) => replica.update(value.value, [["s", ["value"], value.value]], context);
	}
	return { state, publish };
}

describe.each<Kind>(["mutable", "attached", "replica"])("%s public delivery", (kind) => {
	test("awaits hydration and each update independently of other subscribers and exact listeners", async () => {
		const { state, publish } = fixture(kind);
		const hydration = deferred();
		const update = deferred();
		const events: string[] = [];
		const exact: number[] = [];
		const fast: number[] = [];
		getReplicatedStateInternals(state)?.subscribe((_ops, sequence) => exact.push(sequence));
		state.subscribe(async (value) => {
			events.push(`start:${value.value}`);
			if (value.value === 0) await hydration.promise;
			if (value.value === 1) await update.promise;
			events.push(`end:${value.value}`);
		});
		state.subscribe((value) => fast.push(value.value));
		publish({ value: 1 }, BACKGROUND_CONTEXT);
		publish({ value: 2 }, BACKGROUND_CONTEXT);
		expect(events).toEqual(["start:0"]);
		expect(fast).toEqual([0, 1, 2]);
		expect(state.value).toEqual({ value: 2 });
		if (kind !== "replica") expect(exact).toEqual([1, 2]);
		hydration.resolve();
		await vi.waitFor(() => expect(events).toEqual(["start:0", "end:0", "start:1"]));
		update.resolve();
		await vi.waitFor(() => expect(events).toEqual(["start:0", "end:0", "start:1", "end:1", "start:2", "end:2"]));
	});

	test.each([100, 101, 102, 201, 202])(
		"bounds %i pending deliveries without changing exact publication",
		async (count) => {
			const { state, publish } = fixture(kind);
			const hydration = deferred();
			const received: number[] = [];
			const exact: number[] = [];
			getReplicatedStateInternals(state)?.subscribe((_ops, sequence) => exact.push(sequence));
			state.subscribe((value) => {
				received.push(value.value);
				if (value.value === 0) return hydration.promise;
			});
			for (let value = 1; value <= count; value += 1) publish({ value }, BACKGROUND_CONTEXT);
			expect(received).toEqual([0]);
			if (kind !== "replica") expect(exact).toEqual(Array.from({ length: count }, (_, index) => index + 1));
			hydration.resolve();
			await hydration.promise;
			const first = Math.floor((count - 1) / 100) * 100 + 1;
			expect(received).toEqual([0, ...Array.from({ length: count - first + 1 }, (_, index) => first + index)]);
		},
	);

	test("excludes a running update from overflow and retains exact value/context/delivery", async () => {
		const { state, publish } = fixture(kind);
		const gate = deferred();
		const context = withCancel(BACKGROUND_CONTEXT).context;
		const received: { value: Value; context: Context; delivery: ReplicatedStateDelivery }[] = [];
		state.subscribe((value, context, delivery) => {
			received.push({ value, context, delivery });
			if (value.value === 1) return gate.promise;
		});
		for (let value = 1; value < 102; value += 1) publish({ value }, BACKGROUND_CONTEXT);
		const newest = { value: 102 };
		publish(newest, context);
		const adopted = state.value;
		publish({ value: 103 }, BACKGROUND_CONTEXT);
		expect(received.map(({ value }) => value.value)).toEqual([0, 1]);
		gate.resolve();
		await gate.promise;
		expect(received.map(({ value }) => value.value)).toEqual([0, 1, 102, 103]);
		expect(received[2]?.value).toBe(adopted);
		expect(received[2]?.context).toBe(context);
		expect(received[2]?.delivery).toEqual({ kind: "update", sequence: 102 });
	});

	test("serializes reentrant hydration and update callbacks", () => {
		const { state, publish } = fixture(kind);
		const events: string[] = [];
		state.subscribe((value) => {
			events.push(`start:${value.value}`);
			if (value.value < 2) publish({ value: value.value + 1 }, BACKGROUND_CONTEXT);
			events.push(`end:${value.value}`);
		});
		expect(events).toEqual(["start:0", "end:0", "start:1", "end:1", "start:2", "end:2"]);
	});

	test("treats two subscriptions of the same callback independently", async () => {
		const { state, publish } = fixture(kind);
		const gate = deferred();
		const received: number[] = [];
		const listener = (value: Value) => {
			received.push(value.value);
			if (value.value === 0) return gate.promise;
		};
		const stopFirst = state.subscribe(listener);
		const stopSecond = state.subscribe(listener);
		publish({ value: 1 }, BACKGROUND_CONTEXT);
		stopFirst();
		stopFirst();
		gate.resolve();
		await gate.promise;
		expect(received).toEqual([0, 0, 1]);
		stopSecond();
	});

	test("unsubscribe drops queued callbacks without joining or aborting the running callback", async () => {
		const { state, publish } = fixture(kind);
		const gate = deferred();
		const { context } = withCancel(BACKGROUND_CONTEXT);
		const received: number[] = [];
		let completed = false;
		const stop = state.subscribe(async (value) => {
			received.push(value.value);
			if (value.value === 1) {
				await gate.promise;
				completed = true;
			}
		});
		await Promise.resolve();
		publish({ value: 1 }, context);
		publish({ value: 2 }, context);
		expect(stop()).toBeUndefined();
		publish({ value: 3 }, context);
		expect(context.abortSignal?.aborted).toBe(false);
		expect(completed).toBe(false);
		gate.resolve();
		await vi.waitFor(() => expect(completed).toBe(true));
		expect(received).toEqual([0, 1]);
	});
});

describe.each<Kind>(["attached", "replica"])("%s listener errors", (kind) => {
	test("isolates a synchronous hydration failure without removing the subscription", () => {
		const errors: Error[] = [];
		const { state, publish } = fixture(kind, (error) => errors.push(error));
		const received: number[] = [];
		const failure = new Error("sync hydration");
		expect(() =>
			state.subscribe((value) => {
				received.push(value.value);
				if (value.value === 0) throw failure;
			}),
		).not.toThrow();
		publish({ value: 1 }, BACKGROUND_CONTEXT);
		expect(errors).toEqual([failure]);
		expect(received).toEqual([0, 1]);
	});

	test("observes hydration rejection, synchronous throw, and update rejection while continuing delivery", async () => {
		const errors: Error[] = [];
		const { state, publish } = fixture(kind, (error) => errors.push(error));
		const gate = deferred();
		const received: number[] = [];
		const fast: number[] = [];
		state.subscribe((value) => {
			received.push(value.value);
			if (value.value === 0) return gate.promise;
			if (value.value === 1) throw new Error("sync update");
			if (value.value === 2) return Promise.reject(new Error("async update"));
		});
		state.subscribe((value) => fast.push(value.value));
		for (let value = 1; value <= 3; value += 1) publish({ value }, BACKGROUND_CONTEXT);
		gate.reject(new Error("async hydration"));
		await vi.waitFor(() => expect(received).toEqual([0, 1, 2, 3]));
		expect(errors.map((error) => error.message)).toEqual(["async hydration", "sync update", "async update"]);
		expect(fast).toEqual([0, 1, 2, 3]);
	});

	test("still observes a callback rejection after unsubscribe", async () => {
		const errors: Error[] = [];
		const { state, publish } = fixture(kind, (error) => errors.push(error));
		const gate = deferred();
		const received: number[] = [];
		const stop = state.subscribe((value) => {
			received.push(value.value);
			return gate.promise;
		});
		publish({ value: 1 }, BACKGROUND_CONTEXT);
		stop();
		const failure = new Error("stopped callback");
		gate.reject(failure);
		await vi.waitFor(() => expect(errors).toEqual([failure]));
		expect(received).toEqual([0]);
	});
});

test("mutable state reports rejected callbacks through its default error reporter", async () => {
	const reports: (() => void)[] = [];
	const spy = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((report) => {
		reports.push(report);
	});
	try {
		const state = replicatedState({ value: 0 });
		const failure = new Error("async mutable hydration");
		const received: number[] = [];
		state.subscribe((value) => {
			received.push(value.value);
			if (value.value === 0) return Promise.reject(failure);
		});
		expect(() => state.replace(BACKGROUND_CONTEXT, { value: 1 })).not.toThrow();
		await Promise.resolve();
		expect(received).toEqual([0, 1]);
		expect(reports).toHaveLength(1);
		expect(reports[0]).toThrow(failure);
	} finally {
		spy.mockRestore();
	}
});

test("replica disconnect drops obsolete pending work but waits for the running callback before rehydration", async () => {
	const replica = new ReplicatedStateReplica<Value>(() => {});
	const gate = deferred();
	const received: ReplicatedStateDelivery[] = [];
	replica.subscribe((_value, _context, delivery) => {
		received.push(delivery);
		if (delivery.sequence === 0) return gate.promise;
	});
	replica.hydrate(0, [["r", { value: 0 }]], BACKGROUND_CONTEXT);
	replica.update(1, [["s", ["value"], 1]], BACKGROUND_CONTEXT);
	replica.clear();
	replica.hydrate(50, [["r", { value: 50 }]], BACKGROUND_CONTEXT);
	replica.update(51, [["s", ["value"], 51]], BACKGROUND_CONTEXT);
	expect(received).toEqual([{ kind: "hydrate", sequence: 0 }]);
	gate.resolve();
	await gate.promise;
	expect(received).toEqual([
		{ kind: "hydrate", sequence: 0 },
		{ kind: "hydrate", sequence: 50 },
		{ kind: "update", sequence: 51 },
	]);
});

test("cold replicas hydrate all listeners before their reentrant updates", () => {
	const replica = new ReplicatedStateReplica<Value>(() => {});
	const second: ReplicatedStateDelivery[] = [];
	replica.subscribe((_value, _context, delivery) => {
		if (delivery.kind === "hydrate") replica.update(1, [["s", ["value"], 1]], BACKGROUND_CONTEXT);
	});
	replica.subscribe((_value, _context, delivery) => second.push(delivery));
	replica.hydrate(0, [["r", { value: 0 }]], BACKGROUND_CONTEXT);
	expect(second).toEqual([
		{ kind: "hydrate", sequence: 0 },
		{ kind: "update", sequence: 1 },
	]);
});
