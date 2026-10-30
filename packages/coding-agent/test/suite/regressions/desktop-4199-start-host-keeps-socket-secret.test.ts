import * as childProcess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostDaemonPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { startHost } from "../../../src/modes/rpc/host-ensure-start.ts";
import { createSocketSecret, readSocketSecret, socketSecretPath } from "../../../src/modes/rpc/socket-transport.ts";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof childProcess>();
	return { ...actual, spawn: vi.fn(actual.spawn) };
});

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 (design test 3).
// Security contract: a valid public Windows socket secret belongs to its logical endpoint, so a start
// never rotates it. Clients that read it before the start keep deriving the same pipe name and handshake.
describe("startHost and an existing valid public socket secret", () => {
	const created: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("keeps the secret byte-identical up to the supervisor spawn on win32", async () => {
		const root = mkdtempSync(join(tmpdir(), "rpc4199-"));
		created.push(root);
		const agentDir = join(root, "agent");
		const socket = join(root, "rpc.sock");
		const secretPath = socketSecretPath(socket);
		const original = await createSocketSecret(secretPath);
		const paths = await createHostDaemonPaths({ agentDir, socket });
		const reachedSpawn = new Error("start reached the supervisor spawn");
		vi.stubGlobal("process", Object.create(process, { platform: { value: "win32" } }));

		await vi.mocked(childProcess.spawn).withImplementation(
			() => {
				throw reachedSpawn;
			},
			async () => {
				await expect(startHost(paths, socket, { agentDir, socket })).rejects.toBe(reachedSpawn);
			},
		);

		expect(await readSocketSecret(secretPath)).toEqual(original);
	});
});
