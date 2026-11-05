import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createPathIdentityResolver,
	type PathIdentityResolver,
} from "../src/core/extensions/builtin/permission-system/path-identity-host.ts";
import { parseHostProtocolInfo } from "../src/modes/rpc/host-protocol-info.ts";
import { hostSummary, readHostStatus } from "../src/modes/rpc/host-status.ts";
import { pathIdentityResolverStatus } from "../src/modes/rpc/path-identity-status.ts";
import { SessionCommandRouter } from "../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../src/modes/rpc/session-event-writer.ts";
import { fixtureTransport } from "./permission/path-identity-fixtures.ts";

// senpi#4391: `senpi host status` reports a path identity resolver whose worker could not start, so an
// operator sees why path rules match by spelling only instead of discovering it from a missed deny.
describe("host status reports the path identity resolver", () => {
	const resolvers: PathIdentityResolver[] = [];
	afterEach(async () => {
		for (const resolver of resolvers.splice(0)) await resolver.close();
	});

	it("derives not_started, ready and unavailable from the resolver", async () => {
		const ready = createPathIdentityResolver({ spawn: () => fixtureTransport(), log: () => {} });
		resolvers.push(ready);
		expect(pathIdentityResolverStatus(ready)).toEqual({ state: "not_started", detail: null });
		await ready.walk(tmpdir());
		expect(pathIdentityResolverStatus(ready)).toEqual({ state: "ready", detail: null });
		const broken = createPathIdentityResolver({
			spawn: () => fixtureTransport({ startupError: "ERR_MODULE_NOT_FOUND" }),
			log: () => {},
			fatal: () => {},
		});
		resolvers.push(broken);
		const unavailable = new Promise<void>((resolve) =>
			broken.onState((event) => event.state === "unavailable" && resolve()),
		);
		broken.start();
		await unavailable;
		expect(pathIdentityResolverStatus(broken)).toEqual({
			state: "unavailable",
			detail: expect.stringContaining("ERR_MODULE_NOT_FOUND"),
		});
	});

	it("answers get_protocol_info with the resolver state and parses it on the client", async () => {
		const registry = { list: () => [] } as never;
		const router = new SessionCommandRouter(registry, new SessionEventWriter(() => {}), { cwd: "/tmp" });
		const response = await router.handle({ id: "probe", type: "get_protocol_info" });
		if (typeof response !== "object" || response === null || !("data" in response)) throw new Error("no data");
		const data = response.data as { path_identity_resolver?: unknown };
		expect(data.path_identity_resolver).toMatchObject({
			state: expect.stringMatching(/^(not_started|ready|unavailable)$/),
		});
		expect(
			parseHostProtocolInfo({ ...data, path_identity_resolver: { state: "not_started" } })?.path_identity_resolver,
		).toEqual({ state: "not_started", detail: null });
		const parsed = parseHostProtocolInfo({
			...data,
			path_identity_resolver: { state: "unavailable", detail: "ERR_MODULE_NOT_FOUND" },
		});
		expect(parsed?.path_identity_resolver).toEqual({ state: "unavailable", detail: "ERR_MODULE_NOT_FOUND" });
		expect(
			parseHostProtocolInfo({ ...data, path_identity_resolver: { state: "bogus" } })?.path_identity_resolver,
		).toBeUndefined();
		expect(hostSummary(parsed)?.pathIdentityResolver).toEqual({
			state: "unavailable",
			detail: "ERR_MODULE_NOT_FOUND",
		});
	});

	it("carries the field on an unreachable status report", async () => {
		const dir = mkdtempSync(join(tmpdir(), "host-status-path-identity-"));
		try {
			const report = await readHostStatus({ socket: join(dir, "host.sock"), agentDir: dir }, { timeoutMs: 1000 });
			expect(report.reachable).toBe(false);
			expect(report).toHaveProperty("path_identity_resolver", null);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
