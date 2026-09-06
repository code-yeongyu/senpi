import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createConversationRotationStore,
	isZeroTokenResourceExhausted,
	MAX_CURSOR_CONVERSATION_ROTATIONS,
	resolveConversationRotationPersistPath,
} from "../src/api/cursor-conversation-rotation.ts";

function storePath(): string {
	return join(mkdtempSync(join(tmpdir(), "cursor-rotate-")), "cursor-conversation-ids.json");
}

describe("cursor conversation rotation", () => {
	it("retries a zero-token resource_exhausted with a new wire id", () => {
		const persistPath = storePath();
		const ids = ["rot-1", "rot-2", "rot-3"];
		const store = createConversationRotationStore({
			persistPath,
			randomId: () => ids.shift() ?? "overflow",
		});
		expect(store.getWireId("session-a")).toBe("session-a");
		const first = store.recordZeroTokenPoison("session-a", "session-a");
		expect(first).toEqual({ kind: "rotated", wireId: "rot-1" });
		expect(store.getWireId("session-a")).toBe("rot-1");
	});

	it("loads the last wire id from disk after a new store is created", () => {
		const persistPath = storePath();
		const first = createConversationRotationStore({
			persistPath,
			randomId: () => "persisted-wire",
		});
		first.recordZeroTokenPoison("session-b", "session-b");
		const reloaded = createConversationRotationStore({ persistPath, randomId: () => "unused" });
		expect(reloaded.getWireId("session-b")).toBe("persisted-wire");
		expect(JSON.parse(readFileSync(persistPath, "utf8"))["session-b"].wireId).toBe("persisted-wire");
	});

	it("stops minting ids after three rotations and ignores token-evidence RE", () => {
		const persistPath = storePath();
		let n = 0;
		const store = createConversationRotationStore({
			persistPath,
			randomId: () => `rot-${++n}`,
		});
		expect(store.recordZeroTokenPoison("session-c", "session-c").kind).toBe("rotated");
		expect(store.recordZeroTokenPoison("session-c", "rot-1").kind).toBe("rotated");
		expect(store.recordZeroTokenPoison("session-c", "rot-2").kind).toBe("rotated");
		expect(store.recordZeroTokenPoison("session-c", "rot-3")).toEqual({ kind: "exhausted" });
		expect(n).toBe(MAX_CURSOR_CONVERSATION_ROTATIONS);
		expect(store.shouldSkip("session-c")).toBe(true);
		const reopened = store.getWireId("session-c");
		expect(reopened).not.toBe("rot-3");
		expect(store.shouldSkip("session-c")).toBe(false);
		expect(isZeroTokenResourceExhausted("Connect error resource_exhausted: Error", true)).toBe(false);
		expect(isZeroTokenResourceExhausted("Connect error resource_exhausted: Error", false)).toBe(true);
	});

	it("persists under the agent dir, not $HOME", () => {
		expect(resolveConversationRotationPersistPath({ HOME: "/home/u" })).toBe(
			"/home/u/.senpi/agent/cursor-conversation-ids.json",
		);
		expect(
			resolveConversationRotationPersistPath({
				HOME: "/home/u",
				CODING_AGENT_DIR: "/home/u/.omo/agent",
			}),
		).toBe("/home/u/.omo/agent/cursor-conversation-ids.json");
		expect(
			resolveConversationRotationPersistPath({
				HOME: "/home/u",
				CURSOR_CONVERSATION_ID_STORE: "/tmp/store.json",
			}),
		).toBe("/tmp/store.json");
	});

	it("bounds the number of retained records, dropping the oldest first (#1024)", () => {
		const persistPath = storePath();
		const store = createConversationRotationStore({
			persistPath,
			randomId: () => `wire-${Math.random()}`,
			maxRecords: 3,
		});
		for (const baseId of ["rec-1", "rec-2", "rec-3", "rec-4", "rec-5"]) {
			store.markSurfaced(baseId, baseId);
		}
		expect(store.recordCount()).toBe(3);
		expect(store.shouldSurfaceBeforeRotating("rec-1")).toBe(true);
		expect(store.shouldSurfaceBeforeRotating("rec-2")).toBe(true);
		// The oldest records were trimmed from memory and from the persisted file.
		const persisted = JSON.parse(readFileSync(persistPath, "utf8")) as Record<string, unknown>;
		expect(Object.keys(persisted).sort()).toEqual(["rec-3", "rec-4", "rec-5"]);
	});
});
