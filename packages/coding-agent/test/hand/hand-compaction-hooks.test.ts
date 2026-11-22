// senpi#5898 (K8): a hosted loop forwards its compaction events to the hand, so the user's PreCompact and PostCompact
// shell hooks and their extensions' compaction handlers run on the user's machine, see the loop's preparation as a
// session would (a malformed one is refused, never partly applied), and stop when the loop cancels the call.
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { type LifecycleReply, toJson, userMachine } from "./lifecycle-hook-fixture.ts";
import { cleanupHands } from "./remote-hand-fixture.ts";

afterEach(cleanupHands);

const preparation = {
	firstKeptEntryId: "entry-2",
	messagesToSummarize: [fauxAssistantMessage("old work")],
	turnPrefixMessages: [],
	isSplitTurn: false,
	tokensBefore: 1200,
	fileOps: { read: ["src/a.ts", "src/b.ts"], written: [], edited: [] },
	settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, speculativeFraction: 0.75 },
};
const noteEntry = {
	type: "custom",
	id: "entry-1",
	parentId: null,
	timestamp: new Date(0).toISOString(),
	customType: "note",
};

/** A loop's compaction as it sends it: the preparation's file sets go as arrays, the rest as it is. */
const beforeCompact = (overrides: { preparation?: object; branchEntries?: unknown[] } = {}) => ({
	reason: "manual",
	requestId: "compaction-1",
	willRetry: false,
	preparation: toJson(overrides.preparation ?? preparation),
	branchEntries: toJson(overrides.branchEntries ?? [noteEntry]),
});

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

const CUSTOM_COMPACTION_EXTENSION = `export default (pi) => {
	pi.on("session_before_compact", (event) => ({ compaction: { summary: \`read \${[...event.preparation.fileOps.read].join(",")} of \${event.branchEntries.length} entries, aborted \${event.signal.aborted}\`, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } }));
};`;

/** A user extension whose compaction runs until its signal aborts, then answers; it announces that it started. */
const CANCELLABLE_COMPACTION_EXTENSION = `export default (pi) => {
	pi.on("session_before_compact", (event) => new Promise((resolve) => {
		event.signal.addEventListener("abort", () => resolve({ compaction: { summary: "cancelled", firstKeptEntryId: "entry-2", tokensBefore: 0 } }), { once: true });
		globalThis.l2Started?.();
	}));
};`;

/** A user extension that reports a transcript message field this version's schema does not name. */
const UNKNOWN_FIELD_EXTENSION = `export default (pi) => {
	pi.on("session_before_compact", (event) => ({ compaction: { summary: \`injected \${event.preparation.messagesToSummarize[0].injected}\`, firstKeptEntryId: "entry-2", tokensBefore: 0 } }));
};`;

/** The reviewers' probes: each makes one field of the payload malformed, or adds a field a strict part does not name. */
const MALFORMED: readonly [string, Record<string, unknown>][] = [
	[
		"a settings field of the wrong type",
		beforeCompact({
			preparation: { ...preparation, settings: { ...preparation.settings, speculativeFraction: "bogus" } },
		}),
	],
	[
		"a negative reserveTokens",
		beforeCompact({ preparation: { ...preparation, settings: { ...preparation.settings, reserveTokens: -1 } } }),
	],
	["a negative tokensBefore", beforeCompact({ preparation: { ...preparation, tokensBefore: -5 } })],
	[
		"a message entry without its message",
		beforeCompact({ branchEntries: [{ ...noteEntry, type: "message", customType: undefined }] }),
	],
	[
		"an assistant message with only a role",
		beforeCompact({ preparation: { ...preparation, messagesToSummarize: [{ role: "assistant" }] } }),
	],
	[
		"file sets that are not arrays",
		beforeCompact({ preparation: { ...preparation, fileOps: { read: {}, written: [], edited: [] } } }),
	],
	[
		"an unknown compaction settings field",
		beforeCompact({ preparation: { ...preparation, settings: { ...preparation.settings, bogus: true } } }),
	],
	["an unknown preparation field", beforeCompact({ preparation: { ...preparation, bogus: true } })],
	[
		"an unknown file-set field",
		beforeCompact({ preparation: { ...preparation, fileOps: { ...preparation.fileOps, bogus: [] } } }),
	],
	["an unknown envelope field", { ...beforeCompact(), injected: true }],
];

describe("a hosted loop's compaction hooks run on the user's machine (senpi#5898)", () => {
	it("session_before_compact runs the user's PreCompact hook there and returns its report for the loop to send", async () => {
		const user = await userMachine({
			hook: "PreCompact",
			stdout: {
				hookSpecificOutput: { hookEventName: "PreCompact", additionalContext: "context from the user machine" },
			},
		});

		const reply = (await user.machine.loopHooks("session_before_compact", {
			...user.base,
			...beforeCompact(),
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
			...beforeCompact(),
		})) as LifecycleReply;

		expect(reply.cancel).toBe(true);
		expect(reply.sent?.map((sent) => sent.message.content)).toEqual(["not now"]);
	});

	it("a user extension customises the loop's compaction from the preparation it sent", async () => {
		const user = await userMachine({ extension: CUSTOM_COMPACTION_EXTENSION });

		const reply = (await user.machine.loopHooks("session_before_compact", {
			...user.base,
			...beforeCompact(),
		})) as LifecycleReply;

		expect(reply.errors).toBeUndefined();
		expect(reply.compaction).toEqual({
			summary: "read src/a.ts,src/b.ts of 1 entries, aborted false",
			firstKeptEntryId: "entry-2",
			tokensBefore: 1200,
		});
	});

	it.each(MALFORMED)("refuses a session_before_compact with %s, so no handler sees it", async (_case, payload) => {
		const user = await userMachine({ extension: CUSTOM_COMPACTION_EXTENSION });

		await expect(user.machine.loopHooks("session_before_compact", { ...user.base, ...payload })).rejects.toThrow(
			"malformed session_before_compact payload",
		);
	});

	// Transcript messages and session entries stay open to fields a newer loop adds: they reach handlers untouched.
	it("a transcript message field this version does not name reaches the handlers untouched", async () => {
		const user = await userMachine({ extension: UNKNOWN_FIELD_EXTENSION });
		const message = { ...fauxAssistantMessage("old work"), injected: "kept" };

		const reply = (await user.machine.loopHooks("session_before_compact", {
			...user.base,
			...beforeCompact({ preparation: { ...preparation, messagesToSummarize: [message] } }),
		})) as LifecycleReply;

		expect(reply.errors).toBeUndefined();
		expect(reply.compaction?.summary).toBe("injected kept");
	});

	it("the loop cancelling the call aborts the handlers' signal while they run", async () => {
		const user = await userMachine({ extension: CANCELLABLE_COMPACTION_EXTENSION });
		const started = new Promise<void>((resolve) => Object.assign(globalThis, { l2Started: resolve }));
		const loopCall = new AbortController();

		const reply = user.machine.loopHooks(
			"session_before_compact",
			{ ...user.base, ...beforeCompact() },
			loopCall.signal,
		) as Promise<LifecycleReply>;
		await started;
		loopCall.abort();

		expect((await reply).compaction?.summary).toBe("cancelled");
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
});
