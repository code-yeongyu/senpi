import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { writeJsonAtomic } from "../../../src/modes/rpc/host-state-json.ts";
import { renameRetryingTransient } from "../../../src/utils/paths.ts";

// senpi#7499 review: host state files are now replaced by rename, and Windows refuses a replace for a moment while
// another process (an antivirus, the indexer, a lock-free reader) has the target open. Those refusals are retried with
// the one bounded policy writeJsonAtomic uses, and the existing record stays whole and readable until the replace lands.

const refused = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
const OLD = { pid: 1, generation: 1 };
const NEXT = { pid: 2, generation: 2 };

let dir: string;
let path: string;
let staged: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "host-state-replace-7499-"));
	path = join(dir, "host.pid");
	staged = join(dir, "host.pid.staged.tmp");
	writeFileSync(path, `${JSON.stringify(OLD)}\n`);
	writeFileSync(staged, `${JSON.stringify(NEXT)}\n`);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const recordOnDisk = () => JSON.parse(readFileSync(path, "utf8")) as unknown;

describe("a host state replace Windows refuses for a moment (senpi#7499)", () => {
	test("is retried until it lands, and the old record stays readable meanwhile", async () => {
		const seenDuringRefusals: unknown[] = [];
		const refusals = ["EPERM", "EBUSY"];
		let attempts = 0;

		await renameRetryingTransient(async () => {
			attempts++;
			const code = refusals.shift();
			if (code !== undefined) {
				seenDuringRefusals.push(recordOnDisk());
				throw refused(code);
			}
			await rename(staged, path);
		});

		expect(attempts).toBe(3);
		expect(seenDuringRefusals).toEqual([OLD, OLD]);
		expect(recordOnDisk()).toEqual(NEXT);
	});

	test("throws the refusal once it outlasts the retries, leaving the old record whole", async () => {
		let attempts = 0;

		await expect(
			renameRetryingTransient(async () => {
				attempts++;
				throw refused("EACCES");
			}),
		).rejects.toThrow("EACCES");

		expect(attempts).toBeGreaterThan(1);
		expect(recordOnDisk()).toEqual(OLD);
	});

	test("throws any other error on the first attempt", async () => {
		let attempts = 0;

		await expect(
			renameRetryingTransient(async () => {
				attempts++;
				throw refused("ENOSPC");
			}),
		).rejects.toThrow("ENOSPC");

		expect(attempts).toBe(1);
		expect(recordOnDisk()).toEqual(OLD);
	});

	// The writer's own temporaries; the policy tests' staged file is a fixture, not one of them.
	const temporaries = () =>
		readdirSync(dir).filter(
			(name) => name.startsWith("host.pid.") && name.endsWith(".tmp") && join(dir, name) !== staged,
		);

	test("writeJsonAtomic keeps the old record whole through transient refusals, then publishes", async () => {
		const seenDuringRefusals: unknown[] = [];
		const refusals = ["EPERM", "EBUSY"];

		await writeJsonAtomic(path, NEXT, {
			rename: async (from, to) => {
				const code = refusals.shift();
				if (code === undefined) return rename(from, to);
				seenDuringRefusals.push(recordOnDisk());
				throw refused(code);
			},
		});

		expect(seenDuringRefusals).toEqual([OLD, OLD]);
		expect(recordOnDisk()).toEqual(NEXT);
		expect(temporaries()).toEqual([]);
	});

	test("writeJsonAtomic throws a refusal that outlasts the retries, old record whole, no temporary left", async () => {
		let attempts = 0;

		await expect(
			writeJsonAtomic(path, NEXT, {
				rename: async () => {
					attempts++;
					throw refused("EBUSY");
				},
			}),
		).rejects.toThrow("EBUSY");

		expect(attempts).toBeGreaterThan(1);
		expect(recordOnDisk()).toEqual(OLD);
		expect(temporaries()).toEqual([]);
	});

	test("writeJsonAtomic fails once on a real non-transient replace error and leaves no temporary file", async () => {
		const occupied = join(dir, "occupied");
		mkdirSync(occupied);
		writeFileSync(join(occupied, "keep"), "x");

		await expect(writeJsonAtomic(occupied, NEXT)).rejects.toThrow();

		expect(existsSync(join(occupied, "keep"))).toBe(true);
		expect(readdirSync(dir).filter((name) => name.startsWith("occupied.") && name.endsWith(".tmp"))).toEqual([]);
	});
});
