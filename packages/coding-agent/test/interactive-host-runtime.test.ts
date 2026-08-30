import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import {
	type AgentSessionRuntime,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { createGoal, updateGoal } from "../src/core/extensions/builtin/goal/store.ts";
import { FooterDataProvider } from "../src/core/footer-data-provider.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import {
	createInteractiveHostRuntime,
	INTERACTIVE_HOST_FALLBACK_WARNING,
} from "../src/modes/interactive/interactive-host-runtime.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { startFakeModelServer } from "./helpers/rpc-fake-model.ts";
import { hermeticProviderEnv, MOCK_MODEL, MOCK_PROVIDER, writeRpcModelsJson } from "./helpers/rpc-hermetic.ts";

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const runtimes: AgentSessionRuntime[] = [];

beforeAll(() => initTheme("dark"));

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
	await Promise.all(children.splice(0).map(stopChild));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(label: string) {
	const root = mkdtempSync(join(tmpdir(), `senpi-interactive-host-${label}-`));
	roots.push(root);
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	const cwd = join(root, "work");
	const socket = join(root, "rpc.sock");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	return { root, agentDir, sessionDir, cwd, socket };
}

function spawnHost(
	qa: ReturnType<typeof scratch>,
	model: { provider: string; id: string } = { provider: MOCK_PROVIDER, id: MOCK_MODEL },
): ChildProcessWithoutNullStreams {
	const child = spawn(
		process.execPath,
		[
			join(import.meta.dirname, "..", "src", "cli.ts"),
			"--mode",
			"rpc",
			"--multi-session",
			"--listen",
			`unix://${qa.socket}`,
			"--provider",
			model.provider,
			"--model",
			model.id,
		],
		{
			cwd: qa.cwd,
			env: {
				...Object.fromEntries(
					Object.entries(process.env).filter(
						([key]) =>
							key !== "SENPI_BRAND" &&
							!key.endsWith("_CODING_AGENT_DIR") &&
							!key.endsWith("_CODING_AGENT_SESSION_DIR"),
					),
				),
				...hermeticProviderEnv(),
				PI_OFFLINE: "1",
				PI_TELEMETRY: "0",
				// The rules extension appends an async `pi-rules.scan` entry on the
				// host after session start, racing entry-parity assertions between
				// the host and the local mirror. No test here exercises rules.
				PI_RULES_DISABLED: "1",
				SENPI_RUNTIME: "node",
				SENPI_CODING_AGENT_DIR: qa.agentDir,
				SENPI_CODING_AGENT_SESSION_DIR: qa.sessionDir,
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	children.push(child);
	return child;
}

async function createAgentSessionRuntimeFixture(options: {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
}): Promise<AgentSessionRuntime> {
	const createRuntime = async ({ cwd, sessionManager }: { cwd: string; sessionManager: SessionManager }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: options.agentDir,
			settingsManager: options.settingsManager,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		return {
			...(await createAgentSessionFromServices({ services, sessionManager })),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: options.cwd,
		agentDir: options.agentDir,
		sessionManager: options.sessionManager,
	});
	runtimes.push(runtime);
	return runtime;
}

async function waitForHost(child: ChildProcessWithoutNullStreams, socket: string): Promise<void> {
	let stderr = "";
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`host readiness timed out: ${stderr}`)), 15_000);
		const onData = (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
			if (!stderr.includes(`senpi rpc listening on unix://${socket}`)) return;
			clearTimeout(timer);
			child.stderr.off("data", onData);
			resolve();
		};
		child.stderr.on("data", onData);
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			reject(new Error(`host exited ${code ?? signal}: ${stderr}`));
		});
	});
}

describe("interactive host runtime", () => {
	it("renders host-authoritative footer context, cwd, and session name", async () => {
		const qa = scratch("footer-values");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const local = await createAgentSessionRuntimeFixture({
			cwd: qa.cwd,
			agentDir: qa.agentDir,
			sessionManager: SessionManager.create(qa.cwd, qa.sessionDir),
			settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
		});
		local.session.getContextUsage = () => ({ tokens: 42, contextWindow: 4242, percent: 1 });
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => undefined,
			onWarning: vi.fn(),
		});
		try {
			await runtime.session.setSessionName("host-footer-name");
			await runtime.session.prompt("footer context");
			const footer = new FooterComponent(runtime.session, new FooterDataProvider(qa.cwd));
			const rendered = stripAnsi(footer.render(240).join("\n"));
			expect(runtime.session.sessionManager.getCwd()).toBe(qa.cwd);
			expect(runtime.session.sessionManager.getSessionName()).toBe("host-footer-name");
			expect(runtime.session.getContextUsage()).toEqual(expect.objectContaining({ contextWindow: 1000000 }));
			expect(rendered).toContain(`${qa.cwd} • host-footer-name`);
			expect(rendered).toMatch(/\d+\/1M \([0-9.]+%\)/);
		} finally {
			await runtime.dispose();
			await fake.close();
		}
	});

	it("does not issue getState per streamed delta while mirroring usage totals", async () => {
		const qa = scratch("usage-deltas");
		const fake = await startFakeModelServer({ multiDelta: true });
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const local = await createAgentSessionRuntimeFixture({
			cwd: qa.cwd,
			agentDir: qa.agentDir,
			sessionManager: SessionManager.create(qa.cwd, qa.sessionDir),
			settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
		});
		const getState = vi.spyOn(RpcClient.prototype, "getState");
		let messageUpdates = 0;
		let assistantUpdatesWithUsage = 0;
		let assistantMessageEnds = 0;
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => undefined,
			onWarning: vi.fn(),
		});
		try {
			const settled = new Promise<void>((resolve) => {
				const unsubscribe = runtime.session.subscribe((event) => {
					if (event.type === "message_end" && event.message.role === "assistant") assistantMessageEnds++;
					if (event.type === "message_update") {
						messageUpdates++;
						if (event.message.role === "assistant" && event.message.usage) assistantUpdatesWithUsage++;
					}
					if (event.type !== "agent_settled") return;
					unsubscribe();
					resolve();
				});
			});
			await runtime.session.prompt("multi-delta-usage");
			await settled;
			expect(getState).toHaveBeenCalledTimes(0);
			expect(messageUpdates).toBeGreaterThan(1);
			expect(assistantUpdatesWithUsage).toBeGreaterThan(1);
			expect(messageUpdates).toBeGreaterThan(1);
			expect(assistantUpdatesWithUsage).toBeGreaterThan(1);
			expect(assistantMessageEnds).toBe(1);
			expect(runtime.session.sessionManager.getUsageTotals()).toEqual({
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0.00003,
				latestCacheHitRate: 0,
			});
		} finally {
			await runtime.dispose();
			await fake.close();
		}
	});

	it("is live to parallel clients, prompts remotely, and remains durably resumable", async () => {
		const qa = scratch("remote");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const localSessionManager = SessionManager.create(qa.cwd, qa.sessionDir);
		const sessionPath = localSessionManager.getSessionFile();
		if (!sessionPath) throw new Error("Expected persisted session path");
		const local = await createAgentSessionRuntimeFixture({
			cwd: qa.cwd,
			agentDir: qa.agentDir,
			sessionManager: localSessionManager,
			settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
		});
		const onWarning = vi.fn();
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => undefined,
			onWarning,
		});
		expect(onWarning).not.toHaveBeenCalled();
		const observer = new RpcClient({ socketPath: qa.socket });
		await observer.start();
		try {
			const listed = await observer.listSessions();
			const live = listed.find((entry) => entry.status === "open");
			expect(live).toBeDefined();
			const durableId = live?.durableSessionId;
			expect(durableId).toBeTruthy();

			const settled = new Promise<void>((resolve) => {
				const unsubscribe = runtime.session.subscribe((event) => {
					if (event.type !== "agent_settled") return;
					unsubscribe();
					resolve();
				});
			});
			await runtime.session.prompt("interactive-host-unique");
			await settled;
			expect(await runtime.session.getLastAssistantText()).toBeTruthy();

			await runtime.dispose();
			const afterClose = await observer.listSessions();
			expect(afterClose.find((entry) => entry.sessionPath === sessionPath)).toBeUndefined();
			const resumed = await observer.openSession({ sessionPath, cwd: qa.cwd });
			expect(resumed.state.sessionId).toBe(durableId);
			await observer.closeSession(resumed.sessionId);
		} finally {
			await observer.stop();
			await fake.close();
		}
	});

	it("delivers prompt disposition and preflight callbacks before the canonical user message_start", async () => {
		const qa = scratch("disposition");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const local = await createAgentSessionRuntimeFixture({
			cwd: qa.cwd,
			agentDir: qa.agentDir,
			sessionManager: SessionManager.create(qa.cwd, qa.sessionDir),
			settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
		});
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => undefined,
			onWarning: vi.fn(),
		});
		try {
			const order: string[] = [];
			const promptDisposition = vi.fn((disposition: string) => {
				order.push(`disposition:${disposition}`);
			});
			const preflightResult = vi.fn((success: boolean) => {
				order.push(`preflight:${success}`);
			});
			const settled = new Promise<void>((resolve) => {
				const unsubscribe = runtime.session.subscribe((event) => {
					if (event.type === "message_start" && event.message.role === "user") order.push("event:message_start");
					if (event.type !== "agent_settled") return;
					unsubscribe();
					resolve();
				});
			});
			await runtime.session.prompt("disposition-probe", {
				promptDisposition,
				preflightResult,
			});
			await settled;
			expect(promptDisposition).toHaveBeenCalledWith("started");
			expect(preflightResult).toHaveBeenCalledWith(true);
			expect(order).toEqual(["disposition:started", "preflight:true", "event:message_start"]);
		} finally {
			await runtime.dispose();
			await fake.close();
		}
	});

	it("forwards streamingBehavior so a mid-stream prompt queues instead of failing", async () => {
		const qa = scratch("queued");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const local = await createAgentSessionRuntimeFixture({
			cwd: qa.cwd,
			agentDir: qa.agentDir,
			sessionManager: SessionManager.create(qa.cwd, qa.sessionDir),
			settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
		});
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => undefined,
			onWarning: vi.fn(),
		});
		try {
			const firstSettled = new Promise<void>((resolve) => {
				const unsubscribe = runtime.session.subscribe((event) => {
					if (event.type !== "agent_settled") return;
					unsubscribe();
					resolve();
				});
			});
			void runtime.session.prompt("hold-open-1500 first-turn");
			const streamingDeadline = Date.now() + 10_000;
			while (!runtime.session.isStreaming) {
				if (Date.now() > streamingDeadline) throw new Error("session never entered streaming state");
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			const queuedDisposition = vi.fn();
			const queuedPreflight = vi.fn();
			await runtime.session.prompt("queued second turn", {
				streamingBehavior: "followUp",
				promptDisposition: queuedDisposition,
				preflightResult: queuedPreflight,
			});
			await firstSettled;
			expect(queuedDisposition).toHaveBeenCalledWith("queued");
			expect(queuedPreflight).toHaveBeenCalledWith(true);
		} finally {
			await runtime.dispose();
			await fake.close();
		}
	});

	it("reflects host service-tier changes in the attached session and footer state", async () => {
		const qa = scratch("tier-sync");
		const fake = await startFakeModelServer();
		const model = { provider: "openai-codex", id: "gpt-5.6-sol" };
		writeFileSync(
			join(qa.agentDir, "models.json"),
			JSON.stringify({
				providers: {
					[model.provider]: {
						baseUrl: fake.origin,
						apiKey: "test-key",
						api: "openai-codex-responses",
						models: [{ id: model.id, reasoning: true, contextWindow: 128000, maxTokens: 4096 }],
					},
				},
			}),
		);
		const host = spawnHost(qa, model);
		await waitForHost(host, qa.socket);
		const localSessionManager = SessionManager.create(qa.cwd, qa.sessionDir);
		const sessionPath = localSessionManager.getSessionFile();
		if (!sessionPath) throw new Error("Expected persisted session path");
		const local = await createAgentSessionRuntimeFixture({
			cwd: qa.cwd,
			agentDir: qa.agentDir,
			sessionManager: localSessionManager,
			settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
		});
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => undefined,
			onWarning: vi.fn(),
		});
		const observer = new RpcClient({ socketPath: qa.socket });
		await observer.start();
		try {
			await observer.openSession({ sessionPath, cwd: qa.cwd });
			expect(runtime.session.isFastModeActive()).toBe(false);
			expect(runtime.session.serviceTier).toBeUndefined();

			await observer.setFastMode(true);

			expect(runtime.session.isFastModeActive()).toBe(true);
			expect(runtime.session.serviceTier).toBe("priority");
		} finally {
			await observer.stop();
			await runtime.dispose();
			await fake.close();
		}
	});

	it("mirrors host session settings in direct proxy getters", async () => {
		const qa = scratch("settings-sync");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const runtime = await createInteractiveHostRuntime(
			await createAgentSessionRuntimeFixture({
				cwd: qa.cwd,
				agentDir: qa.agentDir,
				sessionManager: SessionManager.create(qa.cwd, qa.sessionDir),
				settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
			}),
			{ socket: qa.socket, ensureHost: async () => undefined },
		);
		const observer = new RpcClient({ socketPath: qa.socket });
		await observer.start();
		try {
			await observer.openSession({ sessionPath: runtime.session.sessionFile!, cwd: qa.cwd });
			let settingsEvents = 0;
			const settingsChanged = new Promise<void>((resolve) => {
				const unsubscribe = runtime.session.subscribe((event) => {
					if (event.type !== "session_settings_changed") return;
					settingsEvents++;
					if (settingsEvents >= 3) {
						unsubscribe();
						resolve();
					}
				});
			});
			await observer.setSteeringMode("one-at-a-time");
			await observer.setFollowUpMode("one-at-a-time");
			await observer.setAutoCompaction(false);
			await settingsChanged;
			expect(runtime.session.steeringMode).toBe("one-at-a-time");
			expect(runtime.session.followUpMode).toBe("one-at-a-time");
			expect(runtime.session.autoCompactionEnabled).toBe(false);
		} finally {
			await observer.stop();
			await runtime.dispose();
			await fake.close();
		}
	});

	it("routes session-scoped mutations to the host", async () => {
		const qa = scratch("scoped");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const warnings: unknown[] = [];
		const runtime = await createInteractiveHostRuntime(
			await createAgentSessionRuntimeFixture({
				cwd: qa.cwd,
				agentDir: qa.agentDir,
				sessionManager: SessionManager.create(qa.cwd, qa.sessionDir),
				settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
			}),
			{ socket: qa.socket, ensureHost: async () => undefined, onWarning: (warning) => warnings.push(warning) },
		);
		try {
			const settled = new Promise<void>((resolve) => {
				const unsubscribe = runtime.session.subscribe((event) => {
					if (event.type !== "thinking_level_changed") return;
					unsubscribe();
					resolve();
				});
			});
			runtime.session.setSessionThinkingLevel("low");
			await settled;
			expect(runtime.session.thinkingLevel).toBe("low");
			expect(warnings).toEqual([]);
		} finally {
			await runtime.dispose();
			await fake.close();
		}
	});

	it("hydrates the session manager when attaching after another client advances the host", async () => {
		const qa = scratch("attach-hydration");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const localSessionManager = SessionManager.create(qa.cwd, qa.sessionDir);
		const sessionPath = localSessionManager.getSessionFile();
		if (!sessionPath) throw new Error("Expected persisted session path");
		const observer = new RpcClient({ socketPath: qa.socket });
		await observer.start();
		await observer.openSession({ sessionPath, cwd: qa.cwd });
		const settled = new Promise<void>((resolve) => {
			const unsubscribe = observer.onEvent((event) => {
				if (event.type !== "agent_settled") return;
				unsubscribe();
				resolve();
			});
		});
		await observer.prompt("already-advanced-before-attach");
		await settled;
		const local = await createAgentSessionRuntimeFixture({
			cwd: qa.cwd,
			agentDir: qa.agentDir,
			sessionManager: localSessionManager,
			settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
		});
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => undefined,
		});
		try {
			expect(JSON.stringify(runtime.session.messages)).toContain("already-advanced-before-attach");
			expect(runtime.session.sessionManager.getEntries()).toEqual(
				expect.arrayContaining([expect.objectContaining({ type: "message" })]),
			);
		} finally {
			await runtime.dispose();
			await observer.stop();
			await fake.close();
		}
	});

	it("reserves queued input order after the host queue", async () => {
		const qa = scratch("queue-order");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const local = await createAgentSessionRuntimeFixture({
			cwd: qa.cwd,
			agentDir: qa.agentDir,
			sessionManager: SessionManager.create(qa.cwd, qa.sessionDir),
			settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
		});
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => undefined,
		});
		try {
			const started = new Promise<void>((resolve) => {
				const unsubscribe = runtime.session.subscribe((event) => {
					if (event.type !== "agent_start") return;
					unsubscribe();
					resolve();
				});
			});
			void runtime.session.prompt("hold-open-500 queue-order");
			await started;
			await runtime.session.steer("queued-one");
			await runtime.session.steer("queued-two");
			const reserved = runtime.session.reserveQueuedInputOrder();
			expect(reserved).toBeGreaterThan(2);
		} finally {
			await runtime.session.abort();
			await runtime.dispose();
			await fake.close();
		}
	});

	it("aborts client-local bash when the runtime is disposed", async () => {
		const qa = scratch("dispose-bash");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const local = await createAgentSessionRuntimeFixture({
			cwd: qa.cwd,
			agentDir: qa.agentDir,
			sessionManager: SessionManager.create(qa.cwd, qa.sessionDir),
			settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
		});
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => undefined,
		});
		let started = false;
		let aborted = false;
		const operation = new Promise<{ exitCode: number | null }>((resolve) => {
			void runtime.session.executeBash("local-bash", undefined, {
				operations: {
					exec: async (_command: string, _cwd: string, options: { signal?: AbortSignal }) => {
						started = true;
						if (options.signal?.aborted) aborted = true;
						else
							options.signal?.addEventListener(
								"abort",
								() => {
									aborted = true;
									resolve({ exitCode: null });
								},
								{ once: true },
							);
						return await new Promise<{ exitCode: number | null }>(() => {});
					},
				},
			});
		});
		try {
			while (!started) await new Promise((resolve) => setImmediate(resolve));
			await runtime.dispose();
			expect(aborted).toBe(true);
		} finally {
			void operation;
			await fake.close();
		}
	});

	it("reports host work through isIdle while streaming", async () => {
		const qa = scratch("idle-sync");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const runtime = await createInteractiveHostRuntime(
			await createAgentSessionRuntimeFixture({
				cwd: qa.cwd,
				agentDir: qa.agentDir,
				sessionManager: SessionManager.create(qa.cwd, qa.sessionDir),
				settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
			}),
			{ socket: qa.socket, ensureHost: async () => undefined },
		);
		try {
			const started = new Promise<void>((resolve) => {
				const unsubscribe = runtime.session.subscribe((event) => {
					if (event.type !== "agent_start") return;
					unsubscribe();
					resolve();
				});
			});
			const settled = new Promise<void>((resolve) => {
				const unsubscribe = runtime.session.subscribe((event) => {
					if (event.type !== "agent_settled") return;
					unsubscribe();
					resolve();
				});
			});
			void runtime.session.prompt("hold-open-500 idle-probe");
			await started;
			expect(runtime.session.isStreaming).toBe(true);
			expect(runtime.session.isIdle).toBe(false);
			await settled;
			expect(runtime.session.isIdle).toBe(true);
		} finally {
			await runtime.dispose();
			await fake.close();
		}
	});

	it("refreshes the session manager after host entries are appended", async () => {
		const qa = scratch("entry-sync");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const localManager = SessionManager.create(qa.cwd, qa.sessionDir);
		const runtime = await createInteractiveHostRuntime(
			await createAgentSessionRuntimeFixture({
				cwd: qa.cwd,
				agentDir: qa.agentDir,
				sessionManager: localManager,
				settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
			}),
			{ socket: qa.socket, ensureHost: async () => undefined },
		);
		try {
			const settled = new Promise<void>((resolve) => {
				const unsubscribe = runtime.session.subscribe((event) => {
					if (event.type !== "agent_settled") return;
					unsubscribe();
					resolve();
				});
			});
			await runtime.session.prompt("entry-sync-probe");
			await settled;
			const entries = runtime.session.sessionManager.getEntries();
			expect(entries).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "message",
						message: expect.objectContaining({
							role: "user",
							content: [{ type: "text", text: "entry-sync-probe" }],
						}),
					}),
				]),
			);
		} finally {
			await runtime.dispose();
			await fake.close();
		}
	});

	it("reflects remote thinking-level cycles in session.state for footer rendering", async () => {
		const qa = scratch("state-sync");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const local = await createAgentSessionRuntimeFixture({
			cwd: qa.cwd,
			agentDir: qa.agentDir,
			sessionManager: SessionManager.create(qa.cwd, qa.sessionDir),
			settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
		});
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => undefined,
			onWarning: vi.fn(),
		});
		try {
			const newLevel = await runtime.session.cycleThinkingLevel();
			expect(newLevel).toBeTruthy();
			// The footer reads session.state.thinkingLevel; the proxy must surface the
			// host's level there too, not only through the direct thinkingLevel getter.
			expect(runtime.session.thinkingLevel).toBe(newLevel);
			expect(runtime.session.state.thinkingLevel).toBe(newLevel);
		} finally {
			await runtime.dispose();
			await fake.close();
		}
	});

	it("synchronizes sessionManager and messages when compaction completes on the host", async () => {
		const qa = scratch("compaction-sync");
		mkdirSync(join(qa.agentDir), { recursive: true });
		writeFileSync(join(qa.agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 10 } }));
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const localSessionManager = SessionManager.create(qa.cwd, qa.sessionDir);
		const local = await createAgentSessionRuntimeFixture({
			cwd: qa.cwd,
			agentDir: qa.agentDir,
			sessionManager: localSessionManager,
			settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
		});
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => undefined,
			onWarning: vi.fn(),
		});
		try {
			for (const text of ["hello turn one", "hello turn two", "hello turn three", "hello turn four"]) {
				const turnSettled = new Promise<void>((resolve) => {
					const unsubscribe = runtime.session.subscribe((event) => {
						if (event.type === "agent_settled") {
							unsubscribe();
							resolve();
						}
					});
				});
				await runtime.session.prompt(text);
				await turnSettled;
				await new Promise((r) => setTimeout(r, 50));
			}

			const compactionEnded = new Promise<void>((resolve) => {
				const unsubscribe = runtime.session.subscribe((event) => {
					if (event.type !== "compaction_end") return;
					unsubscribe();
					resolve();
				});
			});
			await runtime.session.compact();
			await compactionEnded;

			const entries = localSessionManager.buildContextEntries();
			expect(entries[0]?.type).toBe("compaction");
		} finally {
			await runtime.dispose();
			await fake.close();
		}
	});

	it("falls back locally with a typed warning when the host remains unreachable", async () => {
		const qa = scratch("fallback");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const local = await createAgentSessionRuntimeFixture({
			cwd: qa.cwd,
			agentDir: qa.agentDir,
			sessionManager: SessionManager.create(qa.cwd, qa.sessionDir),
			settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
		});
		const warnings: string[] = [];
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => {
				throw new Error("host intentionally unavailable");
			},
			onWarning: (warning) => warnings.push(warning.message),
		});
		try {
			expect(runtime).toBe(local);
			expect(warnings).toEqual([`${INTERACTIVE_HOST_FALLBACK_WARNING}: host intentionally unavailable`]);
			await runtime.session.prompt("local-fallback-unique");
			await runtime.session.waitForIdle();
			expect(runtime.session.getLastAssistantText()).toBeTruthy();
		} finally {
			await runtime.dispose();
			await fake.close();
		}
	});

	it("resumes stopped-goal history through the shared host and refreshes the local proxy", async () => {
		const qa = scratch("switch-session");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const localSessionManager = SessionManager.create(qa.cwd, qa.sessionDir);
		const local = await createAgentSessionRuntimeFixture({
			cwd: qa.cwd,
			agentDir: qa.agentDir,
			sessionManager: localSessionManager,
			settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
		});
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => undefined,
		});
		const targetManager = SessionManager.create(qa.cwd, qa.sessionDir);
		const targetPath = targetManager.getSessionFile();
		if (!targetPath) throw new Error("Expected persisted target session path");
		targetManager.appendMessage({
			role: "user",
			content: "target-history",
			timestamp: 1,
		});
		targetManager.appendMessage(fauxAssistantMessage("target-response"));
		const goalRef = {
			baseDir: join(targetManager.getSessionDir(), "extensions", "goal"),
			threadId: targetManager.getSessionId(),
		};
		await createGoal(goalRef, "Keep the target goal stopped");
		await updateGoal(goalRef, {
			status: "blocked",
			reason: "user interrupted the turn",
		});
		expect(targetManager.buildSessionContext().messages).toContainEqual({
			role: "user",
			content: "target-history",
			timestamp: 1,
		});
		const initialSessionId = runtime.session.sessionId;

		try {
			const trustFactory = vi.fn<(cwd: string) => void>();
			let callbackSessionFile: string | undefined;
			await runtime.switchSession(targetPath, {
				projectTrustContextFactory: (cwd) => {
					trustFactory(cwd);
					return {} as never;
				},
				withSession: async (ctx) => {
					callbackSessionFile = ctx.sessionManager.getSessionFile();
				},
			});

			expect(trustFactory).toHaveBeenCalledWith(qa.cwd);
			expect(callbackSessionFile).toBe(targetPath);
			expect(runtime.session.sessionFile).toBe(targetPath);
			expect(runtime.session.sessionId).not.toBe(initialSessionId);
			expect(runtime.session.sessionManager.getSessionFile()).toBe(targetPath);
			expect(runtime.session.sessionManager.buildSessionContext().messages).toContainEqual({
				role: "user",
				content: "target-history",
				timestamp: 1,
			});
			expect(runtime.session.messages).toContainEqual({
				role: "user",
				content: "target-history",
				timestamp: 1,
			});
		} finally {
			await runtime.dispose();
			await fake.close();
		}
	});

	// `/tree` and the double-Escape tree action both funnel into showTreeSelector(), whose only data
	// source is session.sessionManager.getTree()/getLeafId(). When the shared-host proxy kept serving the
	// stale bootstrap manager after a switch, that read returned the old (here: empty) tree and the
	// selector bailed out with "No entries in session", which is what users saw as "/tree stopped working".
	it("exposes the target session tree through the shared-host proxy after a switch", async () => {
		const qa = scratch("tree");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const localSessionManager = SessionManager.create(qa.cwd, qa.sessionDir);
		const local = await createAgentSessionRuntimeFixture({
			cwd: qa.cwd,
			agentDir: qa.agentDir,
			sessionManager: localSessionManager,
			settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
		});
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => undefined,
		});
		const targetManager = SessionManager.create(qa.cwd, qa.sessionDir);
		const targetPath = targetManager.getSessionFile();
		if (!targetPath) throw new Error("Expected persisted target session path");
		targetManager.appendMessage({
			role: "user",
			content: "tree-entry-from-target",
			timestamp: 1,
		});
		targetManager.appendMessage(fauxAssistantMessage("tree-response-from-target"));

		// The bootstrap session's tree never contains the target session's entries, so a proxy that keeps
		// serving the stale bootstrap manager is distinguishable from one that adopted the target manager.
		expect(JSON.stringify(localSessionManager.getTree())).not.toContain("tree-entry-from-target");

		try {
			await runtime.switchSession(targetPath);

			const tree = runtime.session.sessionManager.getTree();
			const contents = JSON.stringify(tree);
			expect(tree.length).toBeGreaterThan(0);
			expect(contents).toContain("tree-entry-from-target");
			expect(runtime.session.sessionManager.getLeafId()).not.toBeNull();
		} finally {
			await runtime.dispose();
			await fake.close();
		}
	});
	it("transports setup mutations to the authoritative host before rebind", async () => {
		const qa = scratch("setup-host");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const local = await createAgentSessionRuntimeFixture({
			cwd: qa.cwd,
			agentDir: qa.agentDir,
			sessionManager: SessionManager.create(qa.cwd, qa.sessionDir),
			settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
		});
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => undefined,
		});
		const observer = new RpcClient({ socketPath: qa.socket });
		await observer.start();
		try {
			await runtime.newSession({
				setup: async (manager) => {
					manager.appendCustomEntry("setup-state", { marker: true });
					manager.appendSessionInfo("setup session");
				},
				withSession: async (ctx) => {
					expect(ctx.sessionManager.getEntries()).toEqual(
						expect.arrayContaining([
							expect.objectContaining({ type: "custom", customType: "setup-state" }),
							expect.objectContaining({ type: "session_info", name: "setup session" }),
						]),
					);
				},
			});
			const listed = await observer.listSessions();
			const hostSession = listed.find((entry) => entry.status === "open");
			if (!hostSession?.sessionPath) throw new Error("Expected host session path");
			await observer.openSession({ sessionPath: hostSession.sessionPath, cwd: qa.cwd });
			const entries = await observer.getEntries();
			const state = await observer.getState();
			expect(state.sessionName).toBe("setup session");
			expect(runtime.session.sessionManager.getEntries()).toEqual(entries.entries);
			expect(runtime.session.sessionManager.getSessionName()).toBe("setup session");
			expect(entries.entries).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ type: "custom", customType: "setup-state", data: { marker: true } }),
					expect.objectContaining({ type: "session_info", name: "setup session" }),
				]),
			);
		} finally {
			await observer.stop();
			await runtime.dispose();
			await fake.close();
		}
	});
	it("mirrors unnamed custom-only deferred setup entries", async () => {
		const qa = scratch("setup-unnm");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const local = await createAgentSessionRuntimeFixture({
			cwd: qa.cwd,
			agentDir: qa.agentDir,
			sessionManager: SessionManager.create(qa.cwd, qa.sessionDir),
			settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
		});
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => undefined,
		});
		try {
			await runtime.newSession({
				setup: async (manager) => {
					manager.appendCustomEntry("setup-state", { marker: true });
				},
			});
			expect(runtime.session.sessionManager.getEntries()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ type: "custom", customType: "setup-state", data: { marker: true } }),
				]),
			);
		} finally {
			await runtime.dispose();
			await fake.close();
		}
	});

	it("preserves expandPromptTemplates for string replacement messages", async () => {
		const qa = scratch("opts");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const local = await createAgentSessionRuntimeFixture({
			cwd: qa.cwd,
			agentDir: qa.agentDir,
			sessionManager: SessionManager.create(qa.cwd, qa.sessionDir),
			settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
		});
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => undefined,
		});
		try {
			await runtime.newSession({
				withSession: async (ctx) => {
					await ctx.sendUserMessage("/help", { expandPromptTemplates: false });
				},
			});
			await runtime.session.waitForIdle();
			expect(fake.requests.length).toBe(1);
			expect(fake.requests[0]?.text).toContain("/help");
		} finally {
			await runtime.dispose();
			await fake.close();
		}
	});

	it("refreshes the proxy after new and fork replacements", async () => {
		const qa = scratch("replace");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const bootstrap = SessionManager.create(qa.cwd, qa.sessionDir);
		bootstrap.appendMessage({
			role: "user",
			content: "fork-source",
			timestamp: 1,
		});
		bootstrap.appendMessage(fauxAssistantMessage("fork-answer"));
		const local = await createAgentSessionRuntimeFixture({
			cwd: qa.cwd,
			agentDir: qa.agentDir,
			sessionManager: bootstrap,
			settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
		});
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => undefined,
		});
		try {
			const entryId = bootstrap.getEntries().find((entry) => entry.type === "message")?.id;
			expect(entryId).toBeTruthy();
			const beforeFork = runtime.session.sessionId;
			await runtime.fork(entryId!);
			expect(runtime.session.sessionId).not.toBe(beforeFork);
			expect(runtime.session.sessionManager.getSessionFile()).toBe(runtime.session.sessionFile);
			const firstFile = runtime.session.sessionFile;
			const firstId = runtime.session.sessionId;
			let callbackSessionFile: string | undefined;
			await runtime.newSession({
				withSession: async (ctx) => {
					callbackSessionFile = ctx.sessionManager.getSessionFile();
				},
			});
			expect(callbackSessionFile).toBe(runtime.session.sessionFile);
			expect(runtime.session.sessionFile).not.toBe(firstFile);
			expect(runtime.session.sessionId).not.toBe(firstId);
			expect(runtime.session.sessionManager.getSessionFile()).toBe(runtime.session.sessionFile);
		} finally {
			await runtime.dispose();
			await fake.close();
		}
	});

	it("routes tree navigation to the host and refreshes proxy history", async () => {
		const qa = scratch("nav");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const manager = SessionManager.create(qa.cwd, qa.sessionDir);
		manager.appendMessage({ role: "user", content: "nav-user", timestamp: 1 });
		const userId = manager.getLeafId()!;
		manager.appendMessage(fauxAssistantMessage("nav-assistant"));
		const local = await createAgentSessionRuntimeFixture({
			cwd: qa.cwd,
			agentDir: qa.agentDir,
			sessionManager: manager,
			settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
		});
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => undefined,
		});
		try {
			const result = await runtime.session.navigateTree(userId, { summarize: false });
			expect(result.cancelled).toBe(false);
			expect(result.editorText).toBe("nav-user");
			expect(runtime.session.messages).toContainEqual({
				role: "user",
				content: "nav-user",
				timestamp: 1,
			});
			// SessionManager.branch() moves the leaf pointer in memory only, so the
			// host's applied navigation is proven by where the NEXT host append
			// parents: navigating to the root user message moved the leaf to null,
			// so the session_info below must land as a root entry. The previous
			// persisted-leaf assertion only ever held when the rules extension's
			// async `pi-rules.scan` append raced in ahead of it.
			await runtime.session.setSessionName("post-nav");
			const sessionFile = runtime.session.sessionFile!;
			await vi.waitFor(() => {
				const persisted = SessionManager.open(sessionFile);
				const info = persisted
					.getEntries()
					.find((entry) => entry.type === "session_info" && entry.name === "post-nav");
				expect(info).toBeDefined();
				expect(info?.parentId).toBeNull();
			});
		} finally {
			await runtime.dispose();
			await fake.close();
		}
	});

	it("imports JSONL through the host and exposes imported history", async () => {
		const qa = scratch("import");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const imported = SessionManager.create(qa.cwd, qa.sessionDir);
		imported.appendMessage({
			role: "user",
			content: "imported-history",
			timestamp: 1,
		});
		imported.appendMessage(fauxAssistantMessage("imported-answer"));
		const inputPath = join(qa.root, "import.jsonl");
		copyFileSync(imported.getSessionFile()!, inputPath);
		const local = await createAgentSessionRuntimeFixture({
			cwd: qa.cwd,
			agentDir: qa.agentDir,
			sessionManager: SessionManager.create(qa.cwd, qa.sessionDir),
			settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
		});
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => undefined,
		});
		try {
			await runtime.importFromJsonl(inputPath);
			expect(runtime.session.sessionFile).toContain("import.jsonl");
			expect(runtime.session.messages).toContainEqual({
				role: "user",
				content: "imported-history",
				timestamp: 1,
			});
			expect(runtime.session.sessionManager.buildSessionContext().messages).toContainEqual({
				role: "user",
				content: "imported-history",
				timestamp: 1,
			});
		} finally {
			await runtime.dispose();
			await fake.close();
		}
	});

	it("executes client-local bash operations and records the result on the host", async () => {
		const qa = scratch("local-ops");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const manager = SessionManager.create(qa.cwd, qa.sessionDir);
		const local = await createAgentSessionRuntimeFixture({
			cwd: qa.cwd,
			agentDir: qa.agentDir,
			sessionManager: manager,
			settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
		});
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => undefined,
		});
		try {
			const chunks: string[] = [];
			const result = await runtime.session.executeBash("sentinel", (chunk) => chunks.push(chunk), {
				operations: {
					exec: async (_command, _cwd, { onData }) => {
						onData(Buffer.from("client-sentinel"));
						return { exitCode: 0 };
					},
				},
			});
			expect(result.output).toBe("client-sentinel");
			expect(chunks).toEqual(["client-sentinel"]);
			const observer = new RpcClient({ socketPath: qa.socket });
			await observer.start();
			try {
				await observer.openSession({ sessionPath: runtime.session.sessionFile!, cwd: qa.cwd });
				expect(JSON.stringify((await observer.getEntries()).entries)).toContain("client-sentinel");
			} finally {
				await observer.stop();
			}
		} finally {
			await runtime.dispose();
			await fake.close();
		}
	});

	it.each([
		["host async callback failed", "host async callback failed"],
		[{ host: "callback", failure: true }, "host callback object failed"],
		[new Error("host callback error"), "host callback error"],
	])("propagates shared-host async bash callback failures (%s)", async (callbackError, _label) => {
		const qa = scratch("rbc");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const runtime = await createInteractiveHostRuntime(
			await createAgentSessionRuntimeFixture({
				cwd: qa.cwd,
				agentDir: qa.agentDir,
				sessionManager: SessionManager.create(qa.cwd, qa.sessionDir),
				settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
			}),
			{ socket: qa.socket, ensureHost: async () => undefined },
		);
		let unhandledRejection: unknown;
		const onUnhandledRejection = (reason: unknown) => {
			unhandledRejection = reason;
		};
		process.once("unhandledRejection", onUnhandledRejection);
		try {
			await expect(
				runtime.session.executeBash(`head -c 100001 /dev/zero | tr '\\0' x`, async () => {
					throw callbackError;
				}),
			).rejects.toBe(callbackError);
			expect(unhandledRejection).toBeUndefined();
		} finally {
			process.removeListener("unhandledRejection", onUnhandledRejection);
			await runtime.dispose();
			await fake.close();
		}
	});

	it("preserves mixed queue chronology through the proxy clear", async () => {
		const qa = scratch("queue-order");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const manager = SessionManager.create(qa.cwd, qa.sessionDir);
		const local = await createAgentSessionRuntimeFixture({
			cwd: qa.cwd,
			agentDir: qa.agentDir,
			sessionManager: manager,
			settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
		});
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => undefined,
		});
		try {
			await runtime.session.steer("A");
			await runtime.session.followUp("B");
			await runtime.session.steer("C");
			const cleared = runtime.session.clearQueue({ abortWillFollow: false });
			expect(cleared.ordered.map((item) => item.text)).toEqual(["A", "B", "C"]);
		} finally {
			await runtime.dispose();
			await fake.close();
		}
	});

	it("does not resurrect a consumed queue item during proxy recovery", async () => {
		const qa = scratch("queue-consume");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const runtime = await createInteractiveHostRuntime(
			await createAgentSessionRuntimeFixture({
				cwd: qa.cwd,
				agentDir: qa.agentDir,
				sessionManager: SessionManager.create(qa.cwd, qa.sessionDir),
				settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
			}),
			{ socket: qa.socket, ensureHost: async () => undefined },
		);
		try {
			const streaming = new Promise<void>((resolve) => {
				const unsubscribe = runtime.session.subscribe((event) => {
					if (event.type !== "agent_start") return;
					unsubscribe();
					resolve();
				});
			});
			void runtime.session.prompt("hold-open-1500 first");
			await streaming;
			const consumed = new Promise<void>((resolve) => {
				const unsubscribe = runtime.session.subscribe((event) => {
					if (event.type !== "queue_update" || event.ordered.length !== 0) return;
					unsubscribe();
					resolve();
				});
			});
			await runtime.session.steer("A");
			await consumed;
			const cleared = runtime.session.clearQueue({ abortWillFollow: false });
			expect(cleared.ordered.map((item) => item.text)).not.toContain("A");
		} finally {
			await runtime.dispose();
			await fake.close();
		}
	});

	it("pins local bash prefix, running state, and abort signal", async () => {
		const qa = scratch("local-bash-abort");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const settingsManager = SettingsManager.create(qa.cwd, qa.agentDir);
		settingsManager.setShellCommandPrefix("set -e");
		const runtime = await createInteractiveHostRuntime(
			await createAgentSessionRuntimeFixture({
				cwd: qa.cwd,
				agentDir: qa.agentDir,
				sessionManager: SessionManager.create(qa.cwd, qa.sessionDir),
				settingsManager,
			}),
			{ socket: qa.socket, ensureHost: async () => undefined },
		);
		try {
			let observedSignal: AbortSignal | undefined;
			let observedCommand = "";
			let startedResolve: (() => void) | undefined;
			const started = new Promise<void>((resolve) => {
				startedResolve = resolve;
			});
			const execution = runtime.session.executeBash("echo local", undefined, {
				operations: {
					exec: async (command, _cwd, options) => {
						observedCommand = command;
						observedSignal = options.signal;
						startedResolve?.();
						await new Promise<void>((done) =>
							options.signal?.addEventListener("abort", () => done(), { once: true }),
						);
						return { exitCode: null };
					},
				},
			});
			await started;
			expect(runtime.session.isBashRunning).toBe(true);
			expect(observedCommand).toBe(`set -e\necho local`);
			expect(observedSignal).toBeDefined();
			runtime.session.abortBash();
			await execution;
			expect(observedSignal?.aborted).toBe(true);
			expect(runtime.session.isBashRunning).toBe(false);
		} finally {
			await runtime.dispose();
			await fake.close();
		}
	});

	it("composes local and host bash lifecycle state", async () => {
		const qa = scratch("bash-lifecycle");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const runtime = await createInteractiveHostRuntime(
			await createAgentSessionRuntimeFixture({
				cwd: qa.cwd,
				agentDir: qa.agentDir,
				sessionManager: SessionManager.create(qa.cwd, qa.sessionDir),
				settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
			}),
			{ socket: qa.socket, ensureHost: async () => undefined },
		);
		const observer = new RpcClient({ socketPath: qa.socket });
		await observer.start();
		await observer.openSession({ sessionPath: runtime.session.sessionFile!, cwd: qa.cwd });
		try {
			let resolveLocal!: () => void;
			const localDone = new Promise<void>((resolve) => (resolveLocal = resolve));
			const hostStarted = new Promise<void>((resolve) => {
				observer.onEvent((event) => {
					if (event.type === "bash_start") resolve();
				});
			});
			const hostBash = observer.bash("sleep 1");
			await hostStarted;
			const localBash = runtime.session.executeBash("local", undefined, {
				operations: {
					exec: async (_command, _cwd, { onData }) => {
						onData(Buffer.from("local"));
						await localDone;
						return { exitCode: 0 };
					},
				},
			});
			await new Promise<void>((resolve) => queueMicrotask(resolve));
			expect(runtime.session.isBashRunning).toBe(true);
			resolveLocal();
			await localBash;
			expect(runtime.session.isBashRunning).toBe(true);
			await hostBash;
			expect(runtime.session.isBashRunning).toBe(false);
		} finally {
			await observer.stop();
			await runtime.dispose();
			await fake.close();
		}
	});

	it("aborts local bash when switching sessions and does not record on the replacement", async () => {
		const qa = scratch("replacement-abort");
		qa.socket = `/tmp/senpi-w6-abort-${process.pid}.sock`;
		const projectB = join(qa.root, "project-b");
		mkdirSync(projectB, { recursive: true });
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const target = SessionManager.create(projectB, qa.sessionDir);
		const targetPath = target.getSessionFile()!;
		const runtime = await createInteractiveHostRuntime(
			await createAgentSessionRuntimeFixture({
				cwd: qa.cwd,
				agentDir: qa.agentDir,
				sessionManager: SessionManager.create(qa.cwd, qa.sessionDir),
				settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
			}),
			{ socket: qa.socket, ensureHost: async () => undefined },
		);
		try {
			let resolveStarted!: () => void;
			const started = new Promise<void>((resolve) => (resolveStarted = resolve));
			let observedSignal!: AbortSignal;
			const execution = runtime.session.executeBash("old-command", undefined, {
				operations: {
					exec: async (_command, _cwd, options) => {
						observedSignal = options.signal!;
						resolveStarted();
						await new Promise<void>((resolve) =>
							options.signal?.addEventListener("abort", () => resolve(), { once: true }),
						);
						return { exitCode: null };
					},
				},
			});
			await started;
			await runtime.switchSession(targetPath);
			await execution;
			expect(observedSignal.aborted).toBe(true);
			const observer = new RpcClient({ socketPath: qa.socket });
			await observer.start();
			try {
				await observer.openSession({ sessionPath: targetPath, cwd: projectB });
				expect((await observer.getEntries()).entries).not.toContainEqual(
					expect.objectContaining({ command: "old-command" }),
				);
			} finally {
				await observer.stop();
			}
		} finally {
			await runtime.dispose();
			await fake.close();
		}
	});

	it("rebinds settingsManager reads to the replacement session", async () => {
		const qa = scratch("rs");
		const projectB = join(qa.root, "project-b");
		mkdirSync(join(projectB, CONFIG_DIR_NAME), { recursive: true });
		writeFileSync(
			join(projectB, CONFIG_DIR_NAME, "settings.json"),
			JSON.stringify({ shellCommandPrefix: "replacement-prefix" }),
		);
		new ProjectTrustStore(qa.agentDir).set(projectB, true);
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const target = SessionManager.create(projectB, qa.sessionDir);
		target.appendMessage({ role: "user", content: "replacement-target", timestamp: 1 });
		target.appendMessage(fauxAssistantMessage("replacement-target-answer"));
		const targetPath = target.getSessionFile();
		if (!targetPath) throw new Error("target session path missing");
		const runtime = await createInteractiveHostRuntime(
			await createAgentSessionRuntimeFixture({
				cwd: qa.cwd,
				agentDir: qa.agentDir,
				sessionManager: SessionManager.create(qa.cwd, qa.sessionDir),
				settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
			}),
			{ socket: qa.socket, ensureHost: async () => undefined },
		);
		try {
			await runtime.switchSession(targetPath, { cwdOverride: projectB });
			expect(runtime.session.settingsManager.getShellCommandPrefix()).toBe("replacement-prefix");
		} finally {
			await runtime.dispose();
			await fake.close();
		}
	});

	it.each([
		{ projectTrusted: true, expectedCommand: "prefix-b\necho current" },
		{ projectTrusted: false, expectedCommand: "echo current" },
	])(
		"uses host trust=$projectTrusted when refreshing replacement bash settings",
		async ({ projectTrusted, expectedCommand }) => {
			const qa = scratch(`replacement-prefix-${projectTrusted}`);
			qa.socket = `/tmp/senpi-w7-prefix-${projectTrusted}-${process.pid}.sock`;
			const projectB = join(qa.root, "project-b");
			mkdirSync(join(projectB, CONFIG_DIR_NAME), { recursive: true });
			writeFileSync(
				join(projectB, CONFIG_DIR_NAME, "settings.json"),
				JSON.stringify({ shellCommandPrefix: "prefix-b" }),
			);
			if (projectTrusted) new ProjectTrustStore(qa.agentDir).set(projectB, true);
			const fake = await startFakeModelServer();
			writeRpcModelsJson(qa.agentDir, fake.origin);
			const host = spawnHost(qa);
			await waitForHost(host, qa.socket);
			const targetManager = SessionManager.create(projectB, qa.sessionDir);
			targetManager.appendMessage({ role: "user", content: "target", timestamp: 1 });
			const targetPath = targetManager.getSessionFile()!;
			const runtime = await createInteractiveHostRuntime(
				await createAgentSessionRuntimeFixture({
					cwd: qa.cwd,
					agentDir: qa.agentDir,
					sessionManager: SessionManager.create(qa.cwd, qa.sessionDir),
					settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
				}),
				{ socket: qa.socket, ensureHost: async () => undefined },
			);
			try {
				await runtime.switchSession(targetPath, { cwdOverride: projectB });
				expect(runtime.session.sessionManager.getCwd()).toBe(projectB);
				let observedCommand = "";
				await runtime.session.executeBash("echo current", undefined, {
					operations: {
						exec: async (command) => {
							observedCommand = command;
							return { exitCode: 0 };
						},
					},
				});
				expect(observedCommand).toBe(expectedCommand);
			} finally {
				await runtime.dispose();
				await fake.close();
			}
		},
	);

	it("refreshes a missing stored cwd from a switch override", async () => {
		const qa = scratch("cwd-override");
		const missingCwd = join(qa.root, "missing-cwd");
		mkdirSync(missingCwd);
		const target = SessionManager.create(missingCwd, qa.sessionDir);
		const targetPath = target.getSessionFile()!;
		rmSync(missingCwd, { recursive: true, force: true });
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const runtime = await createInteractiveHostRuntime(
			await createAgentSessionRuntimeFixture({
				cwd: qa.cwd,
				agentDir: qa.agentDir,
				sessionManager: SessionManager.create(qa.cwd, qa.sessionDir),
				settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
			}),
			{ socket: qa.socket, ensureHost: async () => undefined },
		);
		try {
			await runtime.switchSession(targetPath, { cwdOverride: qa.cwd });
			expect(runtime.session.sessionManager.getCwd()).toBe(qa.cwd);
		} finally {
			await runtime.dispose();
			await fake.close();
		}
	});

	it("mirrors remote session names through the proxied session manager", async () => {
		const qa = scratch("session-name");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const manager = SessionManager.create(qa.cwd, qa.sessionDir);
		const runtime = await createInteractiveHostRuntime(
			await createAgentSessionRuntimeFixture({
				cwd: qa.cwd,
				agentDir: qa.agentDir,
				sessionManager: manager,
				settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
			}),
			{ socket: qa.socket, ensureHost: async () => undefined },
		);
		const observer = new RpcClient({ socketPath: qa.socket });
		await observer.start();
		try {
			await observer.openSession({ sessionPath: runtime.session.sessionFile!, cwd: qa.cwd });
			await observer.setSessionName("remote-footer-name");
			await new Promise((resolve) => setImmediate(resolve));
			expect(runtime.session.sessionManager.getSessionName()).toBe("remote-footer-name");
		} finally {
			await observer.stop();
			await runtime.dispose();
			await fake.close();
		}
	});

	it("accepts the legacy image-array prompt API through a real host", async () => {
		const qa = scratch("images");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const sessionManager = SessionManager.create(qa.cwd, qa.sessionDir);
		const client = new RpcClient({ socketPath: qa.socket });
		await client.start();
		try {
			const opened = await client.openSession({
				sessionPath: sessionManager.getSessionFile(),
				cwd: qa.cwd,
			});
			const events = client.collectEvents(30_000);
			await client.prompt("legacy-image", [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]);
			const received = await events;
			expect(received).toContainEqual(
				expect.objectContaining({
					type: "message_start",
					message: expect.objectContaining({
						role: "user",
						content: expect.arrayContaining([expect.objectContaining({ type: "image" })]),
					}),
				}),
			);
			await client.closeSession(opened.sessionId);
		} finally {
			await client.stop();
			await fake.close();
		}
	});

	it("keeps target history after target compaction following a switch", async () => {
		const qa = scratch("postcomp");
		mkdirSync(qa.agentDir, { recursive: true });
		writeFileSync(join(qa.agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 10 } }));
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = spawnHost(qa);
		await waitForHost(host, qa.socket);
		const bootstrap = SessionManager.create(qa.cwd, qa.sessionDir);
		bootstrap.appendMessage({
			role: "user",
			content: "bootstrap-only",
			timestamp: 1,
		});
		const target = SessionManager.create(qa.cwd, qa.sessionDir);
		for (let index = 0; index < 4; index++) {
			target.appendMessage({
				role: "user",
				content: `target-only-${index}`,
				timestamp: index + 2,
			});
			target.appendMessage(fauxAssistantMessage(`target-answer-${index}`));
		}
		const local = await createAgentSessionRuntimeFixture({
			cwd: qa.cwd,
			agentDir: qa.agentDir,
			sessionManager: bootstrap,
			settingsManager: SettingsManager.create(qa.cwd, qa.agentDir),
		});
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => undefined,
		});
		try {
			await runtime.switchSession(target.getSessionFile()!);
			await runtime.session.compact();
			expect(runtime.session.messages).toContainEqual({
				role: "user",
				content: "target-only-3",
				timestamp: 5,
			});
			expect(runtime.session.messages).not.toContainEqual({
				role: "user",
				content: "bootstrap-only",
				timestamp: 1,
			});
			expect(runtime.session.sessionManager.getSessionFile()).toBe(target.getSessionFile());
		} finally {
			await runtime.dispose();
			await fake.close();
		}
	});
});

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolve();
		}, 2_000);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}
