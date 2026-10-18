import { describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT, withCancel } from "../src/context/index.ts";
import {
	type Context,
	createRemoteServiceBinding,
	createServiceStateDecoder,
	createServiceStateEncoder,
	defineService,
	parseWireServiceProviderUpdate,
	parseWireServiceSubscriptionSnapshot,
	RemoteServiceProvider,
	type RemoteServiceTransport,
	type ReplicatedState,
	replicatedState,
	type ServiceProviderUpdate,
} from "../src/index.ts";
import { getReplicatedStateInternals } from "../src/services/state-internals.ts";

interface Counter {
	readonly state: ReplicatedState<{ value: number }>;
}
const Counter = defineService<Counter>("test.delivery-counter");
interface Pair {
	readonly left: ReplicatedState<{ value: number }>;
	readonly right: ReplicatedState<{ value: number }>;
}
const Pair = defineService<Pair>("test.delivery-pair");

function wireTransport(
	provider: RemoteServiceProvider,
	beforeActivate: () => void,
	updates: ServiceProviderUpdate[],
): RemoteServiceTransport {
	return {
		invoke: (call, context) => provider.invoke(call, context),
		async subscribe(serviceId, mode, listener) {
			const encoder = createServiceStateEncoder();
			const decoder = createServiceStateDecoder();
			const subscription = provider.subscribe(serviceId, mode, (update, context) => {
				const decoded = decoder.decodeUpdate(parseWireServiceProviderUpdate(encoder.encodeUpdate(update)));
				updates.push(decoded);
				listener(decoded, context);
			});
			const snapshot = decoder.decodeSnapshot(
				parseWireServiceSubscriptionSnapshot(encoder.encodeSnapshot(subscription.snapshot)),
			);
			return {
				snapshot,
				activate() {
					beforeActivate();
					subscription.activate();
				},
				close: () => subscription.close(),
			};
		},
	};
}

describe("provider delivery queues", () => {
	test("appends reentrant updates to the activation FIFO", () => {
		const provider = new RemoteServiceProvider([Counter]);
		const state = replicatedState({ value: 0 });
		provider.provide(Counter, { state });
		const received: number[] = [];
		const subscription = provider.subscribe(Counter.id, "singleton", (update) => {
			if (update.type !== "state") return;
			received.push(update.sequence);
			if (update.sequence === 1) state.replace(BACKGROUND_CONTEXT, { value: 3 });
		});
		state.replace(BACKGROUND_CONTEXT, { value: 1 });
		state.replace(BACKGROUND_CONTEXT, { value: 2 });
		subscription.activate();
		subscription.activate();
		expect(received).toEqual([1, 2, 3]);
		provider.dispose();
	});

	test.each([100, 101, 102, 201, 202])("bounds %i pending updates with explicit root resets", (count) => {
		const provider = new RemoteServiceProvider([Counter]);
		const state = replicatedState({ value: 0 });
		provider.provide(Counter, { state });
		const updates: ServiceProviderUpdate[] = [];
		const contexts: Context[] = [];
		const subscription = provider.subscribe(Counter.id, "singleton", (update, context) => {
			updates.push(update);
			contexts.push(context);
		});
		const { context } = withCancel(BACKGROUND_CONTEXT);
		for (let value = 1; value <= count; value += 1) state.replace(context, { value });
		expect(updates).toEqual([]);
		expect(subscription.snapshot.instances[0]?.members[0]).toMatchObject({ sequence: 0 });
		subscription.activate();
		const first = Math.floor((count - 1) / 100) * 100 + 1;
		expect(updates).toHaveLength(count - first + 1);
		if (count > 100) {
			expect(updates[0]).toEqual({
				type: "reset",
				snapshot: {
					serviceId: Counter.id,
					mode: "singleton",
					instances: [
						{ members: [{ name: "state", kind: "state", sequence: first, ops: [["r", { value: first }]] }] },
					],
				},
			});
		}
		expect(contexts.every((received) => received === context)).toBe(true);
		state.replace(context, { value: count + 1 });
		expect(updates.at(-1)).toMatchObject({ type: "state", sequence: count + 1 });
		provider.dispose();
	});

	test("does not compact the running delivery when activation overflows reentrantly", () => {
		const provider = new RemoteServiceProvider([Counter]);
		const state = replicatedState({ value: 0 });
		provider.provide(Counter, { state });
		const updates: ServiceProviderUpdate[] = [];
		const subscription = provider.subscribe(Counter.id, "singleton", (update) => {
			updates.push(update);
			if (update.type === "state" && update.sequence === 1) {
				for (let value = 3; value <= 103; value += 1) state.replace(BACKGROUND_CONTEXT, { value });
			}
		});
		state.replace(BACKGROUND_CONTEXT, { value: 1 });
		state.replace(BACKGROUND_CONTEXT, { value: 2 });
		subscription.activate();
		expect(updates).toHaveLength(3);
		expect(updates[0]).toMatchObject({ type: "state", sequence: 1 });
		expect(updates[1]).toMatchObject({
			type: "reset",
			snapshot: { instances: [{ members: [{ sequence: 102, ops: [["r", { value: 102 }]] }] }] },
		});
		expect(updates[2]).toMatchObject({ type: "state", sequence: 103 });
		provider.dispose();
	});

	test("suppresses notifications already covered by an overflow snapshot", () => {
		const provider = new RemoteServiceProvider([Counter]);
		const state = replicatedState({ value: 0 });
		getReplicatedStateInternals(state)!.subscribe((_ops, sequence) => {
			if (sequence === 101) {
				state.replace(BACKGROUND_CONTEXT, { value: 102 });
				state.replace(BACKGROUND_CONTEXT, { value: 103 });
			}
		});
		provider.provide(Counter, { state });
		const updates: ServiceProviderUpdate[] = [];
		const subscription = provider.subscribe(Counter.id, "singleton", (update) => updates.push(update));
		for (let value = 1; value <= 101; value += 1) state.replace(BACKGROUND_CONTEXT, { value });
		subscription.activate();
		expect(updates).toHaveLength(1);
		expect(updates[0]).toMatchObject({
			type: "reset",
			snapshot: { instances: [{ members: [{ sequence: 103, ops: [["r", { value: 103 }]] }] }] },
		});
		state.replace(BACKGROUND_CONTEXT, { value: 104 });
		expect(updates[1]).toMatchObject({ type: "state", sequence: 104 });
		provider.dispose();
	});

	test("preserves lifecycle ordering across subscribers during reentrant publication", () => {
		const provider = new RemoteServiceProvider([Counter]);
		provider.provide(Counter, { state: replicatedState({ value: 0 }) });
		const first: ServiceProviderUpdate[] = [];
		const second: ServiceProviderUpdate[] = [];
		provider
			.subscribe(Counter.id, "singleton", (update) => {
				first.push(update);
				if (first.length === 1) provider.replace(Counter, { state: replicatedState({ value: 2 }) });
			})
			.activate();
		provider.subscribe(Counter.id, "singleton", (update) => second.push(update)).activate();
		provider.replace(Counter, { state: replicatedState({ value: 1 }) });
		expect(first).toEqual(second);
		expect(second).toHaveLength(2);
		expect(second[0]).toMatchObject({ type: "replaced", snapshot: { members: [{ ops: [["r", { value: 1 }]] }] } });
		provider.dispose();
	});

	test("close during a callback prevents later buffered callbacks", () => {
		const provider = new RemoteServiceProvider([Counter]);
		const state = replicatedState({ value: 0 });
		provider.provide(Counter, { state });
		const received: ServiceProviderUpdate[] = [];
		const subscription = provider.subscribe(Counter.id, "singleton", (update) => {
			received.push(update);
			subscription.close();
		});
		state.replace(BACKGROUND_CONTEXT, { value: 1 });
		state.replace(BACKGROUND_CONTEXT, { value: 2 });
		subscription.activate();
		expect(received).toHaveLength(1);
		provider.dispose();
	});

	test("drains terminal updates when disposed reentrantly", () => {
		const provider = new RemoteServiceProvider([Counter]);
		const state = replicatedState({ value: 0 });
		provider.provide(Counter, { state });
		const received: ServiceProviderUpdate[] = [];
		const subscription = provider.subscribe(Counter.id, "singleton", (update) => {
			received.push(update);
			if (update.type === "state") provider.dispose();
		});
		state.replace(BACKGROUND_CONTEXT, { value: 1 });
		subscription.activate();
		expect(received.map((update) => update.type)).toEqual(["state", "unavailable"]);
	});
});

test("rebaselines every member through wire codecs, then resumes contiguous deltas", async () => {
	const provider = new RemoteServiceProvider([Pair]);
	const left = replicatedState({ value: 0 });
	const right = replicatedState({ value: 0 });
	provider.provide(Pair, { left, right });
	const errors: Error[] = [];
	const updates: ServiceProviderUpdate[] = [];
	const namespace = createRemoteServiceBinding({
		services: [Pair],
		transport: wireTransport(
			provider,
			() => {
				for (let value = 1; value <= 101; value += 1) {
					left.change(BACKGROUND_CONTEXT, (draft) => {
						draft.value = value;
					});
					right.change(BACKGROUND_CONTEXT, (draft) => {
						draft.value = value;
					});
				}
			},
			updates,
		),
		onError: (error) => errors.push(error),
	});
	const pair = namespace.use(Pair);
	await namespace.ready(BACKGROUND_CONTEXT);
	expect(updates.map((update) => update.type)).toEqual(["reset", "state"]);
	expect(pair.left.value).toEqual({ value: 101 });
	expect(pair.right.value).toEqual({ value: 101 });
	for (let value = 102; value <= 104; value += 1) {
		left.change(BACKGROUND_CONTEXT, (draft) => {
			draft.value = value;
		});
		right.change(BACKGROUND_CONTEXT, (draft) => {
			draft.value = value;
		});
	}
	expect(pair.left.value).toEqual({ value: 104 });
	expect(pair.right.value).toEqual({ value: 104 });
	expect(errors).toEqual([]);
	await namespace.dispose(BACKGROUND_CONTEXT);
	provider.dispose();
});

test("an overflow reset can make a singleton unavailable before a later replacement", async () => {
	const provider = new RemoteServiceProvider([Counter]);
	provider.provide(Counter, { state: replicatedState({ value: 0 }) });
	const updates: ServiceProviderUpdate[] = [];
	const errors: Error[] = [];
	const namespace = createRemoteServiceBinding({
		services: [Counter],
		transport: wireTransport(
			provider,
			() => {
				for (let value = 1; value <= 100; value += 1)
					provider.replace(Counter, { state: replicatedState({ value }) });
				provider.withdraw(Counter);
			},
			updates,
		),
		onError: (error) => errors.push(error),
	});
	const counter = namespace.use(Counter);
	await namespace.ready(BACKGROUND_CONTEXT);
	expect(updates).toEqual([{ type: "reset", snapshot: { serviceId: Counter.id, mode: "singleton", instances: [] } }]);
	expect(counter.state.value).toBeUndefined();
	const replacement = replicatedState({ value: 200 });
	provider.replace(Counter, { state: replacement });
	replacement.change(BACKGROUND_CONTEXT, (draft) => {
		draft.value = 201;
	});
	expect(namespace.use(Counter)).toBe(counter);
	expect(counter.state.value).toEqual({ value: 201 });
	expect(errors).toEqual([]);
	await namespace.dispose(BACKGROUND_CONTEXT);
	provider.dispose();
});

test("keyed resets retain live generations and reconcile closed and reused keys", async () => {
	const provider = new RemoteServiceProvider([{ service: Counter, mode: "keyed" }]);
	const retained = replicatedState({ value: 0 });
	provider.spawn(Counter, "retained", { state: retained });
	const closeOld = provider.spawn(Counter, "reused", { state: replicatedState({ value: 0 }) });
	const removed = provider.spawn(Counter, "removed", { state: replicatedState({ value: 0 }) });
	const updates: ServiceProviderUpdate[] = [];
	const errors: Error[] = [];
	const namespace = createRemoteServiceBinding({
		services: [Counter],
		transport: wireTransport(provider, () => {}, updates),
		onError: (error) => errors.push(error),
	});
	const observed: { service: Counter; context: Context }[] = [];
	namespace.observe(Counter, (service, context) => {
		observed.push({ service, context });
	});
	await namespace.ready(BACKGROUND_CONTEXT);
	expect(observed).toHaveLength(3);
	const stable = observed[1]!; // Provider snapshots are sorted by key.
	const old = observed[2]!;
	const replacement = replicatedState({ value: 500 });
	stable.service.state.subscribe((value) => {
		if (value.value !== 1) return;
		closeOld();
		removed();
		provider.spawn(Counter, "reused", { state: replacement });
		retained.replace(BACKGROUND_CONTEXT, { value: 102 });
		for (let next = 501; next <= 601; next += 1) replacement.replace(BACKGROUND_CONTEXT, { value: next });
	});
	retained.replace(BACKGROUND_CONTEXT, { value: 1 });
	expect(updates.some((update) => update.type === "reset")).toBe(true);
	expect(observed).toHaveLength(4);
	expect(stable.context.abortSignal?.aborted).toBe(false);
	expect(stable.service.state.value).toEqual({ value: 102 });
	expect(old.context.abortSignal?.aborted).toBe(true);
	expect(observed[0]?.context.abortSignal?.aborted).toBe(true);
	expect(observed[3]?.service.state.value).toEqual({ value: 601 });
	replacement.change(BACKGROUND_CONTEXT, (draft) => {
		draft.value = 602;
	});
	expect(observed[3]?.service.state.value).toEqual({ value: 602 });
	expect(errors).toEqual([]);
	await namespace.dispose(BACKGROUND_CONTEXT);
	provider.dispose();
});
