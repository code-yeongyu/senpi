import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	createGenerationDirectory,
	createHostDaemonPaths,
	generationPaths,
} from "../../../src/modes/rpc/host-daemon-paths.ts";
import { HOST_INSTANCE_ID_ENV } from "../../../src/modes/rpc/host-identity-env.ts";
import * as internalHop from "../../../src/modes/rpc/host-lifecycle-internal-key.ts";
import * as publicProxy from "../../../src/modes/rpc/host-lifecycle-proxy.ts";
import { runHostSupervisor } from "../../../src/modes/rpc/host-lifecycle.ts";
import { writeJsonAtomic } from "../../../src/modes/rpc/host-state-json.ts";

vi.mock("../../../src/modes/rpc/host-lifecycle-internal-key.ts", { spy: true });
vi.mock("../../../src/modes/rpc/host-lifecycle-proxy.ts", { spy: true });

const roots: string[] = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each([
	{ stage: "public secret", ensured: false },
	{ stage: "internal hop", ensured: false },
	{ stage: "public secret", ensured: true },
	{ stage: "internal hop", ensured: true },
])("cleans only its own generation after $stage fails (already ensured=$ensured)", async ({ stage, ensured }) => {
	const root = await mkdtemp(join(tmpdir(), "rpc3584-failure-"));
	roots.push(root);
	// Exercise the win32-only step, deriving the same endpoint identity as the supervisor.
	vi.stubGlobal("process", Object.create(process, { platform: { value: "win32" } }));
	const agentDir = join(root, "agent");
	const socket = join(root, "rpc.sock");
	const paths = createHostDaemonPaths({ agentDir, socket });
	const instanceId = "failing-generation";
	const generation = generationPaths(paths, instanceId);
	const settings = { instanceId, generation: 7 };
	vi.stubEnv(HOST_INSTANCE_ID_ENV, instanceId);
	if (ensured) {
		await createGenerationDirectory(generation);
		await writeFile(generation.settingsFile, JSON.stringify(settings));
	}
	const failure = new Error(`injected ${stage} failure`);
	await vi.mocked(publicProxy.ensurePublicSocketSecret).withImplementation(
		async () => {
			expect((await stat(generation.scratchDir)).isDirectory()).toBe(true);
			if (stage === "public secret") throw failure;
			return Buffer.alloc(32);
		},
		async () => {
			await vi.mocked(internalHop.prepareInternalHop).withImplementation(
				async () => {
					expect((await stat(generation.scratchDir)).isDirectory()).toBe(true);
					throw failure;
				},
				async () => {
					await expect(runHostSupervisor({ agentDir, socket, hostArgs: [] })).rejects.toBe(failure);
				},
			);
		},
	);
	if (ensured) {
		expect(JSON.parse(await readFile(generation.settingsFile, "utf8"))).toEqual(settings);
		expect((await stat(generation.scratchDir)).isDirectory()).toBe(true);
	} else {
		await expect(stat(generation.dir)).rejects.toMatchObject({ code: "ENOENT" });
	}
});

it.each([false, true])("makes generation state writable before child startup (already ensured=%s)", async (ensured) => {
	// Given a fresh direct launch, or the generation an ensure has already provisioned.
	const root = await mkdtemp(join(tmpdir(), "rpc3584-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	const socket = join(root, "rpc.sock");
	const paths = createHostDaemonPaths({ agentDir, socket });
	const instanceId = "starting-generation";
	const generation = generationPaths(paths, instanceId);
	const settings = { instanceId, generation: 7 };
	vi.stubEnv(HOST_INSTANCE_ID_ENV, instanceId);
	if (ensured) {
		await createGenerationDirectory(generation);
		await writeFile(generation.settingsFile, JSON.stringify(settings));
	}
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const stopped = new Error("startup held before allocating the internal hop or spawning a child");

	await vi.mocked(internalHop.prepareInternalHop).withImplementation(
		async () => {
			entered.resolve();
			await release.promise;
			throw stopped;
		},
		async () => {
			// When startup reaches the gate, no host child or other directory writer exists.
			const starting = runHostSupervisor({ agentDir, socket, hostArgs: [] });
			starting.catch(() => undefined);
			try {
				await entered.promise;
				// Then the exact atomic file operation used by recordChildPid can already succeed.
				// On main, a direct launch fails here with ENOENT without any removal or contention.
				const child = { pid: process.pid, processStartTime: null };
				await writeJsonAtomic(generation.childPidFile, child);
				expect(JSON.parse(await readFile(generation.childPidFile, "utf8"))).toEqual(child);
				if (ensured) {
					expect(JSON.parse(await readFile(generation.settingsFile, "utf8"))).toEqual(settings);
				}
			} finally {
				release.resolve();
				await expect(starting).rejects.toBe(stopped);
			}
		},
	);
});
