import { createModels, type FauxResponseFactory, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness, type AgentLane } from "../../src/harness/agent-harness.ts";
import { generateBranchSummaryWithRequest } from "../../src/harness/compaction/branch-summarization.ts";
import {
	type CompactionPreparation,
	compact,
	compactWithRequest,
	DEFAULT_COMPACTION_SETTINGS,
	generateSummaryWithRequest,
	type SummaryRequest,
} from "../../src/harness/compaction/compaction.ts";
import { createFileOps } from "../../src/harness/compaction/utils.ts";
import { BACKGROUND_CONTEXT, withSessionCwd } from "../../src/harness/context.ts";
import { MemoryStorage } from "../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../src/harness/session/session.ts";
import type { Session } from "../../src/harness/session/types.ts";

// senpi#5256 / oh-my-openagent#12026: a provider that requires an absolute session cwd
// (anthropic-subscription) rejects any request that arrives without one.
const SESSION_CWD = "/workspace/project";
const sessions: Session[] = [];

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

function recordingReply(text: string, cwds: (string | undefined)[]): FauxResponseFactory {
	return (_context, options) => {
		cwds.push(options?.cwd);
		return fauxAssistantMessage(text);
	};
}

async function harnessLane(): Promise<{ lane: AgentLane; faux: ReturnType<typeof fauxProvider>; session: Session }> {
	const session = new StorageBackedSession(
		{ id: `session-cwd-${sessions.length}`, createdAt: 1, storageVersion: 1, cwd: SESSION_CWD },
		new MemoryStorage(),
	);
	sessions.push(session);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const { harness } = await AgentHarness.create({ session, models, model: faux.getModel() }, BACKGROUND_CONTEXT);
	return { lane: await harness.lane("main", BACKGROUND_CONTEXT), faux, session };
}

interface HarnessCase {
	path: string;
	run: (cwds: (string | undefined)[]) => Promise<void>;
}

const harnessCases: HarnessCase[] = [
	{
		path: "assistant turn",
		run: async (cwds) => {
			const { lane, faux } = await harnessLane();
			faux.setResponses([recordingReply("answer", cwds)]);
			expect(await lane.prompt("question", undefined, BACKGROUND_CONTEXT)).toMatchObject({ ok: true });
		},
	},
	{
		path: "standalone compaction summary",
		run: async (cwds) => {
			const { lane, faux } = await harnessLane();
			await lane.appendMessage({ role: "user", content: "history", timestamp: 1 }, BACKGROUND_CONTEXT);
			faux.setResponses([recordingReply("summary", cwds)]);
			expect(await lane.compact(undefined, BACKGROUND_CONTEXT)).toMatchObject({
				ok: true,
				value: { compaction: { status: "completed" } },
			});
		},
	},
	{
		path: "summarized navigation (branch summary)",
		run: async (cwds) => {
			const { lane, faux, session } = await harnessLane();
			const rootId = await lane.appendMessage({ role: "user", content: "root", timestamp: 1 }, BACKGROUND_CONTEXT);
			await lane.appendMessage({ role: "user", content: "source", timestamp: 2 }, BACKGROUND_CONTEXT);
			await session.mutate(
				(mutator) =>
					mutator.commit(
						[
							{
								kind: "entry",
								entry: {
									id: "target",
									parentId: rootId,
									type: "message",
									message: { role: "user", content: "target", timestamp: 3 },
								},
							},
						],
						BACKGROUND_CONTEXT,
					),
				BACKGROUND_CONTEXT,
			);
			faux.setResponses([recordingReply("branch summary", cwds)]);
			expect(await lane.navigateTree("target", { summarize: true }, BACKGROUND_CONTEXT)).toMatchObject({
				ok: true,
				value: { navigation: { status: "completed" } },
			});
		},
	},
];

function user(content: string) {
	return { role: "user" as const, content, timestamp: 1 };
}

function preparation(overrides: Partial<CompactionPreparation> = {}): CompactionPreparation {
	return {
		messagesToSummarize: [user("old history")],
		turnPrefixMessages: [],
		retainedTail: [user("tail")],
		isSplitTurn: false,
		tokensBefore: 1_000,
		fileOps: createFileOps(),
		settings: DEFAULT_COMPACTION_SETTINGS,
		...overrides,
	};
}

interface BuilderCase {
	path: string;
	requests: number;
	run: (request: SummaryRequest, faux: ReturnType<typeof fauxProvider>, cwds: (string | undefined)[]) => Promise<void>;
}

const sessionContext = withSessionCwd(SESSION_CWD, BACKGROUND_CONTEXT);

const builderCases: BuilderCase[] = [
	{
		path: "generateSummaryWithRequest",
		requests: 1,
		run: async (request, faux) => {
			const result = await generateSummaryWithRequest(
				[user("history")],
				{ model: faux.getModel(), reserveTokens: 1_000 },
				request,
				sessionContext,
			);
			expect(result.ok).toBe(true);
		},
	},
	{
		path: "compactWithRequest (history and split-turn prefix)",
		requests: 2,
		run: async (request, faux) => {
			const result = await compactWithRequest(
				preparation({ turnPrefixMessages: [user("large turn")], isSplitTurn: true }),
				{ model: faux.getModel() },
				request,
				sessionContext,
			);
			expect(result.ok).toBe(true);
		},
	},
	{
		path: "generateBranchSummaryWithRequest",
		requests: 1,
		run: async (request) => {
			const result = await generateBranchSummaryWithRequest(
				{ messages: [user("abandoned")], fileOps: createFileOps(), totalTokens: 10 },
				{},
				request,
				sessionContext,
			);
			expect(result.ok).toBe(true);
		},
	},
	{
		path: "compact through completeSimpleWithRetries",
		requests: 1,
		run: async (_request, faux, cwds) => {
			const models = createModels();
			models.setProvider(faux.provider);
			faux.setResponses([recordingReply("summary", cwds)]);
			const result = await compact(
				preparation(),
				models,
				faux.getModel(),
				undefined,
				undefined,
				undefined,
				undefined,
				sessionContext,
			);
			expect(result.ok).toBe(true);
		},
	},
];

describe("summary request builders carry the session cwd", () => {
	it.each(builderCases)("$path", async ({ requests, run }) => {
		const faux = fauxProvider();
		const cwds: (string | undefined)[] = [];
		const request: SummaryRequest = async (_aiContext, options) => {
			cwds.push(options.cwd);
			return fauxAssistantMessage("summary");
		};
		await run(request, faux, cwds);
		expect(cwds).toEqual(Array.from({ length: requests }, () => SESSION_CWD));
	});
});

describe("harness provider requests carry the session cwd", () => {
	it.each(harnessCases)("$path", async ({ run }) => {
		const cwds: (string | undefined)[] = [];
		await run(cwds);
		expect(cwds).toEqual([SESSION_CWD]);
	});
});
