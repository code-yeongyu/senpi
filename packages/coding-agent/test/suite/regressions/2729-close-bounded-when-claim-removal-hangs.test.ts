import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hostDaemonDirectoryPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { createSessionPathReservations, reservationFile } from "../../../src/modes/rpc/host-reservations.ts";
import { RpcSessionRegistry, RpcSessionRegistryError } from "../../../src/modes/rpc/session-registry.ts";
import type { RpcSessionEntry } from "../../../src/modes/rpc/session-registry-types.ts";
import { closeSession, type SessionTeardownHost } from "../../../src/modes/rpc/session-teardown.ts";

// A claim deletion that never settles, as on a wedged mount. Every other filesystem call reaches disk.
const wedged = vi.hoisted(() => ({ path: "", entered: Promise.withResolvers<void>(), release: () => {} }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		rm: async (...args: Parameters<typeof actual.rm>) => {
			if (args[0] === wedged.path) {
				wedged.entered.resolve();
				await new Promise<void>((resolve) => {
					wedged.release = resolve;
				});
			}
			return actual.rm(...args);
		},
	};
});

const GRACE_MS = 30_000;
let root = "";
let stderr: string[] = [];

beforeEach(async () => {
	root = realpathSync(await mkdtemp(join(tmpdir(), "senpi-2729-wedged-")));
	wedged.entered = Promise.withResolvers<void>();
	stderr = [];
	vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		stderr.push(String(chunk));
		return true;
	});
});

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	wedged.release();
	wedged.path = "";
	await rm(root, { recursive: true, force: true });
});

const wedge = (daemonDir: string, path: string): void => {
	wedged.path = reservationFile(hostDaemonDirectoryPaths(daemonDir).reservationsDir, path);
};

it("completes close within the grace window and reports it when the claim removal never settles", async () => {
	// Given a session whose claim file removal hangs.
	const daemonDir = join(root, "daemon");
	const path = join(root, "session.jsonl");
	const reservations = createSessionPathReservations({ daemonDir, instanceId: "owner" });
	expect(await reservations.claim(path)).toBeUndefined();
	wedge(daemonDir, path);
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
		closeGraceMs: GRACE_MS,
		get: (handle) => entries.get(handle),
		delete: (handle) => {
			entries.delete(handle);
		},
		releaseReservation: (key) => reservations.release(key),
		markDetached: () => {},
		now: () => 0,
		sync: () => {},
	};

	// When the close reaches the hung removal and the grace window passes.
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	let closed = false;
	const closing = closeSession(host, "session").then(() => {
		closed = true;
	});
	await wedged.entered.promise;
	expect(closed).toBe(false);
	await vi.advanceTimersByTimeAsync(GRACE_MS);
	await closing;

	// Then the close completes, the entry is gone, and the stuck removal is reported.
	expect(closed).toBe(true);
	expect(entries.has("session")).toBe(false);
	expect(stderr.join("")).toContain("session path reservation was not removed within 30000 ms");
});

it("reports a failed open within the grace window when its rollback's claim removal never settles", async () => {
	// Given a registry whose runtime cannot start and whose claim removal hangs.
	const daemonDir = join(root, "daemon");
	const path = join(root, "session.jsonl");
	const registry = new RpcSessionRegistry({
		agentDir: join(root, "agent"),
		closeGraceMs: GRACE_MS,
		pathReservations: createSessionPathReservations({ daemonDir, instanceId: "owner" }),
		createRuntime: async () => {
			throw new Error("Synthetic runtime startup rejection");
		},
	});
	wedge(daemonDir, path);

	// When the open fails, reaches the hung removal, and the grace window passes.
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const opening = registry.openSession({ cwd: root, sessionPath: path }).then(
		() => undefined,
		(cause: unknown) => cause,
	);
	await wedged.entered.promise;
	await vi.advanceTimersByTimeAsync(GRACE_MS);

	// Then the caller still gets the open failure instead of waiting forever.
	const failure = await opening;
	expect(failure).toBeInstanceOf(RpcSessionRegistryError);
	expect(failure).toMatchObject({ code: "open_failed" });
	expect(stderr.join("")).toContain("session path reservation was not removed within 30000 ms");
});
