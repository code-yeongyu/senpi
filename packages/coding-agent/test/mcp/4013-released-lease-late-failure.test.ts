import { afterEach, describe, expect, it } from "vitest";
import { HostMcpRegistry } from "../../src/core/extensions/builtin/mcp/host-registry.ts";
import { McpService } from "../../src/core/extensions/builtin/mcp/service.ts";
import { SharedMcpLease } from "../../src/core/extensions/builtin/mcp/shared-lease.ts";
import { attach, cleanupRoots, makeRoot, setConfig } from "./fixtures/service-lifecycle.ts";
import { sharingHttpFixture } from "./fixtures/sharing-http.ts";

const cleanup: Array<() => Promise<void>> = [];
const registries: HostMcpRegistry[] = [];
const services: McpService[] = [];

afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.dispose("quit")));
	for (const registry of registries.splice(0)) await registry.dispose();
	await cleanupRoots(cleanup);
});

async function twoSessionsSharingOneConnection() {
	const root = makeRoot("released-lease", cleanup);
	const fixture = await sharingHttpFixture();
	cleanup.push(() => fixture.close());
	const registry = new HostMcpRegistry();
	registries.push(registry);
	const first = new McpService({ mcpRegistry: registry });
	const second = new McpService({ mcpRegistry: registry });
	services.push(first, second);
	setConfig(root, { fx: { type: "http", url: fixture.url, auth: false, lifecycle: "eager", idleTimeoutMin: 1 } });
	await attach(first, root, "startup");
	await first.whenAttachSettled(10_000);
	await attach(second, root, "startup");
	await second.whenAttachSettled(10_000);
	const released = first.getConnection("fx");
	const surviving = second.getConnection("fx");
	if (!(released instanceof SharedMcpLease) || !(surviving instanceof SharedMcpLease)) {
		throw new Error("expected both sessions to hold a lease on one shared connection");
	}
	return { first, released, surviving };
}

describe("a released shared lease no longer speaks for the shared connection (senpi#4013)", () => {
	it.each([
		["markDegraded", (lease: SharedMcpLease, error: Error) => lease.markDegraded(error)],
		["markSuspended", (lease: SharedMcpLease, error: Error) => lease.markSuspended(error)],
		["markNeedsAuth", (lease: SharedMcpLease, error: Error) => lease.markNeedsAuth(error)],
		[
			"markNeedsClientRegistration",
			(lease: SharedMcpLease, error: Error) => lease.markNeedsClientRegistration(error),
		],
	] as const)(
		"#given two sessions sharing a connection #when the released lease reports a late failure via %s #then the surviving session's connection stays connected",
		async (_name, report) => {
			// given
			const { first, released, surviving } = await twoSessionsSharingOneConnection();
			expect(surviving.state).toBe("connected");
			await first.dispose("quit");
			expect(released.state).toBe("disabled");

			// when: a failure from an attempt the release superseded lands late, through the released lease
			report(released, new Error("late failure from a superseded attempt"));

			// then
			expect(surviving.state).toBe("connected");
			expect(surviving.lastError).toBeUndefined();
		},
	);
});
