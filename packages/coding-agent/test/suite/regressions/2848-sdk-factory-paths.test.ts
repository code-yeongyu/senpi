import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import { generateBranchSummary } from "../../../src/core/compaction/branch-summarization.ts";
import { completeSummarization } from "../../../src/core/compaction/compaction.ts";
import { closeSession } from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { generateSessionTitle } from "../../../src/core/session-title-generator.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { captureSdkRequests, cleanupSdkPaths, sdkPathHarness } from "./2848-sdk-cwd-fixture.ts";

const sessions: AgentSession[] = [];
const retry = { enabled: false, maxRetries: 0, baseDelayMs: 0 };

afterEach(() => {
	for (const session of sessions.splice(0)) {
		closeSession(session.sessionManager.getSessionId(), "test_cleanup");
		session.dispose();
	}
	cleanupSdkPaths();
});

describe("senpi#2848 session-factory SDK cwd paths", () => {
	it.each(["main", "title", "summary", "branch-summary", "subagent", "resume"] as const)(
		"passes the originating cwd to the SDK for %s",
		async (path) => {
			const captured = captureSdkRequests();
			const harness = await sdkPathHarness();
			const cwd = join(harness.tempDir, path);
			mkdirSync(cwd);
			const sessionManager = SessionManager.inMemory(cwd);
			const { session } = await createAgentSession({
				...(path === "resume" ? {} : { cwd }),
				agentDir: join(harness.tempDir, "factory-agent"),
				model: harness.getModel(),
				modelRuntime: harness.modelRegistry.modelRuntime,
				sessionManager,
				settingsManager: SettingsManager.inMemory({}),
				autoTitleSessions: false,
			});
			sessions.push(session);
			const model = harness.getModel();
			const user = { role: "user" as const, content: "Implement project cwd preservation", timestamp: 1 };

			if (path === "title") {
				const title = await generateSessionTitle({
					firstPrompt: user.content,
					model,
					auth: { apiKey: "cwd-fixture" },
					sessionId: sessionManager.getSessionId(),
					streamFn: session.agent.streamFunction,
					retry,
				});
				expect(title).toBeDefined();
			} else if (path === "summary") {
				const result = await completeSummarization(
					model,
					normalizeContext({ messages: [user] }),
					{},
					session.agent.streamFunction,
					retry,
				);
				expect(result.stopReason).toBe("stop");
			} else if (path === "branch-summary") {
				sessionManager.appendMessage(user);
				const result = await generateBranchSummary(sessionManager.getEntries(), {
					model,
					signal: new AbortController().signal,
					streamFn: session.agent.streamFunction,
					retry,
				});
				expect(result.summary).toBeDefined();
			} else {
				await session.prompt(user.content);
				expect(session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
			}

			expect(captured.length).toBeGreaterThan(0);
			expect(captured.every((options) => options.cwd === cwd)).toBe(true);
			expect(cwd).not.toBe(process.cwd());
		},
	);
});
