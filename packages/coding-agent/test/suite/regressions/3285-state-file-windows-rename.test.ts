import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { writeStateFileAtomic } from "../../../src/core/credential-pool/state-file.ts";
import { CredentialStoreBusyError } from "../../../src/core/lockfile-policy.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

const realRename = (await vi.importActual<typeof import("node:fs")>("node:fs")).renameSync;
const refused = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "state-file-rename-3285-"));
	path = join(dir, "credential-pool-state.json");
});

afterEach(() => {
	vi.mocked(fs.renameSync).mockReset().mockImplementation(realRename);
	rmSync(dir, { recursive: true, force: true });
});

describe("a replace Windows refuses for a moment does not fail the write (senpi#3285)", () => {
	test("a transient EPERM/EBUSY on the rename is retried until it lands", async () => {
		vi.mocked(fs.renameSync)
			.mockImplementationOnce(() => {
				throw refused("EPERM");
			})
			.mockImplementationOnce(() => {
				throw refused("EBUSY");
			});

		await writeStateFileAtomic(path, "{}");

		expect(readFileSync(path, "utf-8")).toBe("{}");
	});

	test("a refusal that outlasts the retries reads as a busy store, which health writes skip", async () => {
		vi.mocked(fs.renameSync).mockImplementation(() => {
			throw refused("EACCES");
		});

		await expect(writeStateFileAtomic(path, "{}")).rejects.toThrow(CredentialStoreBusyError);
		expect(fs.existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
	});

	test("any other rename failure still propagates as itself", async () => {
		vi.mocked(fs.renameSync).mockImplementation(() => {
			throw refused("ENOSPC");
		});

		await expect(writeStateFileAtomic(path, "{}")).rejects.toThrow("ENOSPC");
	});
});
