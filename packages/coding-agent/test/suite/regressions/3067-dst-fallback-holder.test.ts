import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { hostDaemonDirectoryPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { createSessionPathReservations, reservationFile } from "../../../src/modes/rpc/host-reservations.ts";
import { writeJsonAtomic } from "../../../src/modes/rpc/host-state-json.ts";
import {
	processStartTimeMs,
	readProcessIdentity,
	readProcessStartTime,
	sameProcessStartMs,
} from "../../../src/utils/process-identity.ts";
import { startSessionHolder } from "./issue-2951-holder-support.ts";

// senpi#3067 L1: during a DST fall-back the local-time form of a start time is ambiguous
// (01:30 happens twice), so a local-form probe of a child started in the repeated hour parses
// one hour off and the live child stops counting as a holder. Probes must read in UTC and
// only legacy local-format records are parsed as local time.
const DST_ZONE = "America/New_York";
let root: string;
let savedTz: string | undefined;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "dst-fallback-holder-"));
	savedTz = process.env.TZ;
	process.env.TZ = DST_ZONE;
});
afterEach(async () => {
	if (savedTz === undefined) delete process.env.TZ;
	else process.env.TZ = savedTz;
	await rm(root, { recursive: true, force: true });
});

it("local-form fall-back-hour strings misparse by one hour while the UTC form stays exact", () => {
	// 2026-11-01 01:30 happens twice in America/New_York: 01:30 EDT (05:30Z) then 01:30 EST
	// (06:30Z). Date.parse takes the earlier offset, so the local form of a child started in
	// the second hour reads one hour early; the UTC form of the same instant is exact.
	const local = processStartTimeMs("Sun Nov  1 01:30:00 2026");
	const utc = processStartTimeMs("Sun Nov  1 06:30:00 2026 UTC");
	if (local === undefined || utc === undefined) throw new Error("fall-back-hour instants unparseable");
	expect(local).toBe(Date.parse("2026-11-01T05:30:00.000Z"));
	expect(utc).toBe(Date.parse("2026-11-01T06:30:00.000Z"));
	expect(utc - local).toBe(3_600_000);
	expect(sameProcessStartMs(local, utc)).toBe(false);
});

it.skipIf(process.platform === "win32")(
	"a UTC-recorded child stays a holder under a simulated DST zone and published claims carry UTC",
	async () => {
		const file = join(root, "session.jsonl");
		const id = "30670000-0000-4000-8000-000000000001";
		await writeFile(file, `${JSON.stringify({ type: "session", version: 3, id, cwd: root })}\n`);
		await using holder = await startSessionHolder(file, id, root);
		const utc = await readProcessIdentity(holder.pid, process.platform, 1_000, undefined, "UTC");
		const probe = await readProcessStartTime(holder.pid);
		if (utc.kind !== "present" || probe === undefined) throw new Error("holder start time unreadable");
		// The probe itself must read in UTC: a local-form probe of a fall-back-hour child
		// parses 1h off, so it must never be the form a holder lookup compares.
		expect(probe.endsWith(" UTC")).toBe(true);
		expect(sameProcessStartMs(processStartTimeMs(probe), processStartTimeMs(utc.identity))).toBe(true);

		const generationDir = join(root, "generations", "child");
		await mkdir(generationDir, { recursive: true });
		await writeJsonAtomic(join(generationDir, "host-child.pid"), {
			pid: holder.pid,
			processStartTime: utc.identity,
		});
		const reservations = createSessionPathReservations({ daemonDir: root, instanceId: "current" });
		expect(await reservations.holderPids?.()).toContain(holder.pid);

		// Claims published from the probe carry the UTC form, so a later holder lookup
		// compares like with like at any hour of the year. Claim a path the holder does
		// not hold, so the published claim is this process's own.
		const otherFile = join(root, "other.jsonl");
		await reservations.claim(otherFile, true);
		const claimFile = reservationFile(hostDaemonDirectoryPaths(root).reservationsDir, otherFile);
		const claim = JSON.parse(await readFile(claimFile, "utf8")) as { processStartTime: string | null };
		expect(claim.processStartTime?.endsWith(" UTC")).toBe(true);
	},
);
