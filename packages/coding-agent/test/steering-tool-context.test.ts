import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createHarness, getUserTexts, type Harness } from "./suite/harness.ts";

function deferred<T>() {
	return Promise.withResolvers<T>();
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("Expected event did not arrive")), 2000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

type Invocation = { context: ExtensionContext; cancellation: AbortSignal | undefined };

/** Private AgentSession members these tests drive directly. */
type SteeringInternals = {
	_queueSteer(text: string): Promise<void>;
	readonly _eventListeners: readonly unknown[];
};

function internals(harness: Harness): SteeringInternals {
	return harness.session as unknown as SteeringInternals;
}
const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function fixture() {
	const started = deferred<Invocation>();
	const release = deferred<void>();
	const invocations: Invocation[] = [];
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "signal_probe",
					label: "Signal probe",
					description: "Observe invocation signals",
					parameters: Type.Object({}),
					async execute(_id, _args, signal, _update, context) {
						const invocation = { context, cancellation: signal };
						invocations.push(invocation);
						started.resolve(invocation);
						await release.promise;
						return { content: [{ type: "text", text: "settled" }], details: { settled: true } };
					},
				});
			},
		],
		initialActiveToolNames: ["signal_probe"],
	});
	harnesses.push(harness);
	return { harness, started, release, invocations };
}

// #1637: exercise the actual session queue, registered tool and agent loop, without a provider call.
it("steering reaches active tool and the agent loop consumes the same message once after settlement", async () => {
	const { harness, started, release } = await fixture();
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("signal_probe", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("finished"),
	]);
	const prompt = harness.session.prompt("initial");
	try {
		const { context, cancellation } = await bounded(started.promise);
		const steering = context.steeringSignal;
		expect(steering).toBeInstanceOf(AbortSignal);
		if (!steering) throw new Error("Missing steering signal");
		expect(steering.aborted).toBe(false);
		const pushed = deferred<void>();
		let pushes = 0;
		steering.addEventListener("abort", () => {
			pushes++;
			pushed.resolve();
		});
		await harness.session.steer("queued-steer");
		await bounded(pushed.promise);
		expect(pushes).toBe(1);
		expect(cancellation?.aborted).toBe(false);
		expect(harness.session.getSteeringMessages()).toEqual(["queued-steer"]);
		expect(getUserTexts(harness)).toEqual(["initial"]);
		expect(harness.eventsOfType("queue_update").at(-1)?.steering).toEqual(["queued-steer"]);
	} finally {
		release.resolve();
		await bounded(prompt);
	}
	expect(getUserTexts(harness)).toEqual(["initial", "queued-steer"]);
	expect(harness.session.getSteeringMessages()).toEqual([]);
	expect(harness.eventsOfType("tool_execution_end")).toHaveLength(1);
	expect(harness.faux.state.callCount).toBe(2);
});

describe("follow-up and abort remain distinct", () => {
	it("does not signal follow-up and preserves the caller abort reason", async () => {
		const { harness, started, release } = await fixture();
		const controller = new AbortController();
		const execution = harness.session.executeTool("signal_probe", {}, { signal: controller.signal });
		try {
			const invocation = await bounded(started.promise);
			expect(invocation.context.steeringSignal).toBeInstanceOf(AbortSignal);
			await harness.session.followUp("queued-follow-up");
			expect(invocation.context.steeringSignal?.aborted).toBe(false);
			const reason = new Error("caller-owned-abort");
			controller.abort(reason);
			expect(invocation.cancellation?.reason).toBe(reason);
			await harness.session.steer("after-abort");
			expect(invocation.context.steeringSignal?.aborted).toBe(false);
		} finally {
			release.resolve();
			await bounded(execution);
		}
	});

	it("observes steering queued before invocation registration without a subscribe/check gap", async () => {
		const { harness, started, release } = await fixture();
		await harness.session.steer("already-queued");
		const execution = harness.session.executeTool("signal_probe", {});
		try {
			const { context } = await bounded(started.promise);
			expect(context.steeringSignal?.aborted).toBe(true);
			expect(harness.session.getSteeringMessages()).toEqual(["already-queued"]);
		} finally {
			release.resolve();
			await bounded(execution);
		}
	});

	it("multiple steering pushes are idempotent and never reorder the queue", async () => {
		const { harness, started, release } = await fixture();
		const execution = harness.session.executeTool("signal_probe", {});
		try {
			const { context } = await bounded(started.promise);
			expect(context.steeringSignal).toBeInstanceOf(AbortSignal);
			let pushes = 0;
			context.steeringSignal?.addEventListener("abort", () => {
				pushes++;
			});
			await harness.session.steer("one");
			const reason = context.steeringSignal?.reason;
			await harness.session.steer("two");
			await harness.session.followUp("follow");
			expect(pushes).toBe(1);
			expect(context.steeringSignal?.reason).toBe(reason);
			expect(harness.session.getSteeringMessages()).toEqual(["one", "two"]);
		} finally {
			release.resolve();
			await bounded(execution);
		}
	});

	it("removes the subscription on completion so a later invocation cannot signal a stale context", async () => {
		const { harness, started, release, invocations } = await fixture();
		const first = harness.session.executeTool("signal_probe", {});
		const { context: oldContext } = await bounded(started.promise);
		try {
			expect(oldContext.steeringSignal).toBeInstanceOf(AbortSignal);
		} finally {
			release.resolve();
			await bounded(first);
		}
		await harness.session.steer("later");
		expect(oldContext.steeringSignal?.aborted).toBe(false);
		expect((await harness.session.executeTool("signal_probe", {})).details).toEqual({ settled: true });
		expect(invocations[1]?.context.steeringSignal).not.toBe(oldContext.steeringSignal);
		expect(invocations[1]?.context.steeringSignal?.aborted).toBe(true);
		harness.session.clearQueue();
		await harness.session.executeTool("signal_probe", {});
		expect(invocations[2]?.context.steeringSignal?.aborted).toBe(false);
	});

	it("preserves live context getters and stale-runner guards", async () => {
		const { harness, started, release } = await fixture();
		const execution = harness.session.executeTool("signal_probe", {});
		try {
			const { context } = await bounded(started.promise);
			expect(Object.getOwnPropertyDescriptor(context, "model")?.get).toBeTypeOf("function");
			harness.session.dispose();
			expect(() => context.model).toThrow();
		} finally {
			release.resolve();
			await bounded(execution);
		}
	});

	it("observes a reentrant steer during subscription registration", async () => {
		const { harness, started, release } = await fixture();
		const subscribe = harness.session.subscribe.bind(harness.session);
		const registration = vi.spyOn(harness.session, "subscribe").mockImplementationOnce((listener) => {
			const unsubscribe = subscribe(listener);
			void internals(harness)._queueSteer("during-subscribe");
			return unsubscribe;
		});
		const execution = harness.session.executeTool("signal_probe", {});
		try {
			const { context } = await bounded(started.promise);
			expect(context.steeringSignal?.aborted).toBe(true);
			expect(harness.session.getSteeringMessages()).toEqual(["during-subscribe"]);
		} finally {
			registration.mockRestore();
			release.resolve();
			await bounded(execution);
		}
	});

	it("cleans up a thrown tool without reporting a successful tool result", async () => {
		const { harness, started, release } = await fixture();
		const listeners = internals(harness)._eventListeners.length;
		const execution = harness.session.executeTool("signal_probe", {});
		const { context } = await bounded(started.promise);
		release.reject(new Error("fixture failure"));
		expect((await bounded(execution)).details).toEqual({ isError: true });
		expect(internals(harness)._eventListeners).toHaveLength(listeners);
		await harness.session.steer("after-error");
		expect(context.steeringSignal?.aborted).toBe(false);
	});

	it("removes the subscription on disposal even for an unsettled invocation without a caller signal", async () => {
		const { harness, started, release } = await fixture();
		const execution = harness.session.executeTool("signal_probe", {});
		try {
			const { context } = await bounded(started.promise);
			expect(context.steeringSignal).toBeInstanceOf(AbortSignal);
			harness.session.dispose();
			await internals(harness)._queueSteer("after-disposal");
			expect(context.steeringSignal?.aborted).toBe(false);
		} finally {
			release.resolve();
			await bounded(execution);
		}
	});
});
