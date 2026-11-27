/**
 * senpi#7564: an endpoint directory nothing names (a husk) has no ensure lock gc could take, so it used to be kept
 * forever as `unknown_identity`. Unknown identity alone never condemns one: a husk is collected only once nothing in it
 * names a socket, no pid named anywhere in it is alive (an unreadable record counts as alive), and its whole tree is
 * older than the horizon. Clock and pid liveness are injected, so no test waits or depends on a real process.
 */
import { mkdtempSync } from "node:fs";
import { lstat, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemonDirectories, createHostDaemonPaths } from "../src/modes/rpc/host-daemon-paths.ts";
import { gcHostEndpoints } from "../src/modes/rpc/host-gc.ts";
import { HUSK_HORIZON_MS, type HuskPidRecord } from "../src/modes/rpc/host-gc-husk.ts";
import { gcHostEndpointsOpportunistically } from "../src/modes/rpc/host-gc-pass.ts";
import { daemonTreeDigest } from "./helpers/rpc-host-endpoints.ts";
import { closeServer, listeningSocket } from "./helpers/rpc-host-gc-fixtures.ts";

const NOW = Date.parse("2026-11-27T00:00:00.000Z");
const EXPIRED = NOW - HUSK_HORIZON_MS - 1;
const LIVE_PID = 4242;
const now = () => NOW;
const pidLive = async (record: HuskPidRecord) => record.pid === LIVE_PID;
const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function agentDirWithLayout(): Promise<string> {
	const agentDir = mkdtempSync(join(tmpdir(), "sa-7564h-"));
	roots.push(agentDir);
	await mkdir(join(agentDir, "rpc-host-daemon"), { recursive: true });
	await writeFile(join(agentDir, "rpc-host-daemon", "layout.json"), `${JSON.stringify({ layout: 2, dir: "x" })}\n`);
	return agentDir;
}

/** A directory nothing names: `files` maps relative paths to contents, `null` for an empty directory. */
async function husk(agentDir: string, files: Record<string, string | null>, mtimeMs: number): Promise<string> {
	const dir = join(agentDir, "rpc-host-daemon", "0123456789abcdef");
	await mkdir(dir, { recursive: true });
	for (const [path, content] of Object.entries(files)) {
		if (content === null) await mkdir(join(dir, path), { recursive: true });
		else {
			await mkdir(dirname(join(dir, path)), { recursive: true });
			await writeFile(join(dir, path), content);
		}
	}
	await age(dir, mtimeMs);
	return dir;
}

/** Sets every entry under `path`, then `path` itself, to `mtimeMs`: children first, so no write refreshes a parent. */
async function age(path: string, mtimeMs: number): Promise<void> {
	if ((await lstat(path)).isDirectory()) {
		for (const entry of await readdir(path)) await age(join(path, entry), mtimeMs);
	}
	await utimes(path, mtimeMs / 1000, mtimeMs / 1000);
}

const pidFile = (pid: number) => JSON.stringify({ pid, processStartTime: "Thu Nov 26 10:00:00 2026" });
const claim = (pid: number) =>
	JSON.stringify({ instanceId: "i-1", pid, processStartTime: "Thu Nov 26 10:00:00 2026", sessionPath: "/s.jsonl" });
const flatEntries = async (agentDir: string) => (await readdir(join(agentDir, "rpc-host-daemon"))).sort();

describe.skipIf(process.platform === "win32")("gc of identity-less endpoint directories", () => {
	it("keeps a husk one millisecond inside the horizon byte-identical", async () => {
		const agentDir = await agentDirWithLayout();
		const dir = await husk(agentDir, { "crashes.jsonl": "{}\n", reservations: null }, NOW - HUSK_HORIZON_MS + 1);
		const before = await daemonTreeDigest(dir);

		expect(await gcHostEndpoints(agentDir, { husk: { now, pidLive } })).toEqual({
			removed: [],
			kept: [{ socket: null, dir, reason: "unknown_identity" }],
		});
		expect(await daemonTreeDigest(dir)).toEqual(before);
	});

	it("removes an expired husk whose every record names a dead process", async () => {
		const agentDir = await agentDirWithLayout();
		const dir = await husk(
			agentDir,
			{ "generations/g-1/host.pid": pidFile(111), "crashes.jsonl": "{}\n", reservations: null },
			EXPIRED,
		);

		expect(await gcHostEndpoints(agentDir, { husk: { now, pidLive } })).toEqual({
			removed: [{ socket: null, dir, reason: "identity_unknown_expired" }],
			kept: [],
		});
		expect(await flatEntries(agentDir)).toEqual(["layout.json"]);
	});

	it.each([
		["host.pid", pidFile(LIVE_PID)],
		["generations/g-1/host.pid", pidFile(LIVE_PID)],
		["generations/g-1/host-child.pid", pidFile(LIVE_PID)],
		["reservations/c.json", claim(LIVE_PID)],
	])("keeps an expired husk while %s names a live process", async (path, content) => {
		const agentDir = await agentDirWithLayout();
		const dir = await husk(agentDir, { [path]: content }, EXPIRED);
		const before = await daemonTreeDigest(dir);

		expect((await gcHostEndpoints(agentDir, { husk: { now, pidLive } })).kept).toEqual([
			{ socket: null, dir, reason: "unknown_identity" },
		]);
		expect(await daemonTreeDigest(dir)).toEqual(before);
	});

	it.each([
		["reservations/c.json", "not json"],
		["generations/g-1/host.pid", "{ torn"],
	])("keeps an expired husk whose %s cannot be read", async (path, content) => {
		const agentDir = await agentDirWithLayout();
		const dir = await husk(agentDir, { [path]: content }, EXPIRED);

		expect((await gcHostEndpoints(agentDir, { husk: { now, pidLive } })).kept).toEqual([
			{ socket: null, dir, reason: "unknown_identity" },
		]);
	});

	it("keeps an expired husk when any entry inside it is younger than the horizon", async () => {
		const agentDir = await agentDirWithLayout();
		const dir = await husk(agentDir, { "generations/g-1/host.pid": pidFile(111) }, EXPIRED);
		await utimes(join(dir, "generations", "g-1", "host.pid"), NOW / 1000, NOW / 1000);

		expect((await gcHostEndpoints(agentDir, { husk: { now, pidLive } })).kept).toEqual([
			{ socket: null, dir, reason: "unknown_identity" },
		]);
	});

	it("puts a husk back when a naming record appears while it is being reaped", async () => {
		const agentDir = await agentDirWithLayout();
		const dir = await husk(agentDir, { reservations: null }, EXPIRED);
		const afterMove = async (moved: string) => {
			await writeFile(join(moved, "endpoint.json"), `${JSON.stringify({ socket: "/elsewhere.sock" })}\n`);
		};

		expect(await gcHostEndpoints(agentDir, { husk: { now, pidLive, _test: { afterMove } } })).toEqual({
			removed: [],
			kept: [{ socket: null, dir, reason: "unknown_identity" }],
		});
		expect((await readdir(dir)).sort()).toEqual(["endpoint.json", "reservations"]);
		expect(await flatEntries(agentDir)).toEqual(["0123456789abcdef", "layout.json"]);
	});

	it("collects an expired husk beside a live endpoint and leaves the live one untouched", async () => {
		const agentDir = await agentDirWithLayout();
		const socket = join(agentDir, "s", "live.sock");
		const paths = createHostDaemonPaths({ socket, agentDir });
		await createDaemonDirectories(paths);
		const server = await listeningSocket(socket);
		try {
			const dir = await husk(agentDir, { reservations: null }, EXPIRED);
			const liveBefore = await daemonTreeDigest(paths.dir);

			const result = await gcHostEndpoints(agentDir, { husk: { now, pidLive } });

			expect(result.removed).toEqual([{ socket: null, dir, reason: "identity_unknown_expired" }]);
			expect(result.kept).toEqual([{ socket, dir: paths.dir, reason: "reachable" }]);
			expect(await daemonTreeDigest(paths.dir)).toEqual(liveBefore);
		} finally {
			await closeServer(server);
		}
	});

	it("puts back a dead reaper's leftover that no longer qualifies", async () => {
		const agentDir = await agentDirWithLayout();
		const leftover = join(agentDir, "rpc-host-daemon", ".reap-0123456789abcdef-111");
		await mkdir(join(leftover, "reservations"), { recursive: true });
		await writeFile(join(leftover, "endpoint.json"), `${JSON.stringify({ socket: "/elsewhere.sock" })}\n`);

		await gcHostEndpoints(agentDir, { husk: { now, pidLive } });

		expect(await flatEntries(agentDir)).toEqual(["0123456789abcdef", "layout.json"]);
	});

	it("sweeps a reap left behind by a dead reaper and keeps a live reaper's", async () => {
		const agentDir = await agentDirWithLayout();
		const flat = join(agentDir, "rpc-host-daemon");
		await mkdir(join(flat, ".reap-0123456789abcdef-111", "reservations"), { recursive: true });
		await mkdir(join(flat, `.reap-fedcba9876543210-${LIVE_PID}`), { recursive: true });
		await age(join(flat, ".reap-0123456789abcdef-111"), EXPIRED);
		await age(join(flat, `.reap-fedcba9876543210-${LIVE_PID}`), EXPIRED);

		await gcHostEndpoints(agentDir, { husk: { now, pidLive } });

		expect(await flatEntries(agentDir)).toEqual([`.reap-fedcba9876543210-${LIVE_PID}`, "layout.json"]);
	});
});

describe.skipIf(process.platform === "win32")("the budgeted pass and identity-less directories", () => {
	it("collects an expired husk without an operator", async () => {
		const agentDir = await agentDirWithLayout();
		await husk(agentDir, { "generations/g-1/host.pid": pidFile(111) }, EXPIRED);

		const outcome = await gcHostEndpointsOpportunistically({
			agentDir,
			exclude: join(agentDir, "t.sock"),
			now,
			husk: { pidLive },
		});

		expect(outcome.ran && outcome.marker.removed).toBe(1);
		expect(await flatEntries(agentDir)).toEqual(["gc-last-run.json", "layout.json"]);
	});

	it("removes a staged marker its dead writer left and keeps a live writer's", async () => {
		const agentDir = await agentDirWithLayout();
		const flat = join(agentDir, "rpc-host-daemon");
		await writeFile(join(flat, "gc-last-run.json.111.tmp"), "{}\n");
		await writeFile(join(flat, `gc-last-run.json.${LIVE_PID}.tmp`), "{}\n");

		await gcHostEndpointsOpportunistically({ agentDir, exclude: join(agentDir, "t.sock"), now, husk: { pidLive } });

		expect(await flatEntries(agentDir)).toEqual([
			"gc-last-run.json",
			`gc-last-run.json.${LIVE_PID}.tmp`,
			"layout.json",
		]);
	});
});
