import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createCliRuntimeFactory } from "../../../src/main.ts";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry, RpcSessionRegistryError } from "../../../src/modes/rpc/session-registry.ts";
import type { SessionWorkerClient } from "../../../src/modes/rpc/session-worker-client.ts";
import { WorkerSessionRegistry } from "../../../src/modes/rpc/worker-session-registry.ts";

/**
 * #2906: an RPC host `open_session` whose requested model cannot be resolved used to open
 * anyway, on the host's default model, and report success. The open must fail with a typed
 * error and roll back; a model that resolves must still open on it.
 */
describe("open_session with an unresolvable creationModel (#2906)", () => {
	let scratch: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "senpi-2906-"));
		cwd = join(scratch, "cwd");
		agentDir = join(scratch, "agent");
		mkdirSync(cwd);
		mkdirSync(agentDir);
		vi.stubEnv("SENPI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("OMO_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PI_OFFLINE", "1");
		vi.stubEnv("SENPI_OFFLINE", "1");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(scratch, { recursive: true, force: true });
	});

	function hostRegistry(): RpcSessionRegistry {
		const parsed = parseArgs(["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes"]);
		const factory = createCliRuntimeFactory(
			{ parsed, cwd, agentDir, appMode: "rpc" },
			{ startupSettingsManager: SettingsManager.create(cwd, agentDir) },
		);
		return new RpcSessionRegistry({ agentDir, createRuntime: factory });
	}

	it("fails the open with model_unavailable and leaves no session behind", async () => {
		const registry = hostRegistry();
		const sessionPath = join(scratch, "pinned.jsonl");
		const opening = registry.openSession({
			cwd,
			sessionPath,
			creationModel: { provider: "no-such-provider-2906", modelId: "some-model" },
		});

		const failure = await opening.then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(RpcSessionRegistryError);
		const typed = failure as RpcSessionRegistryError;
		expect(typed.code).toBe("open_failed");
		expect(typed.message).toMatch(/^open_failed: model_unavailable: /);
		expect(typed.detail).toEqual({ reason: "model_unavailable", requestedModel: "no-such-provider-2906/some-model" });
		expect(registry.list()).toEqual([]);

		const reopened = await registry.openSession({
			cwd,
			sessionPath,
			creationModel: { provider: "openai", modelId: "gpt-6-astra" },
		});
		await registry.close(reopened.sessionId);
	}, 30_000);

	it.each([
		["openai", "gpt-6-astra", "gpt-6-astra", undefined],
		["openai", "gpt-6-astra:high", "gpt-6-astra", "high"],
	] as const)(
		"still opens on a resolvable model %s/%s",
		async (provider, modelId, expectedId, expectedThinking) => {
			const registry = hostRegistry();
			const opened = await registry.openSession({ cwd, creationModel: { provider, modelId } });
			try {
				const runtime = registry.getForCommand(opened.sessionId, "get_state").runtime;
				if (!runtime) throw new Error("session runtime missing");
				expect(runtime.session.model?.provider).toBe(provider);
				expect(runtime.session.model?.id).toBe(expectedId);
				if (expectedThinking !== undefined) expect(runtime.session.thinkingLevel).toBe(expectedThinking);
			} finally {
				await registry.close(opened.sessionId);
			}
		},
		30_000,
	);

	it("keeps one open_failed prefix when a worker reports the refusal through its failure callback", async () => {
		const reason = 'open_failed: model_unavailable: Unknown provider "no-such-provider-2906".';
		const registry = new WorkerSessionRegistry({
			configuration: {
				parsed: parseArgs(["--mode", "rpc", "--no-extensions", "--no-skills"]),
				cwd,
				agentDir,
				appMode: "rpc",
			},
			closeGraceMs: 100,
			now: Date.now,
			createWorker: (callbacks: { failure: (error: string) => void }): SessionWorkerClient =>
				({
					prepare: async () => join(scratch, "worker.jsonl"),
					commit: async () => {
						callbacks.failure(reason);
						return { state: { sessionId: "unused", cwd } };
					},
					quarantine: () => {},
				}) as unknown as SessionWorkerClient,
		});

		const failure = await registry.openSession({ cwd }).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(RpcSessionRegistryError);
		expect((failure as RpcSessionRegistryError).message).toBe(reason);
	});

	it("answers open_session with one open_failed prefix when the worker's commit rejects (the real worker path)", async () => {
		const reason = 'open_failed: model_unavailable: Unknown provider "no-such-provider-2906".';
		const registry = new WorkerSessionRegistry({
			configuration: {
				parsed: parseArgs(["--mode", "rpc", "--no-extensions", "--no-skills"]),
				cwd,
				agentDir,
				appMode: "rpc",
			},
			closeGraceMs: 100,
			now: Date.now,
			createWorker: (): SessionWorkerClient =>
				({
					prepare: async () => join(scratch, "worker-reject.jsonl"),
					commit: async () => {
						throw new Error(reason);
					},
					quarantine: () => {},
				}) as unknown as SessionWorkerClient,
		});
		const router = new SessionCommandRouter(registry, new SessionEventWriter(() => {}), { cwd });

		const response = await router.handle({
			id: "open",
			type: "open_session",
			cwd,
			provider: "no-such-provider-2906",
			modelId: "some-model",
		});
		expect(response).toMatchObject({ success: false, error: reason });
	});

	it.each([
		["provider without modelId", { provider: "openai" }],
		["modelId without provider", { modelId: "gpt-6-astra" }],
		["an empty modelId", { provider: "openai", modelId: "" }],
	] as const)("refuses open_session with %s", async (_name, half) => {
		const router = new SessionCommandRouter(hostRegistry(), new SessionEventWriter(() => {}), { cwd });
		const response = await router.handle({ id: "half", type: "open_session", cwd, ...half });
		expect(response).toMatchObject({
			success: false,
			error: "invalid_launch_profile: provider and modelId must be given together",
		});
	});
});
