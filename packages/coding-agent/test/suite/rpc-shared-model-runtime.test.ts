import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createCliRuntimeFactory } from "../../src/main.ts";
import { RpcSessionRegistry } from "../../src/modes/rpc/session-registry.ts";

/**
 * A shared host's sessions all live in one agent dir, so building a model
 * runtime per open is ~100 ms of loop CPU repeated per session - and on one
 * loop, N concurrent opens each pay it N times (senpi#1844). The factory
 * therefore accepts one runtime for every session it creates. This suite pins
 * the identity, so a refactor that quietly rebuilds the runtime per session
 * fails here instead of in a latency chart.
 */
describe("createCliRuntimeFactory with a host-shared ModelRuntime", () => {
	let scratch: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "senpi-shared-runtime-"));
		cwd = join(scratch, "cwd");
		agentDir = join(scratch, "agent");
		mkdirSync(cwd);
		mkdirSync(agentDir);
		vi.stubEnv("SENPI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("OMO_CODING_AGENT_DIR", agentDir);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(scratch, { recursive: true, force: true });
	});

	const makeRegistry = (modelRuntime: ModelRuntime | undefined) => {
		const parsed = parseArgs(["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes"]);
		const factory = createCliRuntimeFactory(
			{ parsed, cwd, agentDir, appMode: "rpc" },
			{
				startupSettingsManager: SettingsManager.create(cwd, agentDir),
				...(modelRuntime === undefined ? {} : { modelRuntime }),
			},
		);
		return new RpcSessionRegistry({ agentDir, createRuntime: factory });
	};

	const runtimeOf = (registry: RpcSessionRegistry, sessionId: string) =>
		registry.getForCommand(sessionId, "get_state").runtime?.services.modelRuntime;

	it("hands every session the one runtime it was given", async () => {
		const shared = await ModelRuntime.create({
			credentials: AuthStorage.create(join(agentDir, "auth.json")),
			authPath: join(agentDir, "auth.json"),
			agentDir,
			modelsPath: join(agentDir, "models.json"),
		});
		const registry = makeRegistry(shared);

		const first = await registry.openSession({ cwd });
		const second = await registry.openSession({ cwd });

		expect(runtimeOf(registry, first.sessionId)).toBe(shared);
		expect(runtimeOf(registry, second.sessionId)).toBe(shared);
		await registry.close(first.sessionId);
		await registry.close(second.sessionId);
	});

	it("builds a runtime per session when none is given, so the sharing is opt-in", async () => {
		const registry = makeRegistry(undefined);

		const first = await registry.openSession({ cwd });
		const second = await registry.openSession({ cwd });

		const a = runtimeOf(registry, first.sessionId);
		const b = runtimeOf(registry, second.sessionId);
		expect(a).toBeDefined();
		expect(b).toBeDefined();
		expect(a).not.toBe(b);
		await registry.close(first.sessionId);
		await registry.close(second.sessionId);
	});
});
