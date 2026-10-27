import * as childProcess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openEndpointReservationStore } from "../../../src/modes/rpc/endpoint-reservation-store.ts";
import { createHostDaemonPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { startHost } from "../../../src/modes/rpc/host-ensure-start.ts";
import { createSocketSecret, readSocketSecret, socketSecretPath } from "../../../src/modes/rpc/socket-transport.ts";
import { processIsLive, readProcessStartTime } from "../../../src/utils/process-identity.ts";

const lockRoot = vi.hoisted(() => ({ dir: "" }));

// The reservation store lives beside the endpoint lock, whose win32 name comes from the pipe-address formula; with the
// platform stubbed on a POSIX runner it is pointed at this test's own directory instead.
vi.mock("../../../src/modes/rpc/host-ensure-lock.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../src/modes/rpc/host-ensure-lock.ts")>()),
	hostEnsureLockTarget: () => join(lockRoot.dir, "endpoint"),
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof childProcess>();
	return { ...actual, spawn: vi.fn(actual.spawn) };
});

// The readiness probe connects to the win32 pipe address of the socket, which no POSIX runner can host: the gate is
// answered here instead, as "nothing answered", the outcome a dead or stalled supervisor produces.
vi.mock("../../../src/modes/rpc/host-readiness.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../src/modes/rpc/host-readiness.ts")>()),
	pollProtocolInfo: async () => ({ ready: false }),
}));

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 (design test 3).
// Security contract: a valid public Windows socket secret belongs to its logical endpoint, so a start
// never rotates it. Clients that read it before the start keep deriving the same pipe name and handshake.
describe("startHost and an existing valid public socket secret", () => {
	const created: string[] = [];
	const claimants: number[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		for (const pid of claimants.splice(0)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
		for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function prepared() {
		const root = mkdtempSync(join(tmpdir(), "rpc4199-"));
		created.push(root);
		const agentDir = join(root, "agent");
		const socket = join(root, "rpc.sock");
		const secretPath = socketSecretPath(socket);
		lockRoot.dir = root;
		const original = await createSocketSecret(secretPath);
		const paths = await createHostDaemonPaths({ agentDir, socket });
		vi.stubGlobal("process", Object.create(process, { platform: { value: "win32" } }));
		return { root, agentDir, socket, secretPath, original, paths, storePath: join(root, "endpoint.reservation.db") };
	}

	async function generationState(storePath: string) {
		const store = await openEndpointReservationStore(storePath);
		try {
			const [reservation, ...others] = store.census();
			expect(others).toEqual([]);
			if (!reservation) throw new Error("no generation was reserved");
			return reservation;
		} finally {
			store.close();
		}
	}

	it("keeps the secret byte-identical up to the supervisor spawn on win32", async () => {
		const { agentDir, socket, secretPath, original, paths } = await prepared();
		const reachedSpawn = new Error("start reached the supervisor spawn");

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

	// Design 4.2a "Crash, cancellation and commit": a failed start fences its generation durably, so an offer it left
	// behind can never be claimed and a grant it issued can never commit a pre-listen intent.
	it("fences its reservation generation when the start fails before the spawn, keeping the original error", async () => {
		const { agentDir, socket, paths, storePath } = await prepared();
		const reachedSpawn = new Error("start reached the supervisor spawn");

		await vi.mocked(childProcess.spawn).withImplementation(
			() => {
				throw reachedSpawn;
			},
			async () => {
				await expect(startHost(paths, socket, { agentDir, socket })).rejects.toBe(reachedSpawn);
			},
		);

		expect(await generationState(storePath)).toMatchObject({
			state: "cancelling",
			roles: [{ role: "supervisor", status: "revoked", participant: null }],
		});
	});

	it("fences the generation and closes the store when readiness fails after the supervisor was granted", async () => {
		const { agentDir, socket, paths, storePath } = await prepared();
		const claimant = resolve("test/fixtures/reservation-claimant.mjs");

		await expect(
			startHost(paths, socket, {
				agentDir,
				socket,
				_test: {
					launch: (args) => ({ command: process.execPath, args: ["--import", "tsx", claimant, ...args] }),
					// The platform is stubbed to win32 above; the real child runs here, so its identity is read the POSIX way.
					readProcessStartTime: (pid) => readProcessStartTime(pid, "linux"),
					stopTimeoutMs: 2_000,
				},
			}),
		).rejects.toThrow(/did not answer get_protocol_info/);

		const generation = await generationState(storePath);
		expect(generation).toMatchObject({ state: "cancelling", roles: [{ role: "supervisor", status: "granted" }] });
		const participant = JSON.parse(generation.roles[0]?.participant ?? "{}") as { pid: number };
		claimants.push(participant.pid);
		expect(processIsLive(participant.pid)).toBe(false);
	}, 30_000);
});
