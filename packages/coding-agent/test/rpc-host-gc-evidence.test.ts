/**
 * `senpi host gc` evidence read from hand-built endpoint directories and sockets, no host involved: what
 * is never addressable (empty, layout-1, unnamed), which ensure lock is taken, and each single reason an
 * otherwise dead endpoint is kept - a paused ensure, a live claim, an answering socket or successor bind.
 */
import { realpathSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { daemonDirectoryName } from "../src/modes/rpc/host-daemon-paths.ts";
import { ensureHost, hostEnsureLockTarget } from "../src/modes/rpc/host-ensure.ts";
import { gcHostEndpoints } from "../src/modes/rpc/host-gc.ts";
import { reservationFile } from "../src/modes/rpc/host-reservations.ts";
import { runHostRequest } from "../src/modes/rpc/host-runner.ts";
import { canonicalSocket, endpointScratch, sweepEndpointScratches } from "./helpers/rpc-host-endpoint-scratch.ts";
import { daemonTreeDigest } from "./helpers/rpc-host-endpoints.ts";
import {
	closeServer,
	deadEndpoint,
	exitedPid,
	gate,
	listeningSocket,
	refusingSocket,
	siblingPath,
	writeJson,
} from "./helpers/rpc-host-gc-fixtures.ts";

afterEach(sweepEndpointScratches, 180_000);

const gone = expect.objectContaining({ code: "ENOENT" });
const flatDir = (agentDir: string) => join(agentDir, "rpc-host-daemon");

describe("gc of directories that name no addressable endpoint", () => {
	it("answers an empty agent directory with nothing removed and nothing kept, exit 0", async () => {
		const qa = endpointScratch("gch");

		expect(await runHostRequest({ action: "gc", agentDir: qa.agentDir })).toEqual({
			exitCode: 0,
			payload: { removed: [], kept: [] },
		});
	});

	it("keeps a layout-1 flat directory byte-identical", async () => {
		const qa = endpointScratch("gcg");
		await writeJson(join(flatDir(qa.agentDir), "host.pid"), { pid: process.pid, processStartTime: "then" });
		await writeJson(join(flatDir(qa.agentDir), "settings.json"), { socket: qa.legacy });
		const before = await daemonTreeDigest(flatDir(qa.agentDir));

		expect(await gcHostEndpoints(qa.agentDir)).toEqual({
			removed: [],
			kept: [{ socket: null, dir: flatDir(qa.agentDir), reason: "legacy_layout" }],
		});
		expect(await daemonTreeDigest(flatDir(qa.agentDir))).toEqual(before);
	});

	it("keeps a directory nothing names byte-identical", async () => {
		const qa = endpointScratch("gci");
		const dir = join(flatDir(qa.agentDir), "0123456789abcdef");
		await writeJson(join(flatDir(qa.agentDir), "layout.json"), { layout: 2, dir: "x" });
		await writeJson(join(dir, "generations", "g-1", "host.pid"), { pid: await exitedPid(), processStartTime: "x" });
		const before = await daemonTreeDigest(flatDir(qa.agentDir));

		expect(await gcHostEndpoints(qa.agentDir)).toEqual({
			removed: [],
			kept: [{ socket: null, dir, reason: "unknown_identity" }],
		});
		expect(await daemonTreeDigest(flatDir(qa.agentDir))).toEqual(before);
	});
});

describe.skipIf(process.platform === "win32")("gc evidence read from disk and sockets", () => {
	it("removes an identity recovered from a generation's settings under THAT socket's ensure lock", async () => {
		const qa = endpointScratch("gci2");
		const socket = join(qa.root, "i2.sock");
		const dir = join(flatDir(qa.agentDir), daemonDirectoryName(socket));
		await writeJson(join(flatDir(qa.agentDir), "layout.json"), { layout: 2, dir: "x" });
		await writeJson(join(dir, "generations", "g-1", "settings.json"), { socket });
		const lockFile = `${hostEnsureLockTarget(socket)}.lock`;
		await expect(stat(lockFile)).rejects.toEqual(gone);

		expect(await gcHostEndpoints(qa.agentDir)).toEqual({
			removed: [{ socket, dir, reason: "socket_absent" }],
			kept: [],
		});
		await expect(stat(lockFile)).resolves.toBeDefined();
		await expect(stat(dir)).rejects.toEqual(gone);
	});

	it("reports a recovered identity as locked while an ensure of that socket holds its critical section", async () => {
		const qa = endpointScratch("gci3");
		const socket = join(qa.root, "i3.sock");
		const dir = join(flatDir(qa.agentDir), daemonDirectoryName(socket));
		await writeJson(join(flatDir(qa.agentDir), "layout.json"), { layout: 2, dir: "x" });
		await writeJson(join(dir, "generations", "g-1", "settings.json"), { socket });
		const paused = gate("reject");
		// Another installation: the lock is the SOCKET's, whatever agent directory ensures it.
		const ensure = ensureHost({
			socket,
			agentDir: join(qa.root, "other"),
			_test: { afterLockAcquired: paused.hook },
		});
		await paused.entered;
		const before = await daemonTreeDigest(flatDir(qa.agentDir));

		expect(await gcHostEndpoints(qa.agentDir)).toEqual({ removed: [], kept: [{ socket, dir, reason: "locked" }] });
		expect(await daemonTreeDigest(flatDir(qa.agentDir))).toEqual(before);
		paused.open();
		await expect(ensure).rejects.toThrow("gate released");
	});

	it("reports locked while an ensure of the same socket, spelled through a symlinked directory, holds the lock", async () => {
		const qa = endpointScratch("gcl", undefined, { aliasedRoot: true });
		const canonical = canonicalSocket(qa.legacy);
		expect(canonical).not.toBe(qa.legacy);
		const paths = await deadEndpoint(canonical, qa.agentDir);
		const paused = gate("reject");
		const ensure = ensureHost({
			socket: qa.legacy,
			agentDir: join(qa.root, "other"),
			_test: { afterLockAcquired: paused.hook },
		});
		await paused.entered;
		const before = await daemonTreeDigest(flatDir(qa.agentDir));

		expect(await gcHostEndpoints(qa.agentDir)).toEqual({
			removed: [],
			kept: [{ socket: canonical, dir: paths.dir, reason: "locked" }],
		});
		expect(await daemonTreeDigest(flatDir(qa.agentDir))).toEqual(before);
		paused.open();
		await expect(ensure).rejects.toThrow("gate released");
	});

	it("takes one ensure lock for every spelling of a socket, including one whose directory does not exist yet", async () => {
		const qa = endpointScratch("gcm", undefined, { aliasedRoot: true });
		const real = realpathSync(qa.root);

		expect(hostEnsureLockTarget(qa.legacy)).toBe(hostEnsureLockTarget(join(real, "rpc", "rpc.sock")));
		expect(hostEnsureLockTarget(join(qa.root, "later", "x.sock"))).toBe(
			hostEnsureLockTarget(join(real, "later", "x.sock")),
		);
		expect(hostEnsureLockTarget(qa.legacy)).not.toBe(hostEnsureLockTarget(join(real, "rpc", "other.sock")));
	});

	it("reports locked within the 2 s budget while an ensure is paused in its critical section", async () => {
		const qa = endpointScratch("gce");
		const paths = await deadEndpoint(qa.shard, qa.agentDir);
		const paused = gate("reject");
		const ensure = ensureHost({ socket: qa.shard, agentDir: qa.agentDir, _test: { afterLockAcquired: paused.hook } });
		await paused.entered;
		const before = await daemonTreeDigest(flatDir(qa.agentDir));

		const started = performance.now();
		const result = await gcHostEndpoints(qa.agentDir);

		expect(performance.now() - started).toBeLessThan(4_000);
		expect(result).toEqual({ removed: [], kept: [{ socket: qa.shard, dir: paths.dir, reason: "locked" }] });
		expect(await daemonTreeDigest(flatDir(qa.agentDir))).toEqual(before);
		paused.open();
		await expect(ensure).rejects.toThrow("gate released");
	});

	it("keeps a dead generation whose session-path claim still has a live owner", async () => {
		const qa = endpointScratch("gcf");
		const paths = await deadEndpoint(qa.shard, qa.agentDir);
		await writeJson(join(paths.generationsDir, "g-dead", "host.pid"), {
			pid: await exitedPid(),
			processStartTime: "x",
		});
		const sessionPath = join(qa.sessionDir, "held.jsonl");
		await writeJson(reservationFile(paths.reservationsDir, sessionPath), {
			instanceId: "g-dead",
			pid: process.pid,
			processStartTime: null,
			sessionPath,
			attached: true,
		});
		const before = await daemonTreeDigest(flatDir(qa.agentDir));

		expect(await gcHostEndpoints(qa.agentDir)).toEqual({
			removed: [],
			kept: [{ socket: qa.shard, dir: paths.dir, reason: "live_claim" }],
		});
		expect(await daemonTreeDigest(flatDir(qa.agentDir))).toEqual(before);
	});

	it("keeps an endpoint with no live generation whose socket still answers", async () => {
		const qa = endpointScratch("gcc");
		const paths = await deadEndpoint(qa.legacy, qa.agentDir);
		const server = await listeningSocket(qa.legacy);
		try {
			expect(await gcHostEndpoints(qa.agentDir)).toEqual({
				removed: [],
				kept: [{ socket: qa.legacy, dir: paths.dir, reason: "reachable" }],
			});
			await expect(stat(paths.endpointFile)).resolves.toBeDefined();
		} finally {
			await closeServer(server);
		}
	});

	it("keeps an endpoint whose socket path is a regular file, and unlinks nothing", async () => {
		const qa = endpointScratch("gcr");
		const paths = await deadEndpoint(qa.legacy, qa.agentDir);
		await writeFile(qa.legacy, "not a socket\n");
		await writeJson(siblingPath(qa.legacy, ".shield-7"), {});
		const before = await daemonTreeDigest(flatDir(qa.agentDir));

		expect(await gcHostEndpoints(qa.agentDir)).toEqual({
			removed: [],
			kept: [{ socket: qa.legacy, dir: paths.dir, reason: "reachable" }],
		});
		await expect(readFile(qa.legacy, "utf8")).resolves.toBe("not a socket\n");
		await expect(stat(siblingPath(qa.legacy, ".shield-7"))).resolves.toBeDefined();
		expect(await daemonTreeDigest(flatDir(qa.agentDir))).toEqual(before);
	});

	it("keeps an endpoint whose public socket refuses while a successor bind beside it answers", async () => {
		const qa = endpointScratch("gcn");
		const paths = await deadEndpoint(qa.legacy, qa.agentDir);
		await refusingSocket(qa.legacy);
		const successor = await listeningSocket(siblingPath(qa.legacy, ".next-2"));
		try {
			expect(await gcHostEndpoints(qa.agentDir)).toEqual({
				removed: [],
				kept: [{ socket: qa.legacy, dir: paths.dir, reason: "reachable" }],
			});
			await expect(stat(qa.legacy)).resolves.toBeDefined();
		} finally {
			await closeServer(successor);
		}
	});
});
