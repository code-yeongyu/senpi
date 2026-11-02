import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { AgentSession } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

type CompactionOwner = "auto" | "compaction";

const tempDir = join(tmpdir(), `pi-qa-auto-compaction-${Date.now()}`);
mkdirSync(tempDir, { recursive: true });

function claim(session: AgentSession, controller: AbortController, owner: CompactionOwner): void {
	const fn = Reflect.get(session, "_claimCompactionController") as (
		c: AbortController,
		o: CompactionOwner,
	) => void;
	fn.call(session, controller, owner);
}

function release(session: AgentSession, controller: AbortController): void {
	const fn = Reflect.get(session, "_releaseCompactionController") as (signal: AbortSignal) => void;
	fn.call(session, controller.signal);
}

async function main(): Promise<void> {
	const model = getModel("anthropic", "claude-sonnet-4-5")!;
	const agent = new Agent({
		streamFn: streamSimple,
		initialState: { model, systemPrompt: "QA", tools: [] },
	});
	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "qa-key" }));
	const { createModelRegistry, getModelRuntime } = await import("../model-runtime-test-utils.ts");
	const modelRegistry = await createModelRegistry(authStorage, tempDir);

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader: (await import("../utilities.ts")).createTestResourceLoader(),
	});

	const controller = new AbortController();
	claim(session, controller, "auto");

	const observed: Record<string, unknown> = {
		isCompactingWhileAuto: session.isCompacting,
	};

	await session.prompt("QA: typed while Compacting context...", { streamingBehavior: "steer" });

	observed.pendingAfterSubmit = session.pendingMessageCount;
	observed.steeringVisible = session.getSteeringMessages();

	release(session, controller);
	observed.isCompactingAfterRelease = session.isCompacting;
	observed.pendingSurvivesCompactionEnd = session.pendingMessageCount;

	console.log("QA-SURFACE-RESULT", JSON.stringify(observed, null, 2));

	const ok =
		observed.isCompactingWhileAuto === true &&
		observed.pendingAfterSubmit === 1 &&
		observed.pendingSurvivesCompactionEnd === 1;
	console.log(ok ? "QA-VERDICT: PASS" : "QA-VERDICT: FAIL");

	session.dispose();
	if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	process.exit(ok ? 0 : 1);
}

void main();
