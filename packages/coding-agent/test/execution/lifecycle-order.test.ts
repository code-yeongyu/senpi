// senpi#5681 (S15, F07): on a split endpoint a lifecycle handler's effect commits before the next tool call runs.
import { describe, expect, it } from "vitest";
import { createAdmissionLine } from "../../../agent/src/durable/store-admission.ts";
import { createMemoryStoreMedium, openMemoryStore } from "../../../agent/src/durable/store-memory.ts";
import { createScopeLifecycle } from "../../../agent/src/execution/scope-lifecycle.ts";
import { createLifecycleBridge, LifecycleRefusedError } from "../../src/core/execution/lifecycle.ts";

async function bridgeFor(issuer: string) {
	const medium = createMemoryStoreMedium();
	await openMemoryStore(medium).claim(0, 1);
	const scopes = createScopeLifecycle({
		store: openMemoryStore(medium),
		epoch: 1,
		admission: createAdmissionLine(),
		clock: () => 0,
		idleTtlMs: 60_000,
	});
	await scopes.open({ issuer: "brain", workspace: "workspace", scope: "s", generation: 1, allowedRoots: ["/work"] });
	return { scopes, bridge: createLifecycleBridge({ scopes, issuer, scope: "s" }) };
}

describe("lifecycle order on a split endpoint", () => {
	it("runs a tool call issued after agent_end only once the handler's effect is committed", async () => {
		const { scopes, bridge } = await bridgeFor("brain");
		const order: string[] = [];
		const release = Promise.withResolvers<void>();
		const ended = bridge.event("agent_end", async () => {
			order.push("agent_end handler");
			await release.promise;
			return { revoked: "computer" };
		});
		const call = bridge.call(async () => {
			order.push(`tool call (committed events: ${(await scopes.read("s"))?.events.length})`);
		});
		release.resolve();
		expect(await ended).toBe(1);
		await call;
		expect(order).toEqual(["agent_end handler", "tool call (committed events: 1)"]);
		expect((await scopes.read("s"))?.events).toEqual([
			{ seq: 1, kind: "agent_end", effect: { revoked: "computer" } },
		]);
	});

	it("commits a handler without a return value as a null effect", async () => {
		const { scopes, bridge } = await bridgeFor("brain");
		expect(await bridge.event("turn_start", async () => undefined)).toBe(1);
		expect((await scopes.read("s"))?.events).toEqual([{ seq: 1, kind: "turn_start", effect: null }]);
	});

	it("refuses a lifecycle event from a session that is not the scope's issuer", async () => {
		const { scopes, bridge } = await bridgeFor("another-session");
		await expect(bridge.event("agent_end", async () => null)).rejects.toThrow(LifecycleRefusedError);
		expect((await scopes.read("s"))?.events).toEqual([]);
	});
});
