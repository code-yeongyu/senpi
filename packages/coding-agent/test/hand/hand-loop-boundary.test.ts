// senpi#5898: a hosted loop's `turn_end` / `agent_before_settle` boundary runs the user's handlers on the hand in steps.
// The hand stops after a handler that drafts, so the loop can rebuild the context between handlers as a local walk does
// (review L2), and every step of one walk indexes the handler list taken at its first step (review L8).
import { fauxAssistantMessage, type JsonValue } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { hooksOf, toJson } from "./loop-event-fixture.ts";

const note = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 0 });
const preview = { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: true };
const turnEnd = {
	sessionId: "s",
	idle: false,
	turnIndex: 2,
	message: fauxAssistantMessage("done"),
	toolResults: [],
	messageEntryId: "entry-9",
	toolResultEntryIds: [],
	outcome: "completed",
	continue: false,
};

interface BoundaryReply {
	readonly [key: string]: unknown;
	readonly entries: unknown[];
	readonly continue: boolean;
	readonly resume?: { readonly next: number; readonly extensionPath: string; readonly walk: string };
}

type Hooks = Awaited<ReturnType<typeof hooksOf>>;

const step = (hooks: Hooks, fields: object) =>
	hooks("turn_end", toJson({ ...turnEnd, context: preview, entries: [], ...fields })) as Promise<BoundaryReply>;

/** The loop's side: forward again from `resume.next` with the walk's id, until the hand's part ends. */
async function walkBoundary(hooks: Hooks): Promise<BoundaryReply> {
	let reply = await step(hooks, {});
	while (reply.resume !== undefined)
		reply = await step(hooks, { entries: reply.entries, from: reply.resume.next, walk: reply.resume.walk });
	return reply;
}

type MidWalk = (pi: Parameters<ExtensionFactory>[0], stop: () => void) => void;

/** A handler that drafts an entry named for it, and does `midWalk` (subscribe, unsubscribe) while it runs. */
const drafting =
	(name: string, seen: string[], midWalk?: MidWalk): ExtensionFactory =>
	(pi) => {
		const stop = pi.on("turn_end", (event) => {
			seen.push(name);
			midWalk?.(pi, stop);
			return { entries: [...event.entries, { type: "custom", customType: name }] };
		});
	};

describe("a hosted loop's boundary walks the user's handlers on the hand in steps (senpi#5898)", () => {
	it("stops after a hand handler drafts, so the next one sees the context the loop rebuilt (review L2)", async () => {
		const pending: number[] = [];
		const counting =
			(name: string): ExtensionFactory =>
			(pi) =>
				void pi.on("turn_end", (event) => {
					pending.push(event.context.pendingMessages.length);
					return { entries: [...event.entries, { type: "custom", customType: name }] };
				});
		const hooks = await hooksOf([
			{ path: "/user/a.ts", factory: counting("a") },
			{ path: "/user/b.ts", factory: counting("b") },
		]);

		const first = await step(hooks, {});
		const rebuilt = { ...preview, pendingMessages: [note("rebuilt"), note("by the loop")] };
		const second = await step(hooks, {
			entries: first.entries,
			context: rebuilt,
			from: first.resume?.next,
			walk: first.resume?.walk,
		});
		const last = await step(hooks, { entries: second.entries, from: second.resume?.next, walk: second.resume?.walk });

		expect(first.entries).toEqual([{ type: "custom", customType: "a" }]);
		expect(first.resume).toMatchObject({ next: 1, extensionPath: "/user/a.ts" });
		expect(second.resume).toMatchObject({ next: 2, extensionPath: "/user/b.ts", walk: first.resume?.walk });
		expect(last).toEqual({ entries: second.entries, continue: false });
		expect(pending).toEqual([0, 2]);
	});

	it.each<{ change: string; midWalk: MidWalk }>([
		{ change: "unsubscribes", midWalk: (_pi, stop) => stop() },
		{ change: "subscribes another handler", midWalk: (pi) => void pi.on("turn_end", () => ({ entries: [] })) },
	])("runs every handler of the walk once when one $change mid-walk (review L8)", async ({ midWalk }) => {
		const seen: string[] = [];
		const hooks = await hooksOf([
			{ path: "/user/a.ts", factory: drafting("a", seen, midWalk) },
			{ path: "/user/b.ts", factory: drafting("b", seen) },
		]);

		const reply = await walkBoundary(hooks);

		expect(seen).toEqual(["a", "b"]);
		expect(reply.entries).toEqual([
			{ type: "custom", customType: "a" },
			{ type: "custom", customType: "b" },
		]);
	});

	it("refuses a step that names no walk, or a walk this hand does not hold open", async () => {
		const hooks = await hooksOf([{ path: "/user/a.ts", factory: drafting("a", []) }]);

		await expect(step(hooks, { from: 1 })).rejects.toThrow("malformed turn_end payload");
		await expect(step(hooks, { from: 1, walk: "never-opened" })).rejects.toThrow(/is not open on this hand/);
	});

	it("refuses a resume point other than the one the walk's last step named: no handler repeats or is skipped (#6787 review L1)", async () => {
		const seen: string[] = [];
		const hooks = await hooksOf([
			{ path: "/user/a.ts", factory: drafting("a", seen) },
			{ path: "/user/b.ts", factory: drafting("b", seen) },
		]);
		const first = await step(hooks, {});
		const walk = first.resume?.walk;
		const second = await step(hooks, { entries: first.entries, from: 1, walk });

		for (const from of [1, 99])
			await expect(step(hooks, { entries: second.entries, from, walk })).rejects.toThrow(/expects from 2/);
		const last = await step(hooks, { entries: second.entries, from: 2, walk });

		expect(seen).toEqual(["a", "b"]);
		expect(last.resume).toBeUndefined();
	});

	it("refuses a second copy of a step while the first is still running: the handler runs once (#6799 review L1)", async () => {
		const seen: string[] = [];
		const held = Promise.withResolvers<void>();
		const holding: ExtensionFactory = (pi) =>
			void pi.on("turn_end", async (event) => {
				seen.push("b");
				await held.promise;
				return { entries: [...event.entries, { type: "custom", customType: "b" }] };
			});
		const hooks = await hooksOf([
			{ path: "/user/a.ts", factory: drafting("a", seen) },
			{ path: "/user/b.ts", factory: holding },
		]);
		const first = await step(hooks, {});
		const resume = { entries: first.entries, from: 1, walk: first.resume?.walk };

		// Both copies are sent while b still runs (it waits on `held`); then b is let go.
		const running = step(hooks, resume);
		const copy = step(hooks, resume);
		held.resolve();
		const [ran, copied] = await Promise.allSettled([running, copy]);

		expect(seen).toEqual(["a", "b"]);
		expect(ran).toMatchObject({ status: "fulfilled", value: { resume: { next: 2 } } });
		expect(copied).toMatchObject({ status: "rejected", reason: { message: expect.stringMatching(/in flight/) } });
	});

	it("a step that fails releases its claim, so the loop may send it again (#6806 review L1)", async () => {
		const seen: string[] = [];
		const hooks = await hooksOf([
			{ path: "/user/a.ts", factory: drafting("a", seen) },
			{ path: "/user/b.ts", factory: drafting("b", seen) },
		]);
		const first = await step(hooks, {});
		const walk = first.resume?.walk;
		// A step of another boundary event cannot resume this turn_end walk: the hand's dispatch throws.
		const wrong = hooks(
			"agent_before_settle",
			toJson({ ...turnEnd, context: preview, entries: first.entries, from: 1, walk }),
		);

		await expect(wrong).rejects.toThrow(/cannot resume/);
		const retried = await step(hooks, { entries: first.entries, from: 1, walk });

		expect(retried.resume).toMatchObject({ next: 2, extensionPath: "/user/b.ts" });
		expect(seen).toEqual(["a", "b"]);
	});

	it("a step still running across a shutdown leaves the session's next walk alone (#6806 review L2)", async () => {
		const seen: string[] = [];
		const held = Promise.withResolvers<void>();
		let holdNext = true;
		const holding: ExtensionFactory = (pi) =>
			void pi.on("turn_end", async (event) => {
				seen.push("b");
				if (holdNext) {
					holdNext = false;
					await held.promise;
				}
				return { entries: [...event.entries, { type: "custom", customType: "b" }] };
			});
		const hooks = await hooksOf([
			{ path: "/user/a.ts", factory: drafting("a", seen) },
			{ path: "/user/b.ts", factory: holding },
		]);
		const old = await step(hooks, {});
		const stale = step(hooks, { entries: old.entries, from: 1, walk: old.resume?.walk });
		await hooks("session_shutdown", toJson({ sessionId: "s", idle: true, reason: "quit" }));
		const fresh = await step(hooks, {});

		held.resolve();
		await stale;
		const next = await step(hooks, { entries: fresh.entries, from: 1, walk: fresh.resume?.walk });

		expect(next.resume).toMatchObject({ next: 2, walk: fresh.resume?.walk });
		expect(seen).toEqual(["a", "b", "a", "b"]);
	});

	it.each([0.5, 1.5])("refuses a resume point that is not a whole index: from %s (review L6)", async (from) => {
		const hooks = await hooksOf([{ path: "/user/a.ts", factory: drafting("a", []) }]);
		const payload: JsonValue = toJson({ ...turnEnd, context: preview, entries: [], from, walk: "w" });

		await expect(hooks("turn_end", payload)).rejects.toThrow("malformed turn_end payload");
	});
});
