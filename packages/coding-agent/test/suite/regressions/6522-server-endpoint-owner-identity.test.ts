import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	createServerEndpoint,
	reapOrphanedServerEndpoints,
	SHORT_SERVER_ENDPOINT_PREFIX,
} from "../../../src/experimental/socket-path.ts";
import { readAliasOwnerStartTime } from "../../../src/modes/rpc/host-socket-bind.ts";

// senpi#6522 review r1: the owner record and the sweep must read one instant (a server under TZ=UTC and a sweep
// under TZ=Asia/Seoul read the same start time), a start time that cannot be read must not leave the directory
// behind, and the temp root must be one no other user can take an entry out of.
const roots: string[] = [];
const longPreferredPath = `/tmp/${"d".repeat(120)}/server.sock`;

afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function privateRoot(): string {
	const root = mkdtempSync("/tmp/pes-tz-");
	roots.push(root);
	return root;
}

it("keeps a live server's endpoint when the sweep runs in another timezone", async () => {
	const root = privateRoot();
	vi.stubEnv("TMPDIR", root);
	vi.stubEnv("TZ", "UTC");
	const endpoint = await createServerEndpoint(longPreferredPath);
	expect(endpoint.path.startsWith(root)).toBe(true);

	vi.stubEnv("TZ", "Asia/Seoul");
	await reapOrphanedServerEndpoints([root]);

	expect(existsSync(endpoint.path.replace("/server.sock", ""))).toBe(true);
});

it("records no start time rather than leaving a directory without an owner", async () => {
	const root = privateRoot();
	const endpoint = await createServerEndpoint(longPreferredPath, {
		roots: [root],
		readStartTime: () => Promise.reject(new Error("ps probe starved")),
	});
	const directory = endpoint.path.replace("/server.sock", "");

	expect(JSON.parse(readFileSync(join(directory, ".owner"), "utf8"))).toStrictEqual({
		pid: process.pid,
		processStartTime: null,
	});
	// A directory whose owner start time was never read is never proven dead.
	await reapOrphanedServerEndpoints([root]);
	expect(existsSync(directory)).toBe(true);
	await endpoint.release();
	expect(existsSync(directory)).toBe(false);
});

it("skips a temp root another user could take an entry out of", async () => {
	const unguarded = privateRoot();
	const guarded = privateRoot();
	// World-writable and not sticky: another user could rename our endpoint directory away.
	mkdirSync(join(unguarded, "marker"));
	spawnSync("chmod", ["0777", unguarded]);

	const endpoint = await createServerEndpoint(longPreferredPath, { roots: [unguarded, guarded] });

	expect({
		inGuarded: endpoint.path.startsWith(guarded),
		inUnguarded: endpoint.path.startsWith(unguarded),
	}).toStrictEqual({ inGuarded: true, inUnguarded: false });
});

it("writes the owner start time the sweep reads", async () => {
	const root = privateRoot();
	const endpoint = await createServerEndpoint(longPreferredPath, { roots: [root] });
	const owner: unknown = JSON.parse(readFileSync(join(endpoint.path.replace("/server.sock", ""), ".owner"), "utf8"));

	expect(Reflect.get(owner as object, "processStartTime")).toBe(await readAliasOwnerStartTime(process.pid));
});

it("removes an endpoint directory whose server is gone", async () => {
	const root = privateRoot();
	const exited = spawnSync(process.execPath, ["-e", ""]);
	const directory = join(root, `${SHORT_SERVER_ENDPOINT_PREFIX}deadbeef`);
	mkdirSync(directory, { mode: 0o700 });
	writeFileSync(
		join(directory, ".owner"),
		JSON.stringify({ pid: exited.pid ?? 999_999_999, processStartTime: "gone" }),
	);

	await reapOrphanedServerEndpoints([root]);

	expect(existsSync(directory)).toBe(false);
});
