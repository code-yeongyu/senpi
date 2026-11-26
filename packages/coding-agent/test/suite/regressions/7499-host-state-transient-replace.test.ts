import * as fsp from "node:fs/promises";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { writeJsonAtomic } from "../../../src/modes/rpc/host-state-json.ts";

// senpi#7499 review: host state files are now replaced by rename, and Windows refuses a replace for a moment while
// another process (an antivirus, the indexer, a lock-free reader) has the target open. Those refusals must be retried,
// and the existing record must stay whole and readable until the replace lands.

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, rename: vi.fn(actual.rename) };
});

const realRename = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).rename;
const refused = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
const OLD = { pid: 1, generation: 1 };
const NEXT = { pid: 2, generation: 2 };

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "host-state-replace-7499-"));
	path = join(dir, "host.pid");
	writeFileSync(path, `${JSON.stringify(OLD)}\n`);
});

afterEach(() => {
	vi.mocked(fsp.rename).mockReset().mockImplementation(realRename);
	rmSync(dir, { recursive: true, force: true });
});

const recordOnDisk = () => JSON.parse(readFileSync(path, "utf8")) as unknown;
const leftoverTemps = () => readdirSync(dir).filter((name) => name.endsWith(".tmp"));

describe("a host state replace Windows refuses for a moment (senpi#7499)", () => {
	test("is retried until it lands, and the old record stays readable meanwhile", async () => {
		const seenDuringRefusals: unknown[] = [];
		const refuseWith = (code: string) => async () => {
			seenDuringRefusals.push(recordOnDisk());
			throw refused(code);
		};
		vi.mocked(fsp.rename).mockImplementationOnce(refuseWith("EPERM")).mockImplementationOnce(refuseWith("EBUSY"));

		await writeJsonAtomic(path, NEXT);

		expect(seenDuringRefusals).toEqual([OLD, OLD]);
		expect(recordOnDisk()).toEqual(NEXT);
		expect(leftoverTemps()).toEqual([]);
	});

	test("fails with the refusal once it outlasts the retries, leaving the old record whole", async () => {
		vi.mocked(fsp.rename).mockImplementation(async () => {
			throw refused("EACCES");
		});

		await expect(writeJsonAtomic(path, NEXT)).rejects.toThrow("EACCES");
		expect(vi.mocked(fsp.rename).mock.calls.length).toBeGreaterThan(1);
		expect(recordOnDisk()).toEqual(OLD);
		expect(leftoverTemps()).toEqual([]);
	});

	test("fails once on any other rename error, leaving the old record whole", async () => {
		vi.mocked(fsp.rename).mockImplementation(async () => {
			throw refused("ENOSPC");
		});

		await expect(writeJsonAtomic(path, NEXT)).rejects.toThrow("ENOSPC");
		expect(vi.mocked(fsp.rename)).toHaveBeenCalledTimes(1);
		expect(recordOnDisk()).toEqual(OLD);
		expect(existsSync(path)).toBe(true);
		expect(leftoverTemps()).toEqual([]);
	});
});
