/**
 * senpi#7564: only the identity writer creates an endpoint directory. A writer that recreated one after gc removed it
 * (or before an ensure registered it) left a directory nothing names, which no gc can lock or remove. Each writer below
 * now creates only its own subdirectory under an endpoint directory that must exist, and reports when it is gone.
 */
import { mkdtempSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createDaemonDirectories,
	createGenerationDirectory,
	createHostDaemonPaths,
	generationPaths,
	HostDaemonStateError,
} from "../../../src/modes/rpc/host-daemon-paths.ts";
import { recordHandoverParkedSession } from "../../../src/modes/rpc/host-handover-parked.ts";
import { createSessionPathReservations, reservationFile } from "../../../src/modes/rpc/host-reservations.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function endpoint() {
	const agentDir = mkdtempSync(join(tmpdir(), "sa-7564p-"));
	roots.push(agentDir);
	return { agentDir, paths: createHostDaemonPaths({ socket: join(agentDir, "s", "e.sock"), agentDir }) };
}

const gone = expect.objectContaining({ code: "ENOENT" });

describe("writers never recreate a removed endpoint directory", () => {
	it("a session-path claim writes its reservation while the endpoint exists", async () => {
		const { agentDir, paths } = endpoint();
		await createDaemonDirectories(paths);
		const sessionPath = join(agentDir, "a.jsonl");
		const reservations = createSessionPathReservations({ daemonDir: paths.dir, instanceId: "i-1" });

		expect(await reservations.claim(sessionPath)).toBeUndefined();

		await expect(stat(reservationFile(paths.reservationsDir, sessionPath))).resolves.toBeDefined();
	});

	it("a session-path claim against a removed endpoint creates nothing and reports the write", async () => {
		const { agentDir, paths } = endpoint();
		const failures: string[] = [];
		const reservations = createSessionPathReservations({
			daemonDir: paths.dir,
			instanceId: "i-1",
			onFailure: (message) => failures.push(message),
		});

		expect(await reservations.claim(join(agentDir, "a.jsonl"))).toBeUndefined();

		await expect(stat(paths.dir)).rejects.toEqual(gone);
		expect(failures).toEqual([expect.stringContaining("could not be written")]);
	});

	it("a parked-handover record against a removed endpoint is refused and creates nothing", async () => {
		const { agentDir, paths } = endpoint();

		await expect(
			recordHandoverParkedSession(paths.dir, { sessionPath: join(agentDir, "a.jsonl"), retainOnDisconnect: true }),
		).rejects.toEqual(gone);

		await expect(stat(paths.dir)).rejects.toEqual(gone);
	});

	it("a generation directory is created inside a registered endpoint", async () => {
		const { paths } = endpoint();
		await createDaemonDirectories(paths);
		const generation = generationPaths(paths, "g-1");

		await createGenerationDirectory(generation);

		expect(await readdir(generation.dir)).toEqual(["scratch"]);
	});

	it("a generation directory against a removed endpoint is refused and creates nothing", async () => {
		const { paths } = endpoint();

		await expect(createGenerationDirectory(generationPaths(paths, "g-1"))).rejects.toBeInstanceOf(
			HostDaemonStateError,
		);

		await expect(stat(paths.dir)).rejects.toEqual(gone);
	});
});
