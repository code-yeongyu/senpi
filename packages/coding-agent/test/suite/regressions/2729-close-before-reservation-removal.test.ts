import { spawn } from "node:child_process";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import { beforeEach, expect, it, vi } from "vitest";
import { hostDaemonDirectoryPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { createSessionPathReservations, reservationFile } from "../../../src/modes/rpc/host-reservations.ts";
import { RpcSessionRegistry, RpcSessionRegistryError } from "../../../src/modes/rpc/session-registry.ts";
import type { RpcSessionEntry } from "../../../src/modes/rpc/session-registry-types.ts";
import { closeSession, type SessionTeardownHost } from "../../../src/modes/rpc/session-teardown.ts";

// Hold only the real claim deletion. All other filesystem calls still reach disk.
const deletion = vi.hoisted(() => ({
	path: "",
	started: Promise.withResolvers<void>(),
	resume: Promise.withResolvers<void>(),
	completedPath: "",
	removalEntered: false,
	completed: Promise.withResolvers<void>(),
	renamePath: "",
	renameStarted: Promise.withResolvers<void>(),
	renameResume: Promise.withResolvers<void>(),
	renameCompleted: Promise.withResolvers<void>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		rm: async (...args: Parameters<typeof actual.rm>) => {
			if (args[0] === deletion.completedPath) deletion.removalEntered = true;
			if (args[0] === deletion.path) {
				deletion.started.resolve();
				await deletion.resume.promise;
			}
			await actual.rm(...args);
			if (args[0] === deletion.completedPath) deletion.completed.resolve();
		},
		rename: async (...args: Parameters<typeof actual.rename>) => {
			if (args[0] === deletion.renamePath) {
				deletion.renameStarted.resolve();
				await deletion.renameResume.promise;
				try {
					await actual.rename(...args);
				} finally {
					deletion.renameCompleted.resolve();
				}
				return;
			}
			return actual.rename(...args);
		},
	};
});

beforeEach(() => {
	deletion.path = "";
	deletion.started = Promise.withResolvers<void>();
	deletion.resume = Promise.withResolvers<void>();
	deletion.completedPath = "";
	deletion.removalEntered = false;
	deletion.completed = Promise.withResolvers<void>();
	deletion.renamePath = "";
	deletion.renameStarted = Promise.withResolvers<void>();
	deletion.renameResume = Promise.withResolvers<void>();
	deletion.renameCompleted = Promise.withResolvers<void>();
});

it("lets a successor reopen immediately after close completes when claim deletion is held", async () => {
	// Given a live foreign generation with an attached claim on a real session path.
	const root = realpathSync(await mkdtemp(join(tmpdir(), "senpi-2729-")));
	const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
		stdio: ["pipe", "ignore", "ignore"],
	});
	const exited = once(child, "exit");
	let closing: Promise<void> | undefined;
	let reopened: ReturnType<ReturnType<typeof createSessionPathReservations>["claim"]> | undefined;
	try {
		await once(child, "spawn");
		const pid = child.pid;
		if (pid === undefined) throw new Error("Foreign generation did not start");
		const daemonDir = join(root, "daemon");
		const path = join(root, "session.jsonl");
		const predecessor = createSessionPathReservations({ daemonDir, instanceId: "predecessor", pid });
		const successor = createSessionPathReservations({ daemonDir, instanceId: "successor" });
		expect(await predecessor.claim(path)).toBeUndefined();
		expect(await successor.claim(path)).toMatchObject({ instanceId: "predecessor", attached: true });
		deletion.path = reservationFile(hostDaemonDirectoryPaths(daemonDir).reservationsDir, path);
		const entry: RpcSessionEntry = {
			state: "open",
			kind: "interactive",
			context: {},
			scope: new ProviderScope(),
			profile: { cwd: root },
			cwd: root,
			attachments: 1,
			lastCommandAt: 0,
			lifecycleMutex: Promise.resolve(),
			reservationKey: path,
		};
		const entries = new Map([["session", entry]]);
		const host: SessionTeardownHost = {
			closeGraceMs: 30_000,
			get: (handle) => entries.get(handle),
			delete: (handle) => {
				entries.delete(handle);
			},
			releaseReservation: (key) => predecessor.release(key),
			markDetached: (key) => predecessor.setAttached(key, false),
			now: () => 0,
			sync: () => {},
		};

		// When the client reopens only after the predecessor reports close completion.
		let closeCompleted = false;
		closing = closeSession(host, "session");
		reopened = closing.then(() => {
			closeCompleted = true;
			return successor.claim(path);
		});
		await deletion.started.promise;
		// This disk-read completion observes the still-held claim after queued close reactions.
		await readFile(deletion.path);
		if (closeCompleted) await reopened;
		deletion.resume.resolve();

		// Then the reopen succeeds even while the predecessor process remains alive.
		expect(await reopened).toBeUndefined();
	} finally {
		deletion.resume.resolve();
		try {
			await closing;
			await reopened;
		} finally {
			deletion.path = "";
			child.kill("SIGKILL");
			await exited;
			await rm(root, { recursive: true, force: true });
		}
	}
}, 15_000);

it("does not overwrite a successor claim with an attachment update already being published", async () => {
	// Given an attachment update whose real atomic rename is already in flight.
	const root = realpathSync(await mkdtemp(join(tmpdir(), "senpi-2729-update-")));
	const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
		stdio: ["pipe", "ignore", "ignore"],
	});
	const exited = once(child, "exit");
	let released: Promise<void> | undefined;
	try {
		await once(child, "spawn");
		const pid = child.pid;
		if (pid === undefined) throw new Error("Foreign generation did not start");
		const daemonDir = join(root, "daemon");
		const path = join(root, "session.jsonl");
		const predecessor = createSessionPathReservations({ daemonDir, instanceId: "predecessor", pid });
		const successor = createSessionPathReservations({ daemonDir, instanceId: "successor" });
		await predecessor.claim(path);
		const dir = hostDaemonDirectoryPaths(daemonDir).reservationsDir;
		const file = reservationFile(dir, path);
		deletion.renamePath = `${file}.${pid}.tmp`;
		deletion.completedPath = file;
		predecessor.setAttached(path, false);
		await deletion.renameStarted.promise;

		// When the successor takes ownership only after release reports completion.
		released = Promise.resolve(predecessor.release(path));
		if (deletion.removalEntered) {
			await deletion.completed.promise;
			await released;
			expect(await successor.claim(path)).toBeUndefined();
			deletion.renameResume.resolve();
			await deletion.renameCompleted.promise;
		} else {
			deletion.renameResume.resolve();
			await released;
			expect(await successor.claim(path)).toBeUndefined();
		}

		// Then no write from the released generation can erase that new ownership.
		expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ instanceId: "successor", attached: true });
	} finally {
		deletion.renameResume.resolve();
		try {
			await released;
		} finally {
			deletion.renamePath = "";
			deletion.completedPath = "";
			child.kill("SIGKILL");
			await exited;
			await rm(root, { recursive: true, force: true });
		}
	}
}, 15_000);

it("lets a successor reopen after a failed runtime start reports its failure", async () => {
	// Given an actual registry whose runtime cannot start, with a live cross-generation claim.
	const root = realpathSync(await mkdtemp(join(tmpdir(), "senpi-2729-open-")));
	const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
		stdio: ["pipe", "ignore", "ignore"],
	});
	const exited = once(child, "exit");
	let reopened: Promise<unknown> | undefined;
	try {
		await once(child, "spawn");
		const pid = child.pid;
		if (pid === undefined) throw new Error("Foreign generation did not start");
		const daemonDir = join(root, "daemon");
		const path = join(root, "session.jsonl");
		const predecessor = createSessionPathReservations({ daemonDir, instanceId: "predecessor", pid });
		const successor = createSessionPathReservations({ daemonDir, instanceId: "successor" });
		const registry = new RpcSessionRegistry({
			agentDir: join(root, "agent"),
			pathReservations: predecessor,
			createRuntime: async () => {
				throw new Error("Synthetic runtime startup rejection");
			},
		});
		deletion.path = reservationFile(hostDaemonDirectoryPaths(daemonDir).reservationsDir, path);

		// When the caller retries through the successor only after open reports its failure.
		let failureReported = false;
		reopened = registry.openSession({ cwd: root, sessionPath: path }).catch((cause: unknown) => {
			if (!(cause instanceof RpcSessionRegistryError) || cause.code !== "open_failed") throw cause;
			failureReported = true;
			return successor.claim(path);
		});
		await deletion.started.promise;
		await readFile(deletion.path);
		if (failureReported) await reopened;
		deletion.resume.resolve();

		// Then the failed startup leaves no standing claim that blocks the caller's retry.
		expect(await reopened).toBeUndefined();
	} finally {
		deletion.resume.resolve();
		try {
			await reopened;
		} finally {
			deletion.path = "";
			child.kill("SIGKILL");
			await exited;
			await rm(root, { recursive: true, force: true });
		}
	}
}, 15_000);
