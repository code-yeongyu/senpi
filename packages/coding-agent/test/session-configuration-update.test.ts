import { describe, expect, it } from "vitest";
import { buildSessionContext, type SessionEntry } from "../src/core/session-manager.ts";

function entry(value: Partial<SessionEntry> & { type: string; id: string }, parentId: string | null): SessionEntry {
	return { timestamp: new Date(value.id.length + 1).toISOString(), parentId, ...value } as SessionEntry;
}

const branch: SessionEntry[] = [
	entry({ type: "thinking_level_change", id: "t1", thinkingLevel: "medium" } as never, null),
	entry({ type: "message", id: "u1", message: { role: "user", content: "first", timestamp: 1 } } as never, "t1"),
	entry({ type: "thinking_level_change", id: "t2", thinkingLevel: "high" } as never, "u1"),
	entry({ type: "configuration_update", id: "c1", reasoning: { effort: "high" } } as never, "t2"),
	entry({ type: "message", id: "u2", message: { role: "user", content: "second", timestamp: 2 } } as never, "c1"),
];

describe("session context configuration updates", () => {
	it("returns the latest configuration update so resume can restore the baseline", () => {
		expect(buildSessionContext(branch).configurationUpdate).toEqual({ effort: "high" });
	});

	it("projects the update into the message stream at its original position", () => {
		expect(buildSessionContext(branch).messages.map((message) => message.role)).toEqual([
			"user",
			"configurationUpdate",
			"user",
		]);
	});

	it("reports no configuration update for a branch that never changed effort", () => {
		expect(buildSessionContext(branch.slice(0, 2)).configurationUpdate).toBeUndefined();
	});
});
