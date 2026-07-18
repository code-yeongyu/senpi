import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("AgentSession CLI system prompt overrides", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-system-prompt-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSessionWithPromptOverrides(overrides: {
		systemPrompt?: string;
		appendSystemPrompt?: string[];
	}): Promise<AgentSession> {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			...overrides,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});
		return session;
	}

	it("uses the CLI-provided system prompt instead of the generated base prompt", async () => {
		const session = await createSessionWithPromptOverrides({
			systemPrompt: "CLI override system prompt.",
			appendSystemPrompt: ["First CLI append.", "Second CLI append."],
		});

		expect(session.systemPrompt).toBe("CLI override system prompt.\n\nFirst CLI append.\n\nSecond CLI append.");

		session.dispose();
	});

	it("appends CLI append-system prompts to the generated base prompt", async () => {
		const session = await createSessionWithPromptOverrides({
			appendSystemPrompt: ["First CLI append.", "Second CLI append."],
		});

		expect(session.systemPrompt).toContain("You are senpi, a coding agent.");
		expect(session.systemPrompt).toContain("Current working directory:");
		expect(session.systemPrompt.endsWith("\n\nFirst CLI append.\n\nSecond CLI append.")).toBe(true);

		session.dispose();
	});
});
