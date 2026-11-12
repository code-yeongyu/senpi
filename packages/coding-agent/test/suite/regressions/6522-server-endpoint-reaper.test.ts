import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { reapOrphanedServerEndpoints, SHORT_SERVER_ENDPOINT_PREFIX } from "../../../src/experimental/socket-path.ts";
import { readProcessStartTime } from "../../../src/utils/process-identity.ts";

// senpi#6522: a server endpoint moved to a short directory leaves that directory behind when its server is killed;
// the next server that needs one removes the directories whose recorded owner is gone, never one with a live owner.
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function endpointDir(root: string, name: string, owner: { pid: number; processStartTime: string }): string {
	const directory = join(root, `${SHORT_SERVER_ENDPOINT_PREFIX}${name}`);
	mkdirSync(directory, { mode: 0o700 });
	writeFileSync(join(directory, ".owner"), JSON.stringify(owner));
	writeFileSync(join(directory, "server.sock"), "");
	return directory;
}

it("removes an endpoint directory whose server is gone and keeps one whose server is alive", async () => {
	const root = mkdtempSync("/tmp/pes-reap-");
	roots.push(root);
	const exited = spawnSync(process.execPath, ["-e", ""]);
	const dead = endpointDir(root, "deadbeef", { pid: exited.pid ?? 999_999_999, processStartTime: "gone" });
	const ownStart = await readProcessStartTime(process.pid);
	if (ownStart === undefined) throw new Error("own process start time is unreadable on this host");
	const live = endpointDir(root, "11ve0000", { pid: process.pid, processStartTime: ownStart });

	await reapOrphanedServerEndpoints([root]);

	expect({ dead: existsSync(dead), live: existsSync(live) }).toEqual({ dead: false, live: true });
});
