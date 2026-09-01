import { describe, expect, it } from "vitest";
import { type CustomEntry, SessionManager } from "../../../src/core/session-manager.ts";

function customEntry(id: string, parentId: string | null, revision: number): CustomEntry {
	return {
		type: "custom",
		customType: "duplicate-id-regression",
		data: { revision },
		id,
		parentId,
		timestamp: `2026-09-01T00:00:0${revision}.000Z`,
	};
}

describe("issue #1247 duplicate session entry IDs", () => {
	it("builds one tree node per entry ID when persisted rows repeat", () => {
		// Given: a persisted-style chain where the same child ID appears twice.
		const session = SessionManager.inMemory();
		session.appendEntry(customEntry("root", null, 0));
		session.appendEntry(customEntry("child", "root", 1));
		session.appendEntry(customEntry("child", "root", 2));
		session.appendEntry(customEntry("grandchild", "child", 3));

		// When: the session tree is constructed.
		const tree = session.getTree();

		// Then: the last row for the duplicate ID wins without adding duplicate edges.
		expect(tree).toHaveLength(1);
		expect(tree[0]?.entry.id).toBe("root");
		expect(tree[0]?.children.map((node) => node.entry.id)).toEqual(["child"]);
		expect(tree[0]?.children[0]?.entry).toMatchObject({
			id: "child",
			data: { revision: 2 },
		});
		expect(tree[0]?.children[0]?.children.map((node) => node.entry.id)).toEqual(["grandchild"]);
	});
});
