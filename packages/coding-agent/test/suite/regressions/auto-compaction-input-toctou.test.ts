import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../../src/core/agent-session.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "../../model-runtime-test-utils.ts";
import { createTestResourceLoader } from "../../utilities.ts";

type CompactionOwner = "auto" | "compaction";

function claimCompactionController(session: AgentSession, controller: AbortController, owner: CompactionOwner): void {
	const claim = Reflect.get(session, "_claimCompactionController") as (
		controller: AbortController,
		owner: CompactionOwner,
	) => void;
	claim.call(session, controller, owner);
}

describe("auto-compaction input submitted across the state-check window", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let settingsManager: SettingsManager;
	let tempDir: string;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pi-auto-compaction-toctou-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			streamFn: streamSimple,
			initialState: { model, systemPrompt: "Test", tools: [] },
		});

		sessionManager = SessionManager.inMemory();
		settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});
	});

	afterEach(() => {
		session.dispose();
		vi.restoreAllMocks();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	it("retains input when auto-compaction releases the session mid-submission", async () => {
		const controller = new AbortController();
		claimCompactionController(session, controller, "auto");

		const submission = session.prompt("typed while compaction was ending", { streamingBehavior: "followUp" });
		const release = Reflect.get(session, "_releaseCompactionController") as (signal: AbortSignal) => void;
		release.call(session, controller.signal);
		await submission;

		expect(session.getFollowUpMessages()).toContain("typed while compaction was ending");
	});
});
