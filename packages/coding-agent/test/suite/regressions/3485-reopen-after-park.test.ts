import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type {
	CreateAgentSessionRuntimeFactory,
	CreateAgentSessionRuntimeResult,
} from "../../../src/core/agent-session-runtime.ts";
import { ProjectTrustStore } from "../../../src/core/trust-manager.ts";
import { createHostDaemonPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import {
	readHandoverParkedSessions,
	recordHandoverParkedSession,
} from "../../../src/modes/rpc/host-handover-parked.ts";
import { reopenHandoverParkedSessions } from "../../../src/modes/rpc/host-handover-reopen.ts";
import type { SessionPathOwner, SessionPathReservations } from "../../../src/modes/rpc/host-reservations.ts";
import { canonicalSessionPath } from "../../../src/modes/rpc/session-path-key.ts";
import { RpcSessionRegistry, RpcSessionRegistryError } from "../../../src/modes/rpc/session-registry.ts";
import { fakeSessionBase } from "../../helpers/fake-session-base.ts";

// senpi#3485: a session the host had just parked was refused with session_path_in_use when a client
// reopened it at once. The host's own handover-parked watch reopened the park it had just written, and
// a second open of a path whose first open was still taking its cross-generation claim was refused.

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function runtime(options: Parameters<CreateAgentSessionRuntimeFactory>[0]): CreateAgentSessionRuntimeResult {
	new ProjectTrustStore(options.agentDir).set(options.cwd, true);
	return {
		session: {
			...fakeSessionBase(options),
			isFastModeActive: () => false,
			agent: { state: {} },
			isStreaming: false,
			getContextUsage: () => undefined,
			favoriteModels: [],
			scopedModels: [],
			isBashRunning: false,
			extensionRunner: { hasHandlers: () => false, emit: async () => {} },
			abort: async () => {},
			waitForIdle: async () => {},
			dispose: () => {},
			messages: [],
			pendingMessageCount: 0,
		},
		services: { cwd: options.cwd, agentDir: options.agentDir },
		diagnostics: [],
	} as unknown as CreateAgentSessionRuntimeResult;
}

function gatedClaims(firstHolder?: SessionPathOwner) {
	const entered = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	let claims = 0;
	const reservations: SessionPathReservations = {
		claim: async (): Promise<SessionPathOwner | undefined> => {
			claims += 1;
			if (claims === 1) {
				entered.resolve();
				await gate.promise;
				return firstHolder;
			}
			return undefined;
		},
		release: async () => {},
		setAttached: () => {},
	};
	return { reservations, entered: entered.promise, open: () => gate.resolve() };
}

async function registryRig(reservations: SessionPathReservations, closeGraceMs?: number) {
	const dir = await mkdtemp(join(tmpdir(), "senpi-3485-"));
	directories.push(dir);
	const registry = new RpcSessionRegistry({
		agentDir: dir,
		createRuntime: async (options) => runtime(options),
		pathReservations: reservations,
		...(closeGraceMs === undefined ? {} : { closeGraceMs }),
	});
	return { dir, registry, path: join(dir, "parked.jsonl") };
}

const settled = <T>(promise: Promise<T>) =>
	promise.then(
		(value) => ({ value }),
		(error: unknown) => ({ error }),
	);

const DURABLE_ID = "34850000-0000-4000-8000-000000000001";

describe("reopening a path whose open is still taking its claim (senpi#3485)", () => {
	for (const [label, client] of [
		["by path", {}],
		["by durable id", { durableSessionId: DURABLE_ID }],
	] as const) {
		test(`a client reopen ${label} attaches to the in-flight open instead of refusing`, async () => {
			const claims = gatedClaims();
			const { dir, registry, path } = await registryRig(claims.reservations);
			// The first open is the one a parked session's reopen makes: it carries the durable id.
			const first = registry.openSession({ cwd: dir, sessionPath: path, durableSessionId: DURABLE_ID });
			await claims.entered;

			// The client's reopen lands while the first open is held between its reservation and its entry.
			const second = settled(registry.openSession({ cwd: dir, sessionPath: path, ...client }));
			claims.open();

			const opened = await first;
			expect(await second).toEqual({
				value: expect.objectContaining({ sessionId: opened.sessionId, attached: true }),
			});
			expect(registry.list()).toHaveLength(1);
		});
	}

	test("a claim that never settles ends the waiting reopen with a retryable refusal", async () => {
		const claims = gatedClaims();
		const { dir, registry, path } = await registryRig(claims.reservations, 50);
		const first = settled(registry.openSession({ cwd: dir, sessionPath: path }));
		await claims.entered;

		const second = await settled(registry.openSession({ cwd: dir, sessionPath: path }));

		expect(second).toEqual({ error: expect.any(RpcSessionRegistryError) });
		const refusal = (second as { error: RpcSessionRegistryError }).error;
		expect(refusal.code).toBe("session_path_in_use");
		expect(refusal.detail).toMatchObject({ reason: "claim_in_progress", retry_after_ms: expect.any(Number) });
		claims.open();
		expect(await first).toEqual({ value: expect.objectContaining({ sessionPath: canonicalSessionPath(path) }) });
	});

	test("when the first of three racing opens is refused, the next takes the claim and the third attaches", async () => {
		const foreign: SessionPathOwner = {
			instanceId: "predecessor",
			pid: 1,
			processStartTime: null,
			sessionPath: "",
			attached: true,
			current: true,
		};
		const claims = gatedClaims(foreign);
		const { dir, registry, path } = await registryRig(claims.reservations);
		const first = settled(registry.openSession({ cwd: dir, sessionPath: path }));
		await claims.entered;
		const second = settled(registry.openSession({ cwd: dir, sessionPath: path }));
		const third = settled(registry.openSession({ cwd: dir, sessionPath: path }));

		claims.open();

		const refused = await first;
		expect(refused).toEqual({ error: expect.any(RpcSessionRegistryError) });
		expect((refused as { error: RpcSessionRegistryError }).error.detail).toMatchObject({ owner: foreign });
		const opened = await second;
		expect(opened).toEqual({ value: expect.objectContaining({ sessionPath: canonicalSessionPath(path) }) });
		const { sessionId } = (opened as { value: { sessionId: string } }).value;
		expect(await third).toEqual({ value: expect.objectContaining({ sessionId, attached: true }) });
		expect(registry.list()).toHaveLength(1);
	});
});

describe("a host's handover-parked watch and its own parks (senpi#3485)", () => {
	test("reopens a predecessor's parks, including one that lands mid-watch, but never this host's own", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "senpi-3485-watch-"));
		directories.push(agentDir);
		const socket = join(agentDir, "host.sock");
		const daemonDir = createHostDaemonPaths({ socket, agentDir }).dir;
		const own = join(agentDir, "own.jsonl");
		const inherited = join(agentDir, "inherited.jsonl");
		const late = join(agentDir, "late.jsonl");
		for (const path of [own, inherited, late]) await writeFile(path, "", "utf8");
		await recordHandoverParkedSession(daemonDir, {
			sessionPath: own,
			retainOnDisconnect: true,
			parkedBy: "this-host",
		});
		await recordHandoverParkedSession(daemonDir, {
			sessionPath: inherited,
			retainOnDisconnect: true,
			parkedBy: "predecessor",
		});
		const opened: string[] = [];

		await reopenHandoverParkedSessions(
			async (entry) => {
				opened.push(entry.sessionPath);
				// The predecessor's drain parks another session while this watch is already running.
				if (entry.sessionPath === inherited)
					await recordHandoverParkedSession(daemonDir, {
						sessionPath: late,
						retainOnDisconnect: true,
						parkedBy: "predecessor",
					});
			},
			agentDir,
			socket,
			{ hostInstance: "this-host" },
		);

		expect(opened).toEqual([inherited, late]);
		expect((await readHandoverParkedSessions(daemonDir)).map((entry) => entry.sessionPath)).toEqual([own]);
	});
});
