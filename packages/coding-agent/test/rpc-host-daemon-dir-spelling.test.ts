/**
 * One endpoint, one daemon directory, whatever spelling reaches it: the directory name is hashed from
 * the same canonical socket identity the ensure lock is keyed by (the socket's directory resolved
 * through its deepest existing ancestor), so `/tmp` vs `/private/tmp` and a path through a symlinked
 * directory share the directory, the registration and the lock. A socket already spelled canonically
 * keeps the name it always had, so an existing install keeps its directory.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalEndpointPath, daemonDirectoryName } from "../src/modes/rpc/host-daemon-paths.ts";
import { ensureHost } from "../src/modes/rpc/host-ensure.ts";
import { gcHostEndpoints } from "../src/modes/rpc/host-gc.ts";
import { stopHost } from "../src/modes/rpc/host-stop.ts";
import { ensureFixtureHost, refuseToSpawn, sandbox, sweepSandboxes } from "./helpers/rpc-host-daemon-sandbox.ts";
import { writeJson } from "./helpers/rpc-host-gc-fixtures.ts";
import { waitForPidGone } from "./helpers/spawned-host-reaper.ts";

const scratch: string[] = [];

afterEach(async () => {
	for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true });
	await sweepSandboxes();
}, 60_000);

const sha16 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);

function aliasOf(dir: string): string {
	const alias = `${dir}-l`;
	symlinkSync(dir, alias);
	scratch.push(alias);
	return alias;
}

describe.skipIf(process.platform === "win32")("daemon directory of a socket with several spellings", () => {
	it("keeps the hash of a canonical spelling and gives every other spelling the same name", () => {
		const real = realpathSync(mkdtempSync(join(tmpdir(), "dh-names-")));
		scratch.push(real);
		const alias = aliasOf(real);
		const canonical = join(real, "rpc", "rpc.sock");

		expect(daemonDirectoryName(canonical)).toBe(sha16(canonical));
		expect(daemonDirectoryName(join(alias, "rpc", "rpc.sock"))).toBe(sha16(canonical));
		expect(daemonDirectoryName(join(alias, "later", "x.sock"))).toBe(sha16(join(real, "later", "x.sock")));
		expect(daemonDirectoryName(join(alias, "rpc", "other.sock"))).not.toBe(sha16(canonical));
	});

	it("canonicalizes by the platform parameter, not the platform this process runs on", () => {
		const real = realpathSync(mkdtempSync(join(tmpdir(), "dh-plat-")));
		scratch.push(real);
		const alias = aliasOf(real);
		const throughAlias = join(alias, "x.sock");
		const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		try {
			// The parameter says POSIX: the socket's directory resolves through the symlink even
			// though this process claims to run on win32, where the path would come back unchanged.
			expect(canonicalEndpointPath(throughAlias, "linux")).toBe(join(real, "x.sock"));
			// The parameter says win32: normalized and lower-cased, whatever this process runs on.
			expect(canonicalEndpointPath("C:\\Agents\\RPC.Sock", "win32")).toBe("c:\\agents\\rpc.sock");
		} finally {
			Object.defineProperty(process, "platform", descriptor ?? { value: "linux" });
		}
	});

	it.skipIf(process.platform !== "darwin")("names /tmp and /private/tmp spellings of one socket alike", () => {
		const real = realpathSync(mkdtempSync("/tmp/dh-tmp-"));
		scratch.push(real);
		expect(real.startsWith("/private/tmp/")).toBe(true);
		const tmpSpelling = join("/tmp", basename(real), "rpc.sock");

		expect(daemonDirectoryName(tmpSpelling)).toBe(daemonDirectoryName(join(real, "rpc.sock")));
		expect(daemonDirectoryName(join(real, "rpc.sock"))).toBe(sha16(join(real, "rpc.sock")));
	});

	it("attaches, and stops, through a second spelling using the one directory the first spelling started", async () => {
		const qa = await sandbox("spelling");
		const started = await ensureFixtureHost(qa);
		const other = join(aliasOf(dirname(qa.socket)), basename(qa.socket));

		const attached = await ensureHost({ agentDir: qa.agentDir, socket: other, _test: { launch: refuseToSpawn } });

		started.release();
		attached.release();

		expect(attached).toEqual({ pid: started.pid, socket: other, reused: true, release: expect.any(Function) });
		expect(await readdir(qa.flatDir, { withFileTypes: true }).then(directoryNames)).toEqual([qa.daemonDirName]);
		expect(await stopHost({ socket: other, agentDir: qa.agentDir, force: true })).toEqual({
			action: "stopped",
			pid: started.pid,
		});
		expect(await waitForPidGone(started.pid, 10_000)).toBe(true);
	}, 20_000);

	it("still lists and removes a directory an older build named after a non-canonical spelling", async () => {
		const qa = await sandbox("legacy-spelling");
		const real = realpathSync(dirname(qa.socket));
		const other = join(aliasOf(real), basename(qa.socket));
		// What a build hashing the spelling left behind: a directory named after `other` itself.
		const legacyDir = join(qa.flatDir, sha16(other));
		await writeJson(join(qa.flatDir, "layout.json"), { layout: 2, dir: sha16(other) });
		await writeJson(join(legacyDir, "endpoint.json"), { layout: 2, socket: other, created_at: "then" });
		expect(sha16(other)).not.toBe(daemonDirectoryName(other));

		expect(await gcHostEndpoints(qa.agentDir)).toEqual({
			removed: [{ socket: other, dir: legacyDir, reason: "socket_absent" }],
			kept: [],
		});
	});
});

function directoryNames(entries: readonly { name: string; isDirectory(): boolean }[]): string[] {
	return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}
