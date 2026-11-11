import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSocketSecret } from "../../../src/modes/rpc/socket-transport.ts";

const inject = vi.hoisted(() => ({
	/** errno code `link()` fails with. */
	link: undefined as string | undefined,
	/** errno code removing a staging file fails with. */
	unlinkStaging: undefined as string | undefined,
	/** directory whose fsync fails with EIO. */
	syncDirectory: undefined as string | undefined,
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

	it.each(["EPERM", "ENOTSUP"])("refuses with a typed error when link() fails %s (no hard links)", async (code) => {
		const root = await scratch();
		inject.link = code;
		await expect(createSocketSecret(join(root, "rpc.sock.secret"))).rejects.toMatchObject({
			name: "SocketSecretHardLinksUnsupportedError",
			reason: "hard_links_unsupported",
			cause: { code },
		});
		expect(await readdir(root)).toEqual([]);
	});
});
