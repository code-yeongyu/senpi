/**
 * `endpoint.json` on a filesystem without hard links (exFAT/FAT, some network and FUSE mounts, where
 * `link()` fails with ENOTSUP): the identity is still written, whole and correct, and an ensure still
 * starts a host - a link failure other than EEXIST falls back to an exclusive create of the file.
 */
import { vi } from "vitest";

const linkState = vi.hoisted(() => ({ failWith: undefined as string | undefined, attempts: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		link: async (...args: Parameters<typeof actual.link>) => {
			const [, target] = args;
			if (linkState.failWith !== undefined && String(target).endsWith("endpoint.json")) {
				linkState.attempts++;
				throw Object.assign(new Error(`${linkState.failWith}: operation not supported, link`), {
					code: linkState.failWith,
				});
			}
			return actual.link(...args);
		},
	};
});

import { readdir, readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createHostDaemonPaths, ensureEndpointIdentity } from "../src/modes/rpc/host-daemon-paths.ts";
import { probeHost } from "../src/modes/rpc/host-probe.ts";
import { endpointScratch, realHost, sweepEndpointScratches } from "./helpers/rpc-host-endpoint-scratch.ts";

afterEach(async () => {
	linkState.failWith = undefined;
	linkState.attempts = 0;
	await sweepEndpointScratches();
}, 180_000);

const TORN = '{"layout":2,"sock';

describe.skipIf(process.platform === "win32")("endpoint.json where link() is unsupported", () => {
	it("writes the identity once, keeps the first writer's, and still repairs a torn file under the lock", async () => {
		linkState.failWith = "ENOTSUP";
		const qa = endpointScratch("nol");
		const paths = createHostDaemonPaths({ socket: qa.shard, agentDir: qa.agentDir });

		await ensureEndpointIdentity(paths, qa.shard);
		const first = await readFile(paths.endpointFile, "utf8");
		expect(JSON.parse(first)).toEqual({
			layout: 2,
			registry_version: 1,
			endpoint_kind: "rpc_host",
			socket: qa.shard,
			created_at: expect.any(String),
		});
		await ensureEndpointIdentity(paths, qa.shard, { repair: true });
		expect(await readFile(paths.endpointFile, "utf8")).toBe(first);

		await writeFile(paths.endpointFile, TORN);
		await ensureEndpointIdentity(paths, qa.shard, { repair: true });
		expect(JSON.parse(await readFile(paths.endpointFile, "utf8"))).toEqual({
			layout: 2,
			registry_version: 1,
			endpoint_kind: "rpc_host",
			socket: qa.shard,
			created_at: expect.any(String),
		});
		expect(linkState.attempts).toBeGreaterThanOrEqual(3);
		expect((await readdir(paths.dir)).filter((name) => name.startsWith("endpoint.json"))).toEqual(["endpoint.json"]);
	});

	it("still lets an ensure start a host and record a correct endpoint.json", async () => {
		linkState.failWith = "ENOTSUP";
		const qa = endpointScratch("nol2");
		const paths = createHostDaemonPaths({ socket: qa.shard, agentDir: qa.agentDir });

		await realHost(qa, qa.shard);

		expect(linkState.attempts).toBeGreaterThanOrEqual(1);
		expect(JSON.parse(await readFile(paths.endpointFile, "utf8"))).toEqual({
			layout: 2,
			registry_version: 1,
			endpoint_kind: "rpc_host",
			socket: qa.shard,
			created_at: expect.any(String),
		});
		expect(await probeHost({ socket: qa.shard })).toBeDefined();
	}, 180_000);
});
