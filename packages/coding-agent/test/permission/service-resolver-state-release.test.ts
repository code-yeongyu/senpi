import { describe, expect, it } from "vitest";
import { createLocalEventEmitter } from "../../src/core/extensions/builtin/permission-system/events.ts";
import {
	createPathIdentityResolver,
	type PathIdentityResolver,
} from "../../src/core/extensions/builtin/permission-system/path-identity-host.ts";
import { PermissionService } from "../../src/core/extensions/builtin/permission-system/service.ts";
import { fixtureTransport } from "./path-identity-fixtures.ts";

// The resolver is one per process and outlives every service built on it, so a service must release
// its state subscription when it is replaced or its session shuts down.
describe("permission service resolver-state subscription", () => {
	const unavailableResolver = (): PathIdentityResolver =>
		createPathIdentityResolver({
			spawn: () => fixtureTransport({ startupError: "ENOENT" }),
			log: () => {},
			fatal: () => {},
		});

	const emitUnavailable = async (resolver: PathIdentityResolver): Promise<void> => {
		const unavailable = new Promise<void>((resolve) => {
			resolver.onState((event) => {
				if (event.state === "unavailable") resolve();
			});
		});
		resolver.start();
		await unavailable;
	};

	it("forwards resolver state to the service's emitter while the service is live", async () => {
		const resolver = unavailableResolver();
		const emitter = createLocalEventEmitter();
		const states: string[] = [];
		emitter.onResolverState((event) => states.push(event.state));
		const service = new PermissionService([], [], emitter, undefined, undefined, undefined, resolver);
		await emitUnavailable(resolver);
		expect(states).toEqual(["unavailable"]);
		service.dispose();
		await resolver.close();
	});

	it("a constructor that throws after the identity fill leaves no subscription on the shared resolver", async () => {
		const resolver = unavailableResolver();
		const baseline = resolver.listenerCount;
		const throwingDetect: PathIdentityResolver = Object.create(resolver, {
			detect: {
				value: () => {
					throw new Error("detect failed");
				},
			},
		});
		const rules = [{ permission: "read", pattern: "/srv/data/**", action: "deny" as const }];
		expect(
			() =>
				new PermissionService(
					rules,
					[],
					createLocalEventEmitter(),
					undefined,
					undefined,
					undefined,
					throwingDetect,
				),
		).toThrow("detect failed");
		expect(resolver.listenerCount).toBe(baseline);
		await resolver.close();
	});

	it("dispose() releases the subscription, so the resolver holds nothing of a retired service", async () => {
		const resolver = unavailableResolver();
		const emitter = createLocalEventEmitter();
		const states: string[] = [];
		emitter.onResolverState((event) => states.push(event.state));
		const service = new PermissionService([], [], emitter, undefined, undefined, undefined, resolver);
		service.dispose();
		await emitUnavailable(resolver);
		expect(states).toEqual([]);
		await resolver.close();
	});
});
