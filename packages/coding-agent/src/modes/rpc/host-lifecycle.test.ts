/**
 * senpi#4267: a host's idle window under observing state and history reads. The supervisor resets the window on an
 * attachment (`ClientOccupancy`'s onAttach) and counts `attachedCount` as connections; a watcher that only sends
 * marked `get_state`/`get_entries` must leave both alone, so the host still exits on its deadline (virtual clock).
 */
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { ClientOccupancy } from "./host-client-occupancy.ts";
import { IdleExitDecider } from "./host-lifecycle-policy.ts";

function send(client: Socket, request: Record<string, unknown>): void {
	client.emit("data", Buffer.from(`${JSON.stringify(request)}\n`));
}

describe("host idle window and observing reads (senpi#4267)", () => {
	it("observing read keeps attachedCount 0 and never resets the idle window", () => {
		let now = 0;
		const decider = new IdleExitDecider(1_000, () => now);
		let resets = 0;
		const occupancy = new ClientOccupancy(() => resets++);
		const watch = (): string => decider.update({ connections: occupancy.attachedCount, activeTurns: 0 });

		expect(watch()).toBe("idle");
		const watcher = new Socket();
		occupancy.admit(watcher);
		for (let poll = 0; poll < 5; poll++) {
			now += 250;
			send(watcher, { type: "get_state", sessionId: "s1", observe: true });
			send(watcher, { type: "get_entries", sessionId: "s1", tail: 50, observe: true });
			if (now < 1_000) expect(watch()).toBe("idle");
		}

		expect(resets).toBe(0);
		expect(occupancy.attachedCount).toBe(0);
		expect(occupancy.unclassifiedCount).toBe(0);
		expect(watch()).toBe("exit");
	});

	it("attaches the connection, and resets the window, from its first unmarked read", () => {
		let now = 0;
		const decider = new IdleExitDecider(1_000, () => now);
		let resets = 0;
		const occupancy = new ClientOccupancy(() => resets++);
		const client = new Socket();
		occupancy.admit(client);
		send(client, { type: "get_state", sessionId: "s1", observe: true });
		send(client, { type: "get_state", sessionId: "s1" });
		now += 5_000;

		expect(resets).toBe(1);
		expect(occupancy.attachedCount).toBe(1);
		expect(decider.update({ connections: occupancy.attachedCount, activeTurns: 0 })).toBe("active");
	});
});
