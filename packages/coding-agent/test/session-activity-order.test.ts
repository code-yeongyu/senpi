import { describe, expect, it } from "vitest";
import { sortSessionInfos } from "../src/core/session-discovery.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";

// Node's readdir returns names sorted (libuv sorts its scandir result) and Bun's returns the filesystem's own order, so
// rows with the same activity time must not keep their listing order or the picker differs by runtime
// (code-yeongyu/senpi#5822). Sessions written back to back share a millisecond almost always.
const AT = new Date("2026-10-08T00:00:00Z");

function row(path: string, modified: Date = AT): SessionInfo {
	return {
		path,
		id: path,
		cwd: "/project",
		created: modified,
		modified,
		messageCount: 0,
		firstMessage: "(no messages)",
		allMessagesText: "",
	};
}

describe("the session picker orders rows the same on every runtime", () => {
	it("rows with the same activity time are ordered by path, whatever order the directory listed them in", () => {
		const listed = [row("/sessions/own.jsonl"), row("/sessions/moved.jsonl"), row("/sessions/b.jsonl")];

		expect(sortSessionInfos(listed).map((info) => info.path)).toEqual([
			"/sessions/b.jsonl",
			"/sessions/moved.jsonl",
			"/sessions/own.jsonl",
		]);
	});

	it("newer activity still comes first", () => {
		const listed = [row("/sessions/a.jsonl"), row("/sessions/z.jsonl", new Date("2026-10-09T00:00:00Z"))];

		expect(sortSessionInfos(listed).map((info) => info.path)).toEqual(["/sessions/z.jsonl", "/sessions/a.jsonl"]);
	});
});
