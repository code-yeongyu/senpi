// senpi#3566 todo 4: the server-owned descendants ledger is durable before the ack and readable by a later server
// instance (crash recovery); the launch log keeps the order its frames were recorded in.
import { appendFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type DescendantEntry, DescendantsLedger, LaunchLog } from "./descendants.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "tcd-"));
	roots.push(root);
	return root;
}

function entry(launchId: string, overrides: Partial<DescendantEntry> = {}): DescendantEntry {
	return {
		launchId,
		generation: 1,
		origin: "kernel",
		api: "cp.spawn",
		containment: "own-group",
		lifetime: "owned",
		pid: 4100,
		pgid: 4100,
		atMs: 1,
		...overrides,
	};
}

describe("DescendantsLedger", () => {
	it("is on disk, owner-only, when append resolves, and a later instance reads it back in order", async () => {
		const path = join(await scratch(), "g1", "descendants.ledger");
		const ledger = new DescendantsLedger(path);
		await ledger.append(entry("a"));
		await ledger.append(entry("b", { lifetime: "detached" }));
		expect(await DescendantsLedger.readPersisted(path)).toEqual([entry("a"), entry("b", { lifetime: "detached" })]);
		expect(ledger.entries().map((item) => item.launchId)).toEqual(["a", "b"]);
		if (process.platform !== "win32") {
			expect((await stat(path)).mode & 0o777).toBe(0o600);
			expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
		}
	});

	it("skips a torn final line from a crash mid-append and keeps every whole line", async () => {
		const path = join(await scratch(), "descendants.ledger");
		await new DescendantsLedger(path).append(entry("whole"));
		await appendFile(path, '{"launchId":"torn","gener');
		expect(await DescendantsLedger.readPersisted(path)).toEqual([entry("whole")]);
	});

	it("reads nothing when no ledger was ever written, and remove() clears memory and disk", async () => {
		const path = join(await scratch(), "descendants.ledger");
		expect(await DescendantsLedger.readPersisted(path)).toEqual([]);
		const ledger = new DescendantsLedger(path);
		await ledger.append(entry("a"));
		await ledger.remove();
		expect(ledger.entries()).toEqual([]);
		expect(await DescendantsLedger.readPersisted(path)).toEqual([]);
	});
});

describe("LaunchLog", () => {
	it("keeps the order frames were recorded in, even when recorded without awaiting", async () => {
		const path = join(await scratch(), "launches.jsonl");
		const log = new LaunchLog(path);
		for (let index = 0; index < 50; index++) void log.record({ type: "launch", launchId: `L${index}` });
		await log.settled();
		const lines = (await readFile(path, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { launchId: string; atMs: number });
		expect(lines.map((line) => line.launchId)).toEqual(Array.from({ length: 50 }, (_, index) => `L${index}`));
		expect(lines.every((line) => typeof line.atMs === "number")).toBe(true);
	});
});
