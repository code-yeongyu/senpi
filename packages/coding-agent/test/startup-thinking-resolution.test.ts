import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const MODEL = getModel("openai-codex", "gpt-5.5");

describe("startup thinking-level resolution characterization", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-startup-thinking-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function settings(values: Record<string, unknown>): SettingsManager {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(values));
		return SettingsManager.create(cwd, agentDir);
	}

	it("uses the global default for a fresh model with no remembered level", async () => {
		expect(MODEL).toBeDefined();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: MODEL!,
			settingsManager: settings({ defaultThinkingLevel: "low" }),
			sessionManager: SessionManager.inMemory(cwd),
		});

		expect(session.thinkingLevel).toBe("low");
		session.dispose();
	});

	it("keeps an explicit startup thinking level above settings", async () => {
		expect(MODEL).toBeDefined();
		const key = `${MODEL!.provider}/${MODEL!.id}`;
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: MODEL!,
			thinkingLevel: "high",
			settingsManager: settings({ defaultThinkingLevel: "low", modelThinkingLevels: { [key]: "xhigh" } }),
			sessionManager: SessionManager.inMemory(cwd),
		});

		expect(session.thinkingLevel).toBe("high");
		session.dispose();
	});

	it("restores an exact session thinking entry above model memory", async () => {
		expect(MODEL).toBeDefined();
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.appendModelChange(MODEL!.provider, MODEL!.id);
		sessionManager.appendMessage({ role: "user", content: "resume", timestamp: Date.now() });
		sessionManager.appendThinkingLevelChange("high");
		const key = `${MODEL!.provider}/${MODEL!.id}`;

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: MODEL!,
			settingsManager: settings({ defaultThinkingLevel: "low", modelThinkingLevels: { [key]: "xhigh" } }),
			sessionManager,
		});

		expect(session.thinkingLevel).toBe("high");
		session.dispose();
	});
});

describe("startup thinking-level resolution", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-startup-thinking-red-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function settings(values: Record<string, unknown>): SettingsManager {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(values));
		return SettingsManager.create(cwd, agentDir);
	}

	it("starts a fresh session from the initial model's remembered level", async () => {
		expect(MODEL).toBeDefined();
		const key = `${MODEL!.provider}/${MODEL!.id}`;
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: MODEL!,
			settingsManager: settings({ defaultThinkingLevel: "low", modelThinkingLevels: { [key]: "xhigh" } }),
			sessionManager: SessionManager.inMemory(cwd),
		});

		expect(session.thinkingLevel).toBe("xhigh");
		session.dispose();
	});

	it("keeps an explicit scoped model level above that model's memory", async () => {
		expect(MODEL).toBeDefined();
		const key = `${MODEL!.provider}/${MODEL!.id}`;
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			scopedModels: [{ model: MODEL!, thinkingLevel: "high" }],
			settingsManager: settings({ defaultThinkingLevel: "low", modelThinkingLevels: { [key]: "xhigh" } }),
			sessionManager: SessionManager.inMemory(cwd),
		});

		expect(session.thinkingLevel).toBe("high");
		session.dispose();
	});

	it("persists guarded explicit-CLI replay to the selected model even when the level is unchanged", async () => {
		expect(MODEL).toBeDefined();
		const settingsManager = settings({ defaultThinkingLevel: "low" });
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: MODEL!,
			thinkingLevel: "high",
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
		});

		// main.ts performs this guarded replay only for --thinking or --model x:level.
		session.setThinkingLevel(session.thinkingLevel);

		expect(settingsManager.getModelThinkingLevel(MODEL!.provider, MODEL!.id)).toBe("high");
		session.dispose();
	});

	it("resumes a session without a thinking entry from the restored model's memory", async () => {
		expect(MODEL).toBeDefined();
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.appendModelChange(MODEL!.provider, MODEL!.id);
		sessionManager.appendMessage({ role: "user", content: "resume", timestamp: Date.now() });
		const key = `${MODEL!.provider}/${MODEL!.id}`;
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: MODEL!,
			settingsManager: settings({ defaultThinkingLevel: "low", modelThinkingLevels: { [key]: "xhigh" } }),
			sessionManager,
		});

		expect(session.thinkingLevel).toBe("xhigh");
		session.dispose();
	});

	it("uses a replacement model's own memory instead of the missing saved model's level", async () => {
		expect(MODEL).toBeDefined();
		const replacement = { ...MODEL!, id: `${MODEL!.id}-replacement`, name: "Replacement" };
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.appendModelChange("missing-provider", "missing-model");
		sessionManager.appendMessage({ role: "user", content: "resume", timestamp: Date.now() });
		const replacementKey = `${replacement.provider}/${replacement.id}`;
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: replacement,
			settingsManager: settings({
				defaultThinkingLevel: "low",
				modelThinkingLevels: {
					"missing-provider/missing-model": "xhigh",
					[replacementKey]: "high",
				},
			}),
			sessionManager,
		});

		expect(session.model?.id).toBe(replacement.id);
		expect(session.thinkingLevel).toBe("high");
		session.dispose();
	});

	it("falls through malformed model memory without throwing", async () => {
		expect(MODEL).toBeDefined();
		const key = `${MODEL!.provider}/${MODEL!.id}`;
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: MODEL!,
			settingsManager: settings({ defaultThinkingLevel: "low", modelThinkingLevels: { [key]: "garbage" } }),
			sessionManager: SessionManager.inMemory(cwd),
		});

		expect(session.thinkingLevel).toBe("low");
		session.dispose();
	});

	it("clamps stale memory at startup without rewriting the stored value", async () => {
		expect(MODEL).toBeDefined();
		const limitedModel = {
			...MODEL!,
			id: `${MODEL!.id}-limited`,
			name: "Limited",
			thinkingLevelMap: { minimal: null, low: null, medium: null, xhigh: null, max: null },
		};
		const key = `${limitedModel.provider}/${limitedModel.id}`;
		const settingsManager = settings({ defaultThinkingLevel: "low", modelThinkingLevels: { [key]: "xhigh" } });
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: limitedModel,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
		});

		expect(session.thinkingLevel).toBe("high");
		expect(settingsManager.getModelThinkingLevel(limitedModel.provider, limitedModel.id)).toBe("xhigh");
		session.dispose();
	});
});
