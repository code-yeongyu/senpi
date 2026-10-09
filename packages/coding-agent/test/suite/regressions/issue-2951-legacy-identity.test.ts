import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readProcessStartMs } from "../../../src/core/extensions/builtin/terminal/process-start-probe.ts";
import {
	ProcessIdentityUnreadableError,
	processMatchesPidFile,
	processStartTimeMs,
	readProcessStartTime,
} from "../../../src/modes/app-server/daemon/process.ts";
import { createHostDaemonPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { writeHostRegistration, writtenByThisProcess } from "../../../src/modes/rpc/host-daemon-registration.ts";
import {
	claimOwnerIsLive,
	createSessionPathReservations,
	readSessionPathClaims,
} from "../../../src/modes/rpc/host-reservations.ts";
import { startSessionHolder } from "./issue-2951-holder-support.ts";

const id = "29510000-0000-4000-8000-000000000005";
const unknownStart = "legacy timestamp unavailable";
let root: string;
let file: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "held-legacy-identity-"));
	file = join(root, "session.jsonl");
	await writeFile(file, `${JSON.stringify({ type: "session", version: 3, id, cwd: root })}\n`);
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

it.each(["liveness", "registration"] as const)(
	"preserves a live unparseable legacy claim across %s without granting family membership",
	async (boundary) => {
		await using holder = await startSessionHolder(file, id, root);
		const paths = createHostDaemonPaths({ agentDir: root, socket: join(root, "rpc.sock") });
		await writeHostRegistration(
			paths,
			{
				record: { pid: holder.pid, processStartTime: unknownStart },
				socket: paths.socket,
				instanceId: "legacy",
				generation: 0,
				launchProfileId: "legacy",
			},
			{ fresh: true },
		);
		const previous = createSessionPathReservations({ daemonDir: paths.dir, instanceId: "legacy", pid: holder.pid });
		await previous.claim(file);
		const claim = (await readSessionPathClaims(paths.reservationsDir))[0];
		if (!claim) throw new Error("Legacy claim missing");
		const owner = { ...claim.owner, processStartTime: unknownStart };
		await writeFile(claim.file, JSON.stringify(owner));
		if (boundary === "registration")
			await writeHostRegistration(paths, {
				record: { pid: process.pid, processStartTime: (await readProcessStartTime(process.pid)) ?? null },
				socket: paths.socket,
				instanceId: "current",
				generation: 1,
				launchProfileId: "current",
			});
		expect(JSON.parse(await readFile(claim.file, "utf8"))).toMatchObject(owner);
		expect(await claimOwnerIsLive(owner)).toBe(true);
		const current = createSessionPathReservations({ daemonDir: paths.dir, instanceId: "current" });
		await expect(
			current.holderPids?.(new Map([[holder.pid, await readProcessStartMs(holder.pid)]])),
		).resolves.toEqual([]);
	},
);

it.each([
	{ offset: 0, matches: true },
	{ offset: 3_000, matches: true },
	{ offset: 4_000, matches: false },
])("compares parsed pidfile identities at offset $offset", async ({ offset, matches }) => {
	const start = Date.parse("2026-10-08T12:00:00.000Z");
	await expect(
		processMatchesPidFile(
			{ pid: process.pid, processStartTime: new Date(start).toISOString() },
			async () => new Date(start + offset).toUTCString(),
			() => true,
			{ attempts: 1 },
		),
	).resolves.toBe(matches);
	await expect(
		writtenByThisProcess({ pid: process.pid, startTime: new Date(start).toISOString() }, async () =>
			new Date(start + offset).toUTCString(),
		),
	).resolves.toBe(matches);
});

it.each([
	{ offset: 3_000, matches: true },
	{ offset: 4_000, matches: false },
])("compares parsed claim identities at offset $offset", async ({ offset, matches }) => {
	const identity = await readProcessStartTime(process.pid);
	const started = identity === undefined ? undefined : processStartTimeMs(identity);
	if (started === undefined) throw new Error("Current process identity unavailable");
	await expect(
		claimOwnerIsLive({
			pid: process.pid,
			instanceId: "previous",
			sessionPath: file,
			processStartTime: new Date(started + offset).toISOString(),
		}),
	).resolves.toBe(matches);
});

it("keeps an unparseable live pidfile unproven for signaling", async () => {
	await expect(
		processMatchesPidFile(
			{ pid: process.pid, processStartTime: unknownStart },
			async () => "2026-10-08T12:00:00.000Z",
			() => true,
			{ attempts: 1 },
		),
	).rejects.toBeInstanceOf(ProcessIdentityUnreadableError);
});
