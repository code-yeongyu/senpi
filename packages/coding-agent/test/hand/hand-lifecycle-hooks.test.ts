// senpi#5898: a hosted loop forwards its lifecycle events to the hand, so the user's SessionStart, Stop, PreCompact and
// PostCompact shell hooks and their extensions' compaction and shutdown handlers run on the user's machine as they do
// in a local session (brain/hand split, K5-K9; hooks builtin C8).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, type JsonValue } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { STOP_STATE_CUSTOM_TYPE } from "../../src/core/extensions/builtin/hooks/stop-adapter.ts";
import { createLooplessHand } from "../../src/modes/rpc/remote-executor-scope.ts";
import { type LifecycleHookEvent, writeLifecycleHook } from "./lifecycle-hook-fixture.ts";
import { cleanupHands, handConfiguration, handDirs } from "./remote-hand-fixture.ts";

afterEach(cleanupHands);

/** The user's machine: a hand with a trusted shell hook for `hook`, or the user's own `extension` source loaded by path. */
async function userMachine(options: { hook?: LifecycleHookEvent; stdout?: unknown; extension?: string }) {
	const dirs = await handDirs("k5-lifecycle");
	if (options.hook !== undefined) writeLifecycleHook(dirs.cwd, options.hook, options.stdout);
	const extension = join(dirs.scratch, "user-lifecycle-ext.ts");
	if (options.extension !== undefined) writeFileSync(extension, options.extension);
	const args = options.extension === undefined ? [] : ["-e", extension];
	const machine = createLooplessHand(handConfiguration(dirs, args), { twoSidedHome: "hand" });
	const sessionId = `loop-${crypto.randomUUID()}`;
	const base = { sessionId, idle: false, scope: { id: `session-${sessionId}`, root: dirs.cwd } };
	const marker = join(dirs.cwd, "hook-ran.txt");
	return {
		machine,
		base,
		marks: () => (existsSync(marker) ? readFileSync(marker, "utf-8") : ""),
	};
}

interface LifecycleReply {
	readonly cancel?: boolean;
	readonly compaction?: { summary: string; firstKeptEntryId: string; tokensBefore: number };
	readonly sent?: { message: { content: unknown; details?: { event?: string; compactionRequestId?: string } } }[];
	readonly entries?: { customType: string; data?: unknown }[];
	readonly userMessages?: { content: unknown; options?: unknown }[];
	readonly errors?: unknown[];
}

const toJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

/** The loop's side of the session port: it appends each entry a reply returns as its own custom entry. */
const asHandEntries = (reply: LifecycleReply, from: number) =>
	(reply.entries ?? []).map((entry, index) => ({
		type: "custom",
		id: `hand-${from + index}`,
		parentId: null,
		timestamp: new Date(0).toISOString(),
		customType: entry.customType,
		data: entry.data,
	}));

/** A loop's compaction as it sends it: the preparation's file sets go as arrays, the rest as it is. */
const beforeCompact = {
	reason: "manual",
	requestId: "compaction-1",
	willRetry: false,
	preparation: toJson({
		firstKeptEntryId: "entry-2",
		messagesToSummarize: [fauxAssistantMessage("old work")],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 1200,
		fileOps: { read: ["src/a.ts", "src/b.ts"], written: [], edited: [] },
		settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
	}),
	branchEntries: toJson([
		{ type: "custom", id: "entry-1", parentId: null, timestamp: new Date(0).toISOString(), customType: "note" },
	]),
};

const compacted = {
	reason: "manual",
	requestId: "compaction-1",
	accepted: true,
	compactionEntry: toJson({
		type: "compaction",
		id: "compaction-entry-1",
		parentId: "entry-1",
		timestamp: new Date(0).toISOString(),
		summary: "summary",
		firstKeptEntryId: "entry-2",
		tokensBefore: 1200,
	}),
	fromExtension: false,
	willRetry: false,
};

/** A user extension that customises compaction from what the loop sent, and records its failure and shutdown handlers. */
const COMPACTION_AND_SHUTDOWN_EXTENSION = `import { appendFileSync } from "node:fs";
import { join } from "node:path";
export default (pi) => {
	pi.on("session_before_compact", (event) => ({ compaction: { summary: \`read \${[...event.preparation.fileOps.read].join(",")} of \${event.branchEntries.length} entries, aborted \${event.signal.aborted}\`, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } }));
	pi.on("session_compact_failed", (event, ctx) => appendFileSync(join(ctx.cwd, "hook-ran.txt"), \`session_compact_failed \${event.reason} \${event.errorMessage}\\n\`));
	pi.on("session_shutdown", (event, ctx) => appendFileSync(join(ctx.cwd, "hook-ran.txt"), \`session_shutdown \${event.reason} \${ctx.sessionManager.getSessionId()}\\n\`));
};`;

const stopCounts = (reply: LifecycleReply) =>
	(reply.entries ?? [])
		.filter((entry) => entry.customType === STOP_STATE_CUSTOM_TYPE)
		.map((entry) => (entry.data as { count: number }).count);

describe("a hosted loop's lifecycle hooks run on the user's machine (senpi#5898)", () => {
	it("session_start runs the user's SessionStart hook there and returns its context for the loop to send", async () => {
		const user = await userMachine({
			hook: "SessionStart",
			stdout: {
				hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "context from the user machine" },
			},
		});

		const reply = (await user.machine.loopHooks("session_start", {
			...user.base,
			reason: "startup",
		})) as LifecycleReply;

		expect(user.marks()).toBe("SessionStart\n");
		expect(reply.errors).toBeUndefined();
		expect(JSON.stringify(reply.sent?.map((sent) => sent.message.content))).toContain(
			"context from the user machine",
		);
	});

	it("agent_end runs the user's Stop hook there and returns its stop state as an entry for the loop's session", async () => {
		const user = await userMachine({ hook: "Stop" });

		const reply = (await user.machine.loopHooks("agent_end", {
			...user.base,
			messages: toJson([fauxAssistantMessage("done")]),
			leafId: "leaf-1",
			handEntries: [],
		})) as LifecycleReply;

		expect(user.marks()).toBe("Stop\n");
		expect(reply.errors).toBeUndefined();
		expect(stopCounts(reply)).toEqual([0]);
		expect(reply.userMessages).toBeUndefined();
	});

	it("a blocking Stop hook continues the turn through the loop, counting reentries only from the entries it carries", async () => {
		const user = await userMachine({ hook: "Stop", stdout: { decision: "block", reason: "keep going" } });
		const call = (handEntries: unknown[]) =>
			user.machine.loopHooks("agent_end", {
				...user.base,
				messages: toJson([fauxAssistantMessage("done")]),
				leafId: "leaf-1",
				handEntries: toJson(handEntries),
			}) as Promise<LifecycleReply>;

		const first = await call([]);
		const second = await call(asHandEntries(first, 0));
		// The loop sends only the hand's entries after its last compaction: what it carries is all the hand reads.
		const afterCompaction = await call([]);

		expect([stopCounts(first), stopCounts(second), stopCounts(afterCompaction)]).toEqual([[1], [2], [1]]);
		expect(first.userMessages?.map((message) => message.content)).toEqual(["keep going"]);
		expect([first.errors, second.errors, afterCompaction.errors]).toEqual([undefined, undefined, undefined]);
	});

	it("session_before_compact runs the user's PreCompact hook there and returns its report for the loop to send", async () => {
		const user = await userMachine({
			hook: "PreCompact",
			stdout: {
				hookSpecificOutput: { hookEventName: "PreCompact", additionalContext: "context from the user machine" },
			},
		});

		const reply = (await user.machine.loopHooks("session_before_compact", {
			...user.base,
			...beforeCompact,
		})) as LifecycleReply;

		expect(user.marks()).toBe("PreCompact\n");
		expect(reply.errors).toBeUndefined();
		expect(reply.cancel).toBeUndefined();
		expect(reply.sent?.map((sent) => sent.message.details)).toMatchObject([
			{ event: "PreCompact", compactionRequestId: "compaction-1" },
		]);
	});

	it("a PreCompact hook that blocks there cancels the loop's compaction", async () => {
		const user = await userMachine({ hook: "PreCompact", stdout: { decision: "block", reason: "not now" } });

		const reply = (await user.machine.loopHooks("session_before_compact", {
			...user.base,
			...beforeCompact,
		})) as LifecycleReply;

		expect(reply.cancel).toBe(true);
		expect(reply.sent?.map((sent) => sent.message.content)).toEqual(["not now"]);
	});

	it("a user extension customises the loop's compaction from the preparation it sent", async () => {
		const user = await userMachine({ extension: COMPACTION_AND_SHUTDOWN_EXTENSION });

		const reply = (await user.machine.loopHooks("session_before_compact", {
			...user.base,
			...beforeCompact,
		})) as LifecycleReply;

		expect(reply.errors).toBeUndefined();
		expect(reply.compaction).toEqual({
			summary: "read src/a.ts,src/b.ts of 1 entries, aborted false",
			firstKeptEntryId: "entry-2",
			tokensBefore: 1200,
		});
	});

	it("refuses a session_before_compact whose preparation is malformed", async () => {
		const user = await userMachine({ extension: COMPACTION_AND_SHUTDOWN_EXTENSION });
		const preparation = { ...(beforeCompact.preparation as object), fileOps: { read: {}, written: [], edited: [] } };

		await expect(
			user.machine.loopHooks("session_before_compact", { ...user.base, ...beforeCompact, preparation }),
		).rejects.toThrow("malformed session_before_compact payload");
	});

	it("session_compact runs the user's PostCompact hook there and returns its context for the loop to send", async () => {
		const user = await userMachine({
			hook: "PostCompact",
			stdout: { hookSpecificOutput: { hookEventName: "PostCompact", additionalContext: "after compaction" } },
		});

		const reply = (await user.machine.loopHooks("session_compact", { ...user.base, ...compacted })) as LifecycleReply;

		expect(user.marks()).toBe("PostCompact\n");
		expect(reply.errors).toBeUndefined();
		expect(reply.sent?.map((sent) => sent.message.content)).toEqual(["after compaction"]);
	});

	it("a user extension's compaction-failure and shutdown handlers run there, bound to the loop session", async () => {
		const user = await userMachine({ extension: COMPACTION_AND_SHUTDOWN_EXTENSION });

		const failed = (await user.machine.loopHooks("session_compact_failed", {
			...user.base,
			reason: "threshold",
			errorMessage: "summary failed",
			aborted: false,
			willRetry: false,
			fromExtension: false,
		})) as LifecycleReply;
		const shutdown = (await user.machine.loopHooks("session_shutdown", {
			...user.base,
			reason: "quit",
		})) as LifecycleReply;

		expect([failed.errors, shutdown.errors]).toEqual([undefined, undefined]);
		expect(user.marks()).toBe(
			`session_compact_failed threshold summary failed\nsession_shutdown quit ${user.base.sessionId}\n`,
		);
	});
});
