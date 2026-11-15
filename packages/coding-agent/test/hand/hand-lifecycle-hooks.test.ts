// senpi#5898: a hosted loop forwards its lifecycle events to the hand, so the user's SessionStart shell hooks run on
// the user's machine as they do in a local session (brain/hand split, K5; hooks builtin C8).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, type JsonValue } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { STOP_STATE_CUSTOM_TYPE } from "../../src/core/extensions/builtin/hooks/stop-adapter.ts";
import { createLooplessHand } from "../../src/modes/rpc/remote-executor-scope.ts";
import { type LifecycleHookEvent, writeLifecycleHook } from "./lifecycle-hook-fixture.ts";
import { cleanupHands, handConfiguration, handDirs } from "./remote-hand-fixture.ts";

afterEach(cleanupHands);

async function userMachine(event: LifecycleHookEvent, stdout?: unknown) {
	const dirs = await handDirs("k5-lifecycle");
	writeLifecycleHook(dirs.cwd, event, stdout);
	const machine = createLooplessHand(handConfiguration(dirs), { twoSidedHome: "hand" });
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
	readonly sent?: { message: { content: unknown } }[];
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

const stopCounts = (reply: LifecycleReply) =>
	(reply.entries ?? [])
		.filter((entry) => entry.customType === STOP_STATE_CUSTOM_TYPE)
		.map((entry) => (entry.data as { count: number }).count);

describe("a hosted loop's lifecycle hooks run on the user's machine (senpi#5898)", () => {
	it("session_start runs the user's SessionStart hook there and returns its context for the loop to send", async () => {
		const user = await userMachine("SessionStart", {
			hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "context from the user machine" },
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
		const user = await userMachine("Stop");

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
		const user = await userMachine("Stop", { decision: "block", reason: "keep going" });
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
});
