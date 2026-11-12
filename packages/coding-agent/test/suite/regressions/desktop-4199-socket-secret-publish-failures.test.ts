import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSocketSecret, ensureSocketSecret } from "../../../src/modes/rpc/socket-transport.ts";

const inject = vi.hoisted(() => ({
	/** errno code `link()` fails with. */
	link: undefined as string | undefined,
	/** errno code removing a staging file fails with. */
	unlinkStaging: undefined as string | undefined,
	/** directory whose fsync fails with EIO. */
	syncDirectory: undefined as string | undefined,
	/** statfs `type` (Linux filesystem magic) reported for every directory. */
	filesystemType: undefined as number | undefined,
	errno(code: string, syscall: string): Error {
		return Object.assign(new Error(`${code}: injected ${syscall} failure`), { code, syscall });
	},
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		link: async (...args: Parameters<typeof actual.link>) => {
			if (inject.link !== undefined) throw inject.errno(inject.link, "link");
			return actual.link(...args);
		},
		unlink: async (...args: Parameters<typeof actual.unlink>) => {
			if (inject.unlinkStaging !== undefined && String(args[0]).includes(".stage-")) {
				throw inject.errno(inject.unlinkStaging, "unlink");
			}
			return actual.unlink(...args);
		},
		statfs: async (...args: Parameters<typeof actual.statfs>) => {
			const stats = await actual.statfs(...args);
			return inject.filesystemType === undefined ? stats : { ...stats, type: inject.filesystemType };
		},
		open: async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			if (inject.syncDirectory !== undefined && String(args[0]) === inject.syncDirectory) {
				handle.sync = async () => {
					throw inject.errno("EIO", "fsync");
				};
			}
			return handle;
		},
	};
});

/** Linux statfs magic numbers: msdos/vfat has no hard links (its link() fails EPERM), ext4 has them. */
const MSDOS_SUPER_MAGIC = 0x4d44;
const EXT4_SUPER_MAGIC = 0xef53;

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 (design 4.3, review LOWs on
// senpi#4369). Contract: once `link()` has published the secret, a later cleanup or directory fsync failure is a
// warning and the published secret is returned; a failed `link()` is the error reported, not a cleanup failure after
// it; a filesystem without hard links gets a typed refusal naming the cause, and nothing is written at the final path.
describe.skipIf(process.platform === "win32")("first publication when a filesystem step fails", () => {
	const roots: string[] = [];

	afterEach(async () => {
		inject.link = undefined;
		inject.unlinkStaging = undefined;
		inject.syncDirectory = undefined;
		inject.filesystemType = undefined;
		vi.restoreAllMocks();
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	});

	async function scratch(): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), "rpc4199-publish-fail-"));
		roots.push(root);
		return root;
	}

	function warningCodes(warn: { mock: { calls: unknown[][] } }): unknown[] {
		return warn.mock.calls.map((call) => Reflect.get(Object(call[1]), "code"));
	}

	it("returns the published secret when its staging file cannot be removed", async () => {
		const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
		const secretPath = join(await scratch(), "rpc.sock.secret");
		inject.unlinkStaging = "EBUSY";
		const secret = await createSocketSecret(secretPath);
		expect(secret).toHaveLength(32);
		expect(await readFile(secretPath)).toEqual(secret);
		expect(warningCodes(warn)).toEqual(["SENPI_RPC_SOCKET_SECRET_STAGING_LEFT_BEHIND"]);
	});

	it("reports the failed link, not the failed staging cleanup after it", async () => {
		vi.spyOn(process, "emitWarning").mockImplementation(() => {});
		const secretPath = join(await scratch(), "rpc.sock.secret");
		inject.link = "EIO";
		inject.unlinkStaging = "EBUSY";
		await expect(createSocketSecret(secretPath)).rejects.toMatchObject({ code: "EIO", syscall: "link" });
	});

	it("returns the published secret when the directory fsync after the link fails", async () => {
		const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
		const root = await scratch();
		const secretPath = join(root, "rpc.sock.secret");
		inject.syncDirectory = root;
		const secret = await createSocketSecret(secretPath);
		expect(secret).toHaveLength(32);
		expect(await readFile(secretPath)).toEqual(secret);
		expect(await readdir(root)).toEqual(["rpc.sock.secret"]);
		expect(warningCodes(warn)).toEqual(["SENPI_RPC_SOCKET_SECRET_DIRECTORY_SYNC_FAILED"]);
	});

	it.each([
		["ENOTSUP", undefined],
		["EPERM", MSDOS_SUPER_MAGIC],
	])("refuses with a typed error when link() fails %s on a filesystem without hard links", async (code, type) => {
		const root = await scratch();
		inject.link = code;
		inject.filesystemType = type;
		const refusal = createSocketSecret(join(root, "rpc.sock.secret"));
		await expect(refusal).rejects.toMatchObject({
			name: "SocketSecretHardLinksUnsupportedError",
			reason: "hard_links_unsupported",
			cause: { code },
		});
		await expect(refusal).rejects.toThrow(/its filesystem refused a hard link/);
		expect(await readdir(root)).toEqual([]);
	});

	// review LOW on senpi#6437: EPERM is also a sandbox, MAC or immutable-directory refusal, so on a filesystem that
	// has hard links it must not be blamed on the filesystem.
	it("names a permission or policy refusal when link() fails EPERM on a filesystem with hard links", async () => {
		const root = await scratch();
		inject.link = "EPERM";
		inject.filesystemType = EXT4_SUPER_MAGIC;
		const refusal = createSocketSecret(join(root, "rpc.sock.secret"));
		await expect(refusal).rejects.toMatchObject({
			name: "SocketSecretLinkRefusedError",
			reason: "link_refused",
			cause: { code: "EPERM", syscall: "link" },
		});
		await expect(refusal).rejects.toThrow(/refused by a permission or policy check/);
		expect(await readdir(root)).toEqual([]);
	});
});

// review LOW on senpi#6437: the repair path installs its candidate with rename(); once that landed, a failed directory
// fsync is a warning, and the caller gets the secret now on disk.
describe.skipIf(process.platform === "win32")("repair when the directory fsync after the rename fails", () => {
	let root: string | undefined;

	afterEach(async () => {
		inject.syncDirectory = undefined;
		vi.restoreAllMocks();
		if (root !== undefined) await rm(root, { recursive: true, force: true });
	});

	it("returns the installed secret and warns once", async () => {
		const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
		root = await mkdtemp(join(tmpdir(), "rpc4199-repair-fsync-"));
		const secretPath = join(root, "rpc.sock.secret");
		await writeFile(secretPath, "short", { mode: 0o600 });
		inject.syncDirectory = root;
		const secret = await ensureSocketSecret(secretPath);
		expect(secret).toHaveLength(32);
		expect(await readFile(secretPath)).toEqual(secret);
		expect(warn.mock.calls.map((call) => Reflect.get(Object(call[1]), "code"))).toEqual([
			"SENPI_RPC_SOCKET_SECRET_DIRECTORY_SYNC_FAILED",
		]);
	});
});
