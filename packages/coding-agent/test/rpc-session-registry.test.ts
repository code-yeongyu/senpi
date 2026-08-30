import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getApiProvider, registerApiProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, test } from "vitest";
import {
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeResult,
} from "../src/core/agent-session-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { SessionCommandRouter } from "../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../src/modes/rpc/session-event-writer.ts";
import { type RpcSessionLaunchProfile, RpcSessionRegistry } from "../src/modes/rpc/session-registry.ts";

const profile = (cwd: string, sessionPath: string): RpcSessionLaunchProfile => ({
	cwd,
	sessionPath,
	permissionPreset: "default",
	creationModel: { provider: "test", modelId: "model" },
	initialThinkingLevel: "high",
});

function runtime(
	options: Parameters<CreateAgentSessionRuntimeFactory>[0],
	controls?: { waitForIdle?: () => Promise<void> },
) {
	new ProjectTrustStore(options.agentDir).set(options.cwd, true);
	return {
		session: {
			sessionManager: options.sessionManager,
			agentDir: options.agentDir,
			// Projected into the `open_session` wire state, which shares one builder with get_state.
			isFastModeActive: () => false,
			getContextUsage: () => undefined,
			favoriteModels: [],
			scopedModels: [],
			isBashRunning: false,
			isStreaming: false,
			extensionRunner: { hasHandlers: () => false, emit: async () => {} },
			abort: async () => {},
			abortBash: () => {},
			waitForIdle: controls?.waitForIdle ?? (async () => {}),
			dispose: () => {},
			messages: [],
			pendingMessageCount: 0,
		},
		services: { cwd: options.cwd, agentDir: options.agentDir },
		diagnostics: [],
	} as unknown as CreateAgentSessionRuntimeResult;
}

describe("RPC session registry", () => {
	const directories: string[] = [];
	afterEach(async () => {
		await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	async function createRegistry() {
		const dir = await mkdtemp(join(tmpdir(), "senpi-rpc-registry-"));
		directories.push(dir);
		return {
			dir,
			registry: new RpcSessionRegistry({
				agentDir: dir,
				createRuntime: async (options) => runtime(options),
			}),
		};
	}

	test("opens independent sessions with distinct opaque handles", async () => {
		const { dir, registry } = await createRegistry();
		const first = await registry.openSession(profile(dir, join(dir, "first.jsonl")));
		const second = await registry.openSession(profile(dir, join(dir, "second.jsonl")));

		expect(first.sessionId).not.toBe(second.sessionId);
		expect(first.durableSessionId).not.toBe(second.durableSessionId);
		expect(registry.list()).toHaveLength(2);
	});

	test("reserves a canonical path before asynchronous runtime construction", async () => {
		const { dir } = await createRegistry();
		let release!: () => void;
		const opened = new Promise<void>((resolve) => {
			release = resolve;
		});
		const registry = new RpcSessionRegistry({
			agentDir: dir,
			createRuntime: async (options) => {
				await opened;
				return runtime(options);
			},
		});
		const samePath = join(dir, "same.jsonl");
		const first = registry.openSession(profile(dir, samePath));
		await expect(registry.openSession(profile(dir, samePath))).rejects.toMatchObject({ code: "session_path_in_use" });
		release();
		await first;
	});

	test("rejects commands while closing, then releases the reservation after disposal", async () => {
		const { dir } = await createRegistry();
		let releaseIdle!: () => void;
		const idle = new Promise<void>((resolve) => {
			releaseIdle = resolve;
		});
		let disposed = false;
		const registry = new RpcSessionRegistry({
			agentDir: dir,
			createRuntime: async (options) => {
				const result = runtime(options, { waitForIdle: () => idle });
				const dispose = result.session.dispose;
				result.session.dispose = () => {
					disposed = true;
					dispose();
				};
				return result;
			},
		});
		const path = join(dir, "closing.jsonl");
		const opened = await registry.openSession(profile(dir, path));
		const closing = registry.close(opened.sessionId);

		expect(() => registry.getForCommand(opened.sessionId, "prompt")).toThrow(/session_closing/);
		expect(registry.getForCommand(opened.sessionId, "abort").state).toBe("closing");
		releaseIdle();
		await closing;
		expect(disposed).toBe(true);
		await expect(registry.openSession(profile(dir, path))).resolves.toMatchObject({ sessionId: expect.any(String) });
	});

	test("marks closing before binding disposal so a concurrent command cannot enter its handler", async () => {
		const { dir } = await createRegistry();
		let releaseDispose!: () => void;
		const disposing = new Promise<void>((resolve) => {
			releaseDispose = resolve;
		});
		let routedCommands = 0;
		const registry = new RpcSessionRegistry({
			agentDir: dir,
			createRuntime: async (options) => runtime(options),
		});
		const records: Array<Record<string, unknown>> = [];
		const router = new SessionCommandRouter(
			registry,
			new SessionEventWriter(
				(chunk) => records.push(JSON.parse(chunk) as Record<string, unknown>),
				(flush) => flush(),
			),
			{ cwd: dir },
			async () => ({
				handle: async () => {
					routedCommands += 1;
				},
				dispose: () => disposing,
			}),
		);

		const openResponse = await router.handle({
			id: "open",
			type: "open_session",
			cwd: dir,
			sessionPath: join(dir, "race.jsonl"),
		});
		expect(openResponse).toBeUndefined();
		const sessionId = records.find((record) => record.command === "open_session")?.sessionId;
		expect(sessionId).toEqual(expect.any(String));
		if (typeof sessionId !== "string") throw new Error("open_session did not emit a routing handle");

		const closing = router.handle({ id: "close", type: "close_session", sessionId });
		const prompt = await router.handle({ id: "prompt", type: "prompt", message: "must not route", sessionId });
		expect(prompt).toMatchObject({ success: false, error: "session_closing" });
		expect(routedCommands).toBe(0);
		releaseDispose();
		await closing;
	});

	test("rolls back runtime, scope, entry, and path reservation when binding construction fails", async () => {
		const { dir } = await createRegistry();
		let disposed = false;
		const registry = new RpcSessionRegistry({
			agentDir: dir,
			createRuntime: async (options) => {
				const result = runtime(options);
				result.session.dispose = () => {
					disposed = true;
				};
				return result;
			},
		});
		const router = new SessionCommandRouter(registry, new SessionEventWriter(() => {}), { cwd: dir }, async () => {
			throw new Error("binding construction failed");
		});
		const path = join(dir, "binding-failure.jsonl");

		expect(await router.handle({ id: "open", type: "open_session", cwd: dir, sessionPath: path })).toMatchObject({
			success: false,
			error: expect.stringMatching(/^open_failed:/),
		});
		expect(disposed).toBe(true);
		expect(registry.list()).toEqual([]);
		await expect(registry.openSession(profile(dir, path))).resolves.toMatchObject({ sessionId: expect.any(String) });
	});

	test("returns unknown_session for an unknown or terminal handle", async () => {
		const { dir, registry } = await createRegistry();
		await expect(registry.close("does-not-exist")).rejects.toMatchObject({ code: "unknown_session" });
		const router = new SessionCommandRouter(registry, new SessionEventWriter(() => {}), { cwd: dir });
		expect(
			await router.handle({
				id: "missing-surfaces",
				type: "get_loaded_surfaces",
				sessionId: "does-not-exist",
			}),
		).toEqual({
			id: "missing-surfaces",
			type: "response",
			command: "get_loaded_surfaces",
			success: false,
			error: "unknown_session",
		});
		const opened = await registry.openSession(profile(dir, join(dir, "closed.jsonl")));
		await registry.close(opened.sessionId);
		await expect(registry.close(opened.sessionId)).rejects.toMatchObject({ code: "unknown_session" });
	});

	test("attaches to an already-open session by path instead of rejecting session_path_in_use", async () => {
		const { dir, registry } = await createRegistry();
		const path = join(dir, "attach.jsonl");
		const first = await registry.openSession(profile(dir, path));

		const attached = await registry.openSession(profile(dir, path));

		expect(attached.sessionId).toBe(first.sessionId);
		expect(attached.durableSessionId).toBe(first.durableSessionId);
		expect(attached.attached).toBe(true);
		expect(registry.list()).toHaveLength(1);
	});

	test("moves path attachment metadata after runtime replacement", async () => {
		const { dir } = await createRegistry();
		let openedRuntime!: CreateAgentSessionRuntimeResult;
		const registry = new RpcSessionRegistry({
			agentDir: dir,
			createRuntime: async (options) => {
				openedRuntime = runtime(options);
				return openedRuntime;
			},
		});
		const oldPath = join(dir, "replaced-old.jsonl");
		const newPath = join(dir, "replaced-new.jsonl");
		const first = await registry.openSession(profile(dir, oldPath));

		openedRuntime.session.sessionManager.setSessionFile(newPath);
		const second = await registry.openSession(profile(dir, oldPath));

		expect(second.attached).not.toBe(true);
		expect(second.sessionId).not.toBe(first.sessionId);
		expect(
			registry
				.list()
				.map((session) => session.sessionPath)
				.map((path) => path?.endsWith("replaced-old.jsonl")),
		).toContain(true);
		expect(
			registry
				.list()
				.map((session) => session.sessionPath)
				.map((path) => path?.endsWith("replaced-new.jsonl")),
		).toContain(true);

		await expect(registry.openSession(profile(dir, newPath))).resolves.toMatchObject({
			sessionId: first.sessionId,
			attached: true,
		});
	});

	test("routes a multi-session switch through the live runtime with its cwd override", async () => {
		const { dir, registry } = await createRegistry();
		const initialCwd = await mkdtemp(join(tmpdir(), "senpi-rpc-initial-"));
		const replacementCwd = await mkdtemp(join(tmpdir(), "senpi-rpc-replacement-"));
		directories.push(initialCwd, replacementCwd);
		const opened = await registry.openSession(profile(initialCwd, join(dir, "initial.jsonl")));
		const entry = registry.getForCommand(opened.sessionId, "switch_session");
		const initialRuntime = entry.runtime;

		const result = await entry.switchSession!(join(dir, "replacement.jsonl"), {
			cwdOverride: replacementCwd,
		});

		expect(result).toEqual({ cancelled: false });
		expect(entry.runtime).not.toBe(initialRuntime);
		expect(entry.runtime?.session.sessionManager.getCwd()).toBe(replacementCwd);
		expect(registry.list()[0]?.cwd).toBe(replacementCwd);
		await registry.close(opened.sessionId);
	});

	test("keeps the runtime alive until the last attachment closes", async () => {
		const { dir } = await createRegistry();
		let disposed = false;
		const registry = new RpcSessionRegistry({
			agentDir: dir,
			createRuntime: async (options) => {
				const result = runtime(options);
				result.session.dispose = () => {
					disposed = true;
				};
				return result;
			},
		});
		const path = join(dir, "attach-close.jsonl");
		const first = await registry.openSession(profile(dir, path));
		await registry.openSession(profile(dir, path));

		await registry.close(first.sessionId);
		expect(disposed).toBe(false);
		expect(registry.list()).toHaveLength(1);
		expect(registry.getForCommand(first.sessionId, "prompt").state).toBe("open");

		await registry.close(first.sessionId);
		expect(disposed).toBe(true);
		expect(registry.list()).toHaveLength(0);
		await expect(registry.openSession(profile(dir, path))).resolves.toMatchObject({ sessionId: expect.any(String) });
	});

	test("router shutdown drains every shared attachment before disposing the runtime", async () => {
		const { dir } = await createRegistry();
		let disposed = 0;
		const registry = new RpcSessionRegistry({
			agentDir: dir,
			createRuntime: async (options) => {
				const result = runtime(options);
				result.session.dispose = () => {
					disposed += 1;
				};
				return result;
			},
		});
		const router = new SessionCommandRouter(registry, new SessionEventWriter(() => {}), { cwd: dir }, async () => ({
			handle: async () => {},
			dispose: async () => {},
		}));
		const path = join(dir, "shutdown.jsonl");
		await router.handle({ id: "open", type: "open_session", cwd: dir, sessionPath: path });
		await router.handle({ id: "attach", type: "open_session", cwd: dir, sessionPath: path });
		await router.dispose();
		expect(disposed).toBe(1);
		expect(registry.list()).toEqual([]);
	});

	test("constructs each opened runtime inside an isolated provider scope", async () => {
		const { dir } = await createRegistry();
		const api = "rpc-session-scope-test";
		const providersSeenDuringConstruction: Array<unknown> = [];
		const registry = new RpcSessionRegistry({
			agentDir: dir,
			createRuntime: async (options) => {
				if (providersSeenDuringConstruction.length === 0) {
					await Promise.resolve();
					registerApiProvider({
						api,
						stream: () => {
							throw new Error("not invoked");
						},
						streamSimple: () => {
							throw new Error("not invoked");
						},
					});
				}
				providersSeenDuringConstruction.push(getApiProvider(api));
				return runtime(options);
			},
		});

		await registry.openSession(profile(dir, join(dir, "scope-a.jsonl")));
		await registry.openSession(profile(dir, join(dir, "scope-b.jsonl")));

		expect(providersSeenDuringConstruction[0]).toBeDefined();
		expect(providersSeenDuringConstruction[1]).toBeUndefined();
	});

	test("keeps the immutable launch profile across new_session runtime replacement", async () => {
		const dir = await mkdtemp(join(tmpdir(), "senpi-runtime-profile-"));
		directories.push(dir);
		const launchProfile = Object.freeze(profile(dir, join(dir, "profile.jsonl")));
		const manager = SessionManager.create(dir, dir);
		const captured: Array<RpcSessionLaunchProfile | undefined> = [];
		const fakeSession = (sessionManager: SessionManager) =>
			({
				sessionManager,
				extensionRunner: { hasHandlers: () => false },
				abort: async () => {},
				dispose: () => {},
			}) as never;
		const factory: CreateAgentSessionRuntimeFactory = async (options) => {
			captured.push(options.launchProfile as RpcSessionLaunchProfile | undefined);
			return {
				session: fakeSession(options.sessionManager),
				services: { cwd: options.cwd, agentDir: dir },
				diagnostics: [],
			} as unknown as CreateAgentSessionRuntimeResult;
		};
		const initial = await factory({ cwd: dir, agentDir: dir, sessionManager: manager, launchProfile });
		const session = new AgentSessionRuntime(initial.session, initial.services, factory, [], undefined, launchProfile);

		await session.newSession();
		expect(captured).toEqual([launchProfile, launchProfile]);
		expect(session.launchProfile).toBe(launchProfile);
		expect(existsSync(manager.getSessionDir())).toBe(true);
	});
});
