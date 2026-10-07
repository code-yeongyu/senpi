import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import { estimateTokens } from "../../../src/core/compaction/compaction.ts";
import {
	ModelUsabilityBudgetError,
	projectModelUsabilityBudget,
} from "../../../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import type { CompactionEntry, SessionEntry } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * #1524: a restored transcript whose live context alone exceeds the model
 * context window was refused at resume admission, so the session could never be
 * opened again. #1517 admits oversized resumes only while `live <= window`.
 */
const CONTEXT_WINDOW = 850_000;
const MAX_TOKENS = 128_000;
const ORDINARY_REQUEST_CONTEXT_BUDGET = CONTEXT_WINDOW - MAX_TOKENS;
const TURN_TEXT = "restored context ".repeat(4_800);

interface SeedResult {
	messageEntries: number;
	liveTokens: number;
}

function seedOversizedTranscript(harness: Harness, turns: number): SeedResult {
	const model = harness.getModel();
	let timestamp = 1;
	for (let turn = 0; turn < turns; turn++) {
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `${TURN_TEXT} turn ${turn}` }],
			timestamp: timestamp++,
		});
		if (turn % 6 === 5) {
			const toolCallId = `call-${turn}`;
			harness.sessionManager.appendMessage({
				...fauxAssistantMessage("running a tool", { timestamp: timestamp++ }),
				content: [
					{ type: "text", text: "running a tool" },
					{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "echo hi" } },
				],
				api: model.api,
				provider: model.provider,
				model: model.id,
			});
			harness.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId,
				toolName: "bash",
				content: [{ type: "text", text: `${TURN_TEXT} tool output ${turn}` }],
				isError: false,
				timestamp: timestamp++,
			});
			continue;
		}
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage(`${TURN_TEXT} answer ${turn}`, { timestamp: timestamp++ }),
			api: model.api,
			provider: model.provider,
			model: model.id,
		});
	}
	const entries = harness.sessionManager.getEntries();
	const messages = harness.sessionManager.buildSessionContext().messages;
	return {
		messageEntries: entries.filter((entry) => entry.type === "message").length,
		liveTokens: messages.reduce((total, message) => total + estimateTokens(message), 0),
	};
}

function compactionEntries(entries: SessionEntry[]): CompactionEntry[] {
	return entries.filter((entry): entry is CompactionEntry => entry.type === "compaction");
}

function messageEntryCount(harness: Harness): number {
	return harness.sessionManager.getEntries().filter((entry) => entry.type === "message").length;
}

function persistedMessageEntryCount(harness: Harness): number {
	const sessionFile = harness.sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("expected a persisted session file");
	return readFileSync(sessionFile, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as { type?: string })
		.filter((entry) => entry.type === "message").length;
}

function orphanToolResultIds(messages: readonly { role: string; [key: string]: unknown }[]): string[] {
	const callIds = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of (message.content ?? []) as Array<{ type: string; id?: string }>) {
			if (block.type === "toolCall" && block.id) callIds.add(block.id);
		}
	}
	return messages
		.filter((message) => message.role === "toolResult")
		.map((message) => String(message.toolCallId))
		.filter((id) => !callIds.has(id));
}

function uncompactedRequirement(harness: Harness, session: AgentSession, liveContextTokens: number): number {
	const projection = projectModelUsabilityBudget({
		model: harness.getModel(),
		systemPrompt: session.agent.state.systemPrompt,
		tools: session.agent.state.tools,
		liveContextTokens,
		compaction: harness.settingsManager.getCompactionSettings(),
		includeSpeculationLead: false,
		admission: "resume",
	});
	return (
		projection.liveContextTokens +
		projection.systemPromptTokens +
		projection.activeToolSchemaTokens +
		projection.outputReserveTokens +
		projection.compactionReserveTokens +
		projection.speculationLeadTokens +
		projection.safetyMarginTokens
	);
}

async function resume(harness: Harness, dirName: string) {
	return createAgentSession({
		cwd: harness.tempDir,
		agentDir: join(harness.tempDir, dirName),
		model: harness.getModel(),
		sessionManager: harness.sessionManager,
	});
}

describe("#1524 resume when live context exceeds the context window", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function oversizedHarness(): Promise<{ harness: Harness; seed: SeedResult }> {
		const harness = await createHarness({
			models: [{ id: "resume", contextWindow: CONTEXT_WINDOW, maxTokens: MAX_TOKENS }],
			persistSession: true,
		});
		harnesses.push(harness);
		const seed = seedOversizedTranscript(harness, 24);
		expect(seed.liveTokens).toBeGreaterThan(CONTEXT_WINDOW);
		return { harness, seed };
	}

	it("opens the session, keeps the transcript, and leaves room for an ordinary request", async () => {
		const { harness, seed } = await oversizedHarness();

		const resumed = await resume(harness, "resume-agent");
		const messages = resumed.session.agent.state.messages;
		const contextTokens = messages.reduce((total: number, message) => total + estimateTokens(message), 0);

		expect(contextTokens).toBeLessThanOrEqual(ORDINARY_REQUEST_CONTEXT_BUDGET);
		expect(uncompactedRequirement(harness, resumed.session, contextTokens)).toBeLessThanOrEqual(CONTEXT_WINDOW);
		expect(persistedMessageEntryCount(harness)).toBe(seed.messageEntries);
		const entries = harness.sessionManager.getEntries();
		expect(entries.filter((entry) => entry.type === "message")).toHaveLength(seed.messageEntries);
		const compactions = compactionEntries(entries);
		expect(compactions).toHaveLength(1);
		expect(compactions[0]?.details).toMatchObject({ origin: "resume-admission" });
		expect(orphanToolResultIds(messages as never)).toEqual([]);
		resumed.session.dispose();
	});

	it("reopening an already reduced session does not add another reduction", async () => {
		const { harness } = await oversizedHarness();

		const first = await resume(harness, "resume-agent");
		first.session.dispose();
		const afterFirst = compactionEntries(harness.sessionManager.getEntries()).length;
		const second = await resume(harness, "resume-agent-2");
		second.session.dispose();

		expect(compactionEntries(harness.sessionManager.getEntries())).toHaveLength(afterFirst);
	});

	it("refuses without touching history when the fixed overhead cannot fit", async () => {
		const harness = await createHarness({
			models: [{ id: "tiny", contextWindow: 12_000, maxTokens: 10_000 }],
			persistSession: true,
		});
		harnesses.push(harness);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "overflowing ".repeat(20_000) }],
			timestamp: 1,
		});
		const before = messageEntryCount(harness);

		await expect(resume(harness, "tiny-agent")).rejects.toBeInstanceOf(ModelUsabilityBudgetError);

		expect(messageEntryCount(harness)).toBe(before);
		expect(compactionEntries(harness.sessionManager.getEntries())).toHaveLength(0);
	});

	it("keeps refusing when the user disabled compaction", async () => {
		const { harness } = await oversizedHarness();
		const agentDir = join(harness.tempDir, "disabled-agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
		const before = messageEntryCount(harness);

		await expect(resume(harness, "disabled-agent")).rejects.toBeInstanceOf(ModelUsabilityBudgetError);

		expect(messageEntryCount(harness)).toBe(before);
		expect(compactionEntries(harness.sessionManager.getEntries())).toHaveLength(0);
	});
});
