/**
 * senpi#5626: a remote-control daemon reads a host only through observing requests, so the host idled out under an
 * attached remote viewer. An observer may hold the host with `hold_host: true` on an observing read (a lease on its
 * connection) and release it with `hold_host: false`; a held observer counts as occupancy. Plain observing reads keep
 * today's behaviour (virtual clock).
 */
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { ClientOccupancy } from "./host-client-occupancy.ts";
import { IdleExitDecider } from "./host-lifecycle-policy.ts";

function send(client: Socket, request: Record<string, unknown>): void {
	client.emit("data", Buffer.from(`${JSON.stringify(request)}\n`));
}

const harness = () => {
	let now = 0;
	const decider = new IdleExitDecider(1_000, () => now);
	let resets = 0;
	const occupancy = new ClientOccupancy(() => resets++);
	const watch = (): string => decider.update({ connections: occupancy.attachedCount, activeTurns: 0 });
	return {
		occupancy,
		watch,
		advance: (ms: number) => {
			now += ms;
		},
		resets: () => resets,
	};
};

describe("an observer holding the host for a remote viewer (senpi#5626)", () => {
	it("keeps the host past idleExitMs while held, and exits on the normal window after the release", () => {
		const h = harness();
		const daemon = new Socket();
		h.occupancy.admit(daemon);
		send(daemon, { type: "get_protocol_info", observe: true, hold_host: true });
		expect(h.occupancy.attachedCount).toBe(1);
		expect(h.resets()).toBe(1);
		for (let poll = 0; poll < 6; poll++) {
			h.advance(1_000);
			send(daemon, { type: "get_state", sessionId: "s1", observe: true });
			expect(h.watch()).toBe("active");
		}

		send(daemon, { type: "get_protocol_info", observe: true, hold_host: false });
		expect(h.occupancy.attachedCount).toBe(0);
		expect(h.watch()).toBe("idle");
		h.advance(999);
		expect(h.watch()).toBe("idle");
		h.advance(1);
		expect(h.watch()).toBe("exit");
	});

	it("a held observer that disconnects stops holding the host", () => {
		const h = harness();
		const daemon = new Socket();
		h.occupancy.admit(daemon);
		send(daemon, { type: "get_protocol_info", observe: true, hold_host: true });
		h.occupancy.release(daemon);
		expect(h.occupancy.attachedCount).toBe(0);
		expect(h.watch()).toBe("idle");
		h.advance(1_000);
		expect(h.watch()).toBe("exit");
	});

	it("a plain observe-only client still does not hold the host", () => {
		const h = harness();
		const viewer = new Socket();
		h.occupancy.admit(viewer);
		send(viewer, { type: "get_protocol_info", observe: true });
		send(viewer, { type: "get_state", sessionId: "s1", observe: true, hold_host: "yes" });
		expect(h.occupancy.attachedCount).toBe(0);
		expect(h.resets()).toBe(0);
		expect(h.watch()).toBe("idle");
		h.advance(1_000);
		expect(h.watch()).toBe("exit");
	});
});
