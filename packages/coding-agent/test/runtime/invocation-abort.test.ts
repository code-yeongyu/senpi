// senpi#5236 (RT9, brain/hand split): a tool call's invocation signals come from an explicit steering source, so a
// host without a session steers or cancels an invocation without a local message queue. Guards the F46 invocation
// cancel surface.
import { describe, expect, it } from "vitest";
import { bindInvocationSignals, type InvocationSteering } from "../../src/core/agent-session.ts";
import type { ExtensionContext } from "../../src/core/extensions/index.ts";

function steeringSource(pendingAtStart = false) {
	const listeners = new Set<() => void>();
	let pending = pendingAtStart;
	const source: InvocationSteering = {
		pending: () => pending,
		subscribe: (onSteer) => {
			listeners.add(onSteer);
			return () => listeners.delete(onSteer);
		},
	};
	return {
		source,
		listeners,
		steer: () => {
			pending = true;
			for (const listener of [...listeners]) listener();
		},
	};
}

const bareContext = (): ExtensionContext => ({ signal: undefined }) as unknown as ExtensionContext;

describe("explicit invocation steering and abort (senpi#5236)", () => {
	it("fires steeringSignal when steering arrives during the call, without cancelling it", () => {
		const steering = steeringSource();
		const call = new AbortController();
		const { context } = bindInvocationSignals(bareContext(), call.signal, steering.source);

		expect(context.steeringSignal?.aborted).toBe(false);
		steering.steer();

		expect(context.steeringSignal?.aborted).toBe(true);
		expect(call.signal.aborted).toBe(false);
	});

	it("fires steeringSignal at once when steering is already pending", () => {
		const steering = steeringSource(true);
		const { context } = bindInvocationSignals(bareContext(), new AbortController().signal, steering.source);

		expect(context.steeringSignal?.aborted).toBe(true);
	});

	it("releases the steering subscription when the call is aborted", () => {
		const steering = steeringSource();
		const call = new AbortController();
		bindInvocationSignals(bareContext(), call.signal, steering.source);
		expect(steering.listeners.size).toBe(1);

		call.abort();

		expect(steering.listeners.size).toBe(0);
	});

	it("releases the subscription on dispose, and a second dispose is harmless", () => {
		const steering = steeringSource();
		const { dispose } = bindInvocationSignals(bareContext(), new AbortController().signal, steering.source);

		dispose();
		dispose();

		expect(steering.listeners.size).toBe(0);
	});

	it("binds nothing for a call whose signal is already aborted", () => {
		const steering = steeringSource();
		const call = new AbortController();
		call.abort();

		bindInvocationSignals(bareContext(), call.signal, steering.source);

		expect(steering.listeners.size).toBe(0);
	});
});
