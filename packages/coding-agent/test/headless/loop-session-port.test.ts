// senpi#6754 (review L2 on #6762): a headless session commits a hand's session writes all or nothing, as far as its
// append-only log allows. Everything is checked first; if an entry fails, the error names the entries that landed and
// nothing else is applied; if a later step fails, the active set is restored.
import type { AgentToolCall } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { SessionEffects } from "../../src/core/hand/session-effects.ts";
import {
	createLoopSessionPort,
	type LoopPortSession,
	SessionCommitError,
} from "../../src/modes/headless/loop-session-port.ts";

const CALL: AgentToolCall = { type: "toolCall", id: "c1", name: "todo", arguments: {} };

function fakeSession(options: { readonly failAppendAt?: number; readonly failNotify?: boolean }) {
	const record = { entries: [] as string[], active: ["read"], sent: 0, activeChanges: 0 };
	const session = {
		sessionId: "s1",
		isStreaming: false,
		getActiveToolNames: () => [...record.active],
		setActiveToolsByName: (names: string[]) => {
			record.activeChanges += 1;
			record.active = [...names];
		},
		appendCustomSessionEntry: (customType: string) => {
			if (record.entries.length === options.failAppendAt) throw new Error("disk full");
			record.entries.push(customType);
			return `id-${record.entries.length}`;
		},
		sendCustomMessage: async () => {
			record.sent += 1;
		},
		sendUserMessage: async () => {
			record.sent += 1;
		},
		extensionRunner: {
			getUIContext: () => ({
				notify: () => {
					if (options.failNotify === true) throw new Error("ui gone");
				},
			}),
		},
		sessionManager: { getBranch: () => [], getLeafId: () => null, getHeader: () => null },
	};
	return { record, port: createLoopSessionPort(session as unknown as LoopPortSession) };
}

const WRITES: SessionEffects = {
	entries: [{ customType: "a" }, { customType: "b" }],
	activeTools: { activate: ["todo"], deactivate: [] },
	sent: [{ message: { customType: "m", content: "hi", display: true } }],
	notices: [{ message: "saved" }],
};

describe("a headless session commits a hand's writes all or nothing (senpi#6754)", () => {
	it("an entry that fails stops the commit, names what landed, and applies nothing else", () => {
		const { record, port } = fakeSession({ failAppendAt: 1 });

		const failure = (() => {
			try {
				port.commit(CALL, WRITES);
			} catch (error) {
				return error;
			}
		})();

		expect(failure).toBeInstanceOf(SessionCommitError);
		expect((failure as SessionCommitError).landedEntryIds).toEqual(["id-1"]);
		expect(record).toEqual({ entries: ["a"], active: ["read"], sent: 0, activeChanges: 0 });
	});

	it("a later step that fails restores the active set the session had", () => {
		const { record, port } = fakeSession({ failNotify: true });

		expect(() => port.commit(CALL, WRITES)).toThrow(SessionCommitError);
		expect(record.entries).toEqual(["a", "b"]);
		expect(record.active).toEqual(["read"]);
	});
});
