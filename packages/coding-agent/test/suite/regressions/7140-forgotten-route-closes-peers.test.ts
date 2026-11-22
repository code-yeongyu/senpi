// senpi#7140 (LOW L1 of the #7105 review): a route forgotten by a failed generation switch deleted its maps but
// left its attachments' peer sockets open, so a peer kept forwarding predecessor records for a handle this host no
// longer routes, until the predecessor parked or exited. A forgotten route releases everything it owns.
import { expect, it, vi } from "vitest";
import type { PredecessorPeer } from "../../../src/modes/rpc/predecessor-peer.ts";
import { RouteTable } from "../../../src/modes/rpc/predecessor-route-table.ts";
import type { RouterContext } from "../../../src/modes/rpc/session-router-context.ts";

function table(): RouteTable {
	let next = 0;
	const host = { registry: { reserveHandle: () => `routed-${++next}` } } as unknown as RouterContext;
	return new RouteTable(host);
}

function peer(): PredecessorPeer & { close: ReturnType<typeof vi.fn> } {
	return { close: vi.fn() } as unknown as PredecessorPeer & { close: ReturnType<typeof vi.fn> };
}

it("closes every attachment peer of a route it forgets", async () => {
	const routes = table();
	const route = routes.route("/sessions/held.jsonl", { instanceId: "predecessor" } as never);
	const first = peer();
	const second = peer();
	route.attachments.set("caller-a", { peer: Promise.resolve(first), count: 1 });
	route.attachments.set("caller-b", { peer: Promise.resolve(second), count: 2 });

	routes.forget(route);
	await Promise.resolve();
	await Promise.resolve();

	expect(routes.holds(route)).toBe(false);
	expect(route.attachments.size).toBe(0);
	expect(first.close).toHaveBeenCalledTimes(1);
	expect(second.close).toHaveBeenCalledTimes(1);
});

it("forgets a route whose peer never connected without failing", async () => {
	const routes = table();
	const route = routes.route("/sessions/held.jsonl", { instanceId: "predecessor" } as never);
	const refused = Promise.reject(new Error("connect refused"));
	route.attachments.set("caller-a", { peer: refused, count: 1 });

	routes.forget(route);
	await expect(refused).rejects.toThrow("connect refused");

	expect(route.attachments.size).toBe(0);
});
