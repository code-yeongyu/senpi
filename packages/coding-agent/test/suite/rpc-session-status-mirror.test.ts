import { describe, expect, it, vi } from "vitest";
import type { SessionStatusEntryView } from "../../src/modes/rpc/session-status.ts";
import { MAX_SUBSCRIPTIONS_PER_CONNECTION, SessionStatusStream } from "../../src/modes/rpc/session-status-stream.ts";

describe("session status mirror view cost", () => {
	it("does not rebuild a view per delta when subscribers do not request mirroring", () => {
		// Given: a status-only subscription has already received its snapshot.
		const entry: SessionStatusEntryView = {
			state: "open",
			kind: "interactive",
			cwd: "/test",
			attachments: 1,
			context: {},
		};
		const view = vi.fn(() => ({ entry }));
		const entryView = vi.fn(() => entry);
		const stream = new SessionStatusStream({ enqueue: () => true, pendingQuestions: () => 0 });
		stream.setSource({ sessionIds: () => ["rpc-1"], view, entryView });
		stream.subscribe("observer", {
			selector: { kind: "all" },
			includeWorkers: false,
			includeContext: false,
			mirror: { kind: "none" },
			effects: false,
		});
		view.mockClear();
		entryView.mockClear();

		// When: the writer asks for destinations for successive content deltas.
		const targets = Array.from({ length: 3 }, () => stream.mirrorTargets("rpc-1", "message_update"));

		// Then: neither the runtime nor the entry view is rebuilt.
		expect(targets).toEqual([[], [], []]);
		expect(view).not.toHaveBeenCalled();
		expect(entryView).not.toHaveBeenCalled();
	});

	it("matches mirrored deltas using only the current entry view", () => {
		// Given: a child selector reads the live entry view, whose frozen open context names the
		// parent - never the published (patchable) context the status stream shows subscribers.
		const entry: SessionStatusEntryView = {
			state: "open",
			kind: "worker",
			cwd: "/test",
			attachments: 1,
			context: { parent_session_id: "old-parent" },
			openContext: { parent_session_id: "new-parent" },
		};
		const view = vi.fn(() => ({ entry }));
		const entryView = vi.fn(() => entry);
		const stream = new SessionStatusStream({ enqueue: () => true, pendingQuestions: () => 0 });
		stream.setSource({ sessionIds: () => ["rpc-1"], view, entryView });
		stream.subscribe("observer", {
			selector: { kind: "childrenOf", parent: "new-parent" },
			includeWorkers: true,
			includeContext: false,
			mirror: { kind: "types", types: new Set(["message_update"]) },
			effects: false,
		});
		view.mockClear();

		// When: a matching content delta arrives.
		const targets = stream.mirrorTargets("rpc-1", "message_update");

		// Then: live entry context routes it without building runtime state.
		expect(targets).toEqual(["observer"]);
		expect(view).not.toHaveBeenCalled();
		expect(entryView).toHaveBeenCalledOnce();
	});
});

describe("publish with no subscribers (#3198 review, L3)", () => {
	it("does not build a runtime view when there are no subscriptions, but a later snapshot is still right", () => {
		// Given: a session whose view is expensive to build, and nobody subscribed.
		const entry: SessionStatusEntryView = {
			state: "open",
			kind: "interactive",
			cwd: "/test",
			attachments: 1,
			context: {},
		};
		const view = vi.fn(() => ({ entry }));
		const stream = new SessionStatusStream({ enqueue: () => true, pendingQuestions: () => 0 });
		stream.setSource({ sessionIds: () => ["rpc-1"], view, entryView: () => entry });

		// When: a change is published with zero subscriptions, then another with a live one.
		stream.publish("rpc-1", "prompt", "agent");
		const afterIdlePublish = view.mock.calls.length;
		const sub = stream.subscribe("observer", {
			selector: { kind: "all" },
			includeWorkers: false,
			includeContext: false,
			mirror: { kind: "none" },
			effects: false,
		});

		// Then: the no-subscriber publish never built a view (L3's hot path), yet the snapshot a later
		// subscriber receives still reflects the session's real current state.
		expect(afterIdlePublish).toBe(0);
		expect(sub.snapshot).toHaveLength(1);
		expect(sub.snapshot[0]).toMatchObject({ sessionId: "rpc-1", seq: 0, status: "opening" });
		// And: lastChanges recorded the earlier publish, so the snapshot's lastChange is not invented.
		expect(sub.snapshot[0]!.lastChange).toMatchObject({ cause: "prompt", by: "agent" });
	});
});

describe("subscriptions per connection cap (#3198 review, L4)", () => {
	it("counts pending and live subscriptions per connection, bounded at MAX_SUBSCRIPTIONS_PER_CONNECTION", () => {
		const stream = new SessionStatusStream({ enqueue: () => true, pendingQuestions: () => 0 });
		stream.setSource({ sessionIds: () => [], view: () => undefined, entryView: () => undefined });
		const options = {
			selector: { kind: "all" as const },
			includeWorkers: false,
			includeContext: false,
			mirror: { kind: "none" as const },
			effects: false,
		};
		// Given: one connection fills every slot (pending until activation, like the real path).
		for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_CONNECTION; i++) stream.subscribe("c", options);
		expect(stream.connectionSize("c")).toBe(MAX_SUBSCRIPTIONS_PER_CONNECTION);
		// Activating them keeps the count (pending -> live), another connection is unaffected.
		expect(stream.connectionSize("other")).toBe(0);
		// Dropping the connection frees every slot.
		stream.dropConnection("c");
		expect(stream.connectionSize("c")).toBe(0);
	});
});
