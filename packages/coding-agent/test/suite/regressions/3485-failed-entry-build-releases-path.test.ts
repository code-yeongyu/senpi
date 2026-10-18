import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type {
	CreateAgentSessionRuntimeFactory,
	CreateAgentSessionRuntimeResult,
} from "../../../src/core/agent-session-runtime.ts";
import { ProjectTrustStore } from "../../../src/core/trust-manager.ts";
import type { SessionPathOwner, SessionPathReservations } from "../../../src/modes/rpc/host-reservations.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { fakeSessionBase } from "../../helpers/fake-session-base.ts";

const build = vi.hoisted(() => ({ failNext: false }));

vi.mock("../../../src/modes/rpc/session-registry-opening.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/modes/rpc/session-registry-opening.ts")>();
	return {
		...actual,
		buildOpeningEntry: (...args: Parameters<typeof actual.buildOpeningEntry>) => {
			if (build.failNext) {
				build.failNext = false;
				throw new Error("synthetic entry build failure");
			}
			return actual.buildOpeningEntry(...args);
		},
	};
});

const directories: string[] = [];

afterEach(async () => {
	build.failNext = false;
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

// senpi#3485 review: an open whose entry build throws must free its path even when releasing the
// cross-generation claim fails too, or every later reopen of that path is refused.
test("a failed entry build frees the path even when the claim release rejects, so a reopen succeeds", async () => {
	const dir = await mkdtemp(join(tmpdir(), "senpi-3485-build-"));
	directories.push(dir);
	const reservations: SessionPathReservations = {
		claim: async (): Promise<SessionPathOwner | undefined> => undefined,
		release: async () => {
			throw new Error("synthetic claim release failure");
		},
		setAttached: () => {},
	};
	const registry = new RpcSessionRegistry({
		agentDir: dir,
		createRuntime: async (options) => runtime(options),
		pathReservations: reservations,
		closeGraceMs: 50,
	});
	const path = join(dir, "build-fails.jsonl");

	build.failNext = true;
	await expect(registry.openSession({ cwd: dir, sessionPath: path })).rejects.toThrow("synthetic entry build failure");

	await expect(registry.openSession({ cwd: dir, sessionPath: path })).resolves.toMatchObject({
		sessionId: expect.any(String),
	});
	expect(registry.list()).toHaveLength(1);
});
