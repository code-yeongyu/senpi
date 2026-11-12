import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	createServerEndpoint,
	readEndpointOwnerStartTime,
	reapOrphanedServerEndpoints,
	SHORT_SERVER_ENDPOINT_PREFIX,
} from "../../../src/experimental/socket-path.ts";

// senpi#6522: an endpoint directory a server never finished claiming (no usable owner record) is removed once no
// starting server could still be writing one. A guarded TMPDIR is used first; this user's XDG_RUNTIME_DIR only when
// TMPDIR is unguarded, and the shared /tmp last.
const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(mode: number): string {
	const root = mkdtempSync("/tmp/pes-roots-");
	chmodSync(root, mode);
	roots.push(root);
	return root;
}

function ownerlessDir(root: string, name: string, ageMs: number): string {
	const directory = join(root, `${SHORT_SERVER_ENDPOINT_PREFIX}${name}`);
	mkdirSync(directory, { mode: 0o700 });
	writeFileSync(join(directory, "server.sock"), "");
	const at = new Date(Date.now() - ageMs);
	utimesSync(directory, at, at);
	return directory;
}

it("removes an ownerless endpoint directory after five minutes and keeps a fresh one", async () => {
	const root = tempRoot(0o700);
	const aged = ownerlessDir(root, "a6ed0000", 600_000);
	const fresh = ownerlessDir(root, "fre5h000", 1_000);

	await reapOrphanedServerEndpoints([root]);

	expect({ aged: existsSync(aged), fresh: existsSync(fresh) }).toEqual({ aged: false, fresh: true });
});

it("places the endpoint in the runtime directory when the temp directory is not guarded", async () => {
	const unguarded = tempRoot(0o777);
	const runtime = tempRoot(0o700);
	vi.stubEnv("TMPDIR", unguarded);
	vi.stubEnv("XDG_RUNTIME_DIR", runtime);
	const deep = join("/tmp", "d".repeat(70), "server-00000000-0000-4000-8000-000000000001-0123456789ab.sock");

	const endpoint = await createServerEndpoint(deep);

	expect(endpoint.path.startsWith(`${runtime}/`)).toBe(true);
	await endpoint.release();
});

it("keeps a directory whose record names a live pid with no start time, however old it is", async () => {
	const root = tempRoot(0o700);
	const directory = join(root, `${SHORT_SERVER_ENDPOINT_PREFIX}n0start00`);
	mkdirSync(directory, { mode: 0o700 });
	// What the writer records when its own start-time probe was starved: the server is live, the start time is not known.
	writeFileSync(join(directory, ".owner"), JSON.stringify({ pid: process.pid, processStartTime: null }));
	writeFileSync(join(directory, "server.sock"), "");
	const longAgo = new Date(Date.now() - 600_000);
	utimesSync(directory, longAgo, longAgo);

	await reapOrphanedServerEndpoints([root]);

	expect(existsSync(directory)).toBe(true);
});

it("removes a directory whose record names a dead pid with no start time", async () => {
	const root = tempRoot(0o700);
	const exited = spawnSync(process.execPath, ["-e", ""]);
	const directory = join(root, `${SHORT_SERVER_ENDPOINT_PREFIX}dead0st0`);
	mkdirSync(directory, { mode: 0o700 });
	writeFileSync(join(directory, ".owner"), JSON.stringify({ pid: exited.pid ?? 999_999_999, processStartTime: null }));
	writeFileSync(join(directory, "server.sock"), "");

	await reapOrphanedServerEndpoints([root]);

	expect(existsSync(directory)).toBe(false);
});

it("bounds the owner start-time probe when ps itself hangs", async () => {
	const binDir = tempRoot(0o700);
	// A 'ps' that never answers, first on PATH: without the probe's own timeout this read would hang, not resolve.
	writeFileSync(join(binDir, "ps"), "#!/bin/sh\nexec sleep 600\n", { mode: 0o755 });
	vi.stubEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);
	const started = Date.now();

	// The bound ends the probe instead of waiting on ps: it settles, and the writer records null while the sweep's
	// matcher turns a throw for a live pid into "unreadable", which holds the directory.
	await expect(readEndpointOwnerStartTime(process.pid)).rejects.toThrow();

	expect(Date.now() - started).toBeLessThan(60_000);
}, 120_000);

it("removes a directory whose owner record does not parse, on the same age rule as none", async () => {
	const root = tempRoot(0o700);
	const aged = join(root, `${SHORT_SERVER_ENDPOINT_PREFIX}bad0json`);
	mkdirSync(aged, { mode: 0o700 });
	writeFileSync(join(aged, ".owner"), "{not json");
	writeFileSync(join(aged, "server.sock"), "");
	const longAgo = new Date(Date.now() - 600_000);
	utimesSync(aged, longAgo, longAgo);
	const fresh = join(root, `${SHORT_SERVER_ENDPOINT_PREFIX}bad0fre5`);
	mkdirSync(fresh, { mode: 0o700 });
	writeFileSync(join(fresh, ".owner"), "{not json");

	await reapOrphanedServerEndpoints([root]);

	expect({ aged: existsSync(aged), fresh: existsSync(fresh) }).toEqual({ aged: false, fresh: true });
});
