import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readProcessIdentity, readProcessStartTime } from "../../../src/modes/app-server/daemon/process.ts";
import { createSessionPathReservations } from "../../../src/modes/rpc/host-reservations.ts";
import { writeJsonAtomic } from "../../../src/modes/rpc/host-state-json.ts";
import { startSessionHolder } from "./issue-2951-holder-support.ts";

// The child's start time is recorded UTC-tagged but probed in local form: same instant, still a holder.
let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "utc-child-identity-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

it.skipIf(process.platform === "win32")(
	"counts a host child recorded with a UTC-tagged start time as a holder",
	async () => {
		const file = join(root, "session.jsonl");
		const id = "30540000-0000-4000-8000-000000000001";
		await writeFile(file, `${JSON.stringify({ type: "session", version: 3, id, cwd: root })}\n`);
		await using holder = await startSessionHolder(file, id, root);
		const utc = await readProcessIdentity(holder.pid, process.platform, 1_000, undefined, "UTC");
		const local = await readProcessStartTime(holder.pid);
		if (utc.kind !== "present" || local === undefined) throw new Error("holder start time unreadable");
		expect(utc.identity).not.toBe(local);

		const generationDir = join(root, "generations", "child");
		await mkdir(generationDir, { recursive: true });
		await writeJsonAtomic(join(generationDir, "host-child.pid"), {
			pid: holder.pid,
			processStartTime: utc.identity,
		});
		const reservations = createSessionPathReservations({ daemonDir: root, instanceId: "current" });

		expect(await reservations.holderPids?.()).toContain(holder.pid);
	},
);
