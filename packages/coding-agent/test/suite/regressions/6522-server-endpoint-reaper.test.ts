import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	createServerEndpoint,
	reapOrphanedServerEndpoints,
	SHORT_SERVER_ENDPOINT_PREFIX,
} from "../../../src/experimental/socket-path.ts";
import { readProcessIdentity } from "../../../src/utils/process-identity.ts";

// senpi#6522: a server endpoint moved to a short directory is left behind when its server is killed, so the next server
// that needs one removes the directories whose server is gone - never one whose server could still be alive.
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(mode?: number): string {
	const root = mkdtempSync("/tmp/pes-reap-");
	roots.push(root);
	if (mode !== undefined) chmodSync(root, mode);
	return root;
}

function endpointDir(root: string, name: string, owner?: object): string {
	const directory = join(root, `${SHORT_SERVER_ENDPOINT_PREFIX}${name}`);
	mkdirSync(directory, { mode: 0o700 });
	if (owner !== undefined) writeFileSync(join(directory, ".owner"), JSON.stringify(owner));
	writeFileSync(join(directory, "server.sock"), "");
	return directory;
}

async function ownStartTime(): Promise<string> {
	const identity = await readProcessIdentity(process.pid, process.platform, undefined, undefined, "UTC");
	if (identity.kind !== "present") throw new Error("own process start time is unreadable on this host");
	return identity.identity;
}

it("removes an endpoint directory whose server is gone and keeps one whose server is alive", async () => {
	const root = tempRoot();
	const exited = spawnSync(process.execPath, ["-e", ""]);
	const dead = endpointDir(root, "deadbeef", { pid: exited.pid ?? 999_999_999, processStartTime: "gone" });
	const live = endpointDir(root, "11ve0000", { pid: process.pid, processStartTime: await ownStartTime() });

	await reapOrphanedServerEndpoints([root]);

	expect({ dead: existsSync(dead), live: existsSync(live) }).toEqual({ dead: false, live: true });
});

it("records a start time a reaper in another time zone reads the same, so a live server is kept", async () => {
	tempRoot();
	// The record createServerEndpoint writes, under a server whose TZ is Asia/Seoul.
	vi.stubEnv("TZ", "Asia/Seoul");
	const deep = join("/tmp", "d".repeat(70), "server-00000000-0000-4000-8000-000000000001-0123456789ab.sock");
	const endpoint = await createServerEndpoint(deep);
	const directory = dirname(endpoint.path);
	roots.push(directory);

	// The reaper runs later under UTC: the recorded instant is TZ-independent, so this live server is kept.
	vi.stubEnv("TZ", "UTC");
	await reapOrphanedServerEndpoints([dirname(directory)]);

	expect(existsSync(endpoint.path.replace("server.sock", ".owner"))).toBe(true);
	await endpoint.release();
});

it("removes a directory that has carried no owner record for five minutes and keeps a fresh one", async () => {
	const root = tempRoot();
	const aged = endpointDir(root, "a6ed0000");
	const fresh = endpointDir(root, "fre5h000");
	const longAgo = new Date(Date.now() - 600_000);
	utimesSync(aged, longAgo, longAgo);

	await reapOrphanedServerEndpoints([root]);

	expect({ aged: existsSync(aged), fresh: existsSync(fresh) }).toEqual({ aged: false, fresh: true });
});

it("places the endpoint in the runtime dir when the temp root is not guarded", async () => {
	const unguarded = tempRoot(0o777);
	const runtime = tempRoot(0o700);
	vi.stubEnv("TMPDIR", unguarded);
	vi.stubEnv("XDG_RUNTIME_DIR", runtime);
	const deep = join("/tmp", "d".repeat(70), "server-00000000-0000-4000-8000-000000000001-0123456789ab.sock");

	const endpoint = await createServerEndpoint(deep);

	expect(endpoint.path.startsWith(runtime)).toBe(true);
	await endpoint.release();
});
