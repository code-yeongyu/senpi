// senpi#7427: a pending `host handoff --when idle` held all new work back until the host's next idle point, with no
// limit. A host whose sessions keep working never reached one, so it refused every prompt, steer and wake forever. The
// pending wait is now bounded: past the limit the operation is abandoned as `handover_blocked` and work is admitted
// again, while a running turn is never aborted for it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	HostIdleHandover,
	type IdleHandoverRequest,
	IDLE_HANDOVER_WAIT_LIMIT_MS,
} from "../../../src/modes/rpc/host-idle-handover.ts";

const REQUEST: IdleHandoverRequest = {
	operationId: "op-7427",
	ifInstanceId: "instance-7427",
	ifGeneration: 0,
	targetRuntimeBuildId: "sha256:new",
	launch: { command: "senpi", args: [] },
	hostArgs: [],
	env: {},
};

function neverIdleHost(): { readonly handover: HostIdleHandover; readonly performed: IdleHandoverRequest[] } {
	const performed: IdleHandoverRequest[] = [];
	const handover = new HostIdleHandover({
		identity: () => ({ instanceId: "instance-7427", generation: 0, runtimeBuildId: "sha256:old" }),
		isIdle: () => false,
		perform: async (request) => {
			performed.push(request);
			return { ok: false, reason: "unexpected" };
		},
	});
	return { handover, performed };
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("senpi#7427: a pending idle handover is bounded", () => {
	it("#given a host that never goes idle #when the wait limit passes #then the handover is blocked with a reason and new work is admitted again", async () => {
		const { handover, performed } = neverIdleHost();
		expect(await handover.begin(REQUEST)).toMatchObject({ view: { state: "handover_pending" } });
		expect(handover.admits("prompt")).toBe(false);

		await vi.advanceTimersByTimeAsync(IDLE_HANDOVER_WAIT_LIMIT_MS - 1);
		expect(handover.view()).toMatchObject({ state: "handover_pending" });

		await vi.advanceTimersByTimeAsync(1);
		expect(handover.view()).toMatchObject({
			operationId: "op-7427",
			state: "handover_blocked",
			reason: expect.stringContaining("idle_wait_expired"),
		});
		expect(handover.admits("prompt")).toBe(true);
		expect(handover.admits("wake")).toBe(true);
		expect(performed).toEqual([]);
		handover.dispose();
	});

	it("#given an abandoned handover #when another operation is asked for #then it is taken as a new pending operation", async () => {
		const { handover } = neverIdleHost();
		await handover.begin(REQUEST);
		await vi.advanceTimersByTimeAsync(IDLE_HANDOVER_WAIT_LIMIT_MS);
		expect(await handover.begin({ ...REQUEST, operationId: "op-7427-again" })).toMatchObject({
			view: { operationId: "op-7427-again", state: "handover_pending" },
		});
		handover.dispose();
	});
});
