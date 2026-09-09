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
	if (typeof claim !== "function") throw new Error("Expected AgentSession._claimCompactionController");
	claim.call(session, controller, owner);
}

describe("auto-compaction input admission", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let settingsManager: SettingsManager;
	let tempDir: string;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pi-auto-compaction-admission-${Date.now()}`);
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

	it("queues steer input submitted while auto-compaction owns the session", async () => {
		claimCompactionController(session, new AbortController(), "auto");
		expect(session.isCompacting).toBe(true);

		await session.prompt("typed while auto-compacting", { streamingBehavior: "steer" });

		expect(session.getSteeringMessages()).toContain("typed while auto-compacting");
		expect(session.pendingMessageCount).toBe(1);
	});

	it("queues follow-up input submitted while auto-compaction owns the session", async () => {
		claimCompactionController(session, new AbortController(), "auto");

		await session.prompt("follow-up while auto-compacting", { streamingBehavior: "followUp" });

		expect(session.getFollowUpMessages()).toContain("follow-up while auto-compacting");
		expect(session.pendingMessageCount).toBe(1);
	});

	it("preserves submission order across mixed input during auto-compaction", async () => {
		claimCompactionController(session, new AbortController(), "auto");

		await session.prompt("first steer", { streamingBehavior: "steer" });
		await session.prompt("second follow-up", { streamingBehavior: "followUp" });

		expect(session.pendingMessageCount).toBe(2);
		expect(session.getSteeringMessages()).toEqual(["first steer"]);
		expect(session.getFollowUpMessages()).toEqual(["second follow-up"]);
	});

	it("still rejects unqueueable input while manual compaction owns the session", async () => {
		claimCompactionController(session, new AbortController(), "compaction");

		await expect(session.prompt("typed during manual compact")).rejects.toThrow(
			/Cannot submit a prompt while compaction is in progress/,
		);
		expect(session.pendingMessageCount).toBe(0);
	});
});
