import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";

// oh-my-openagent#10782: standalone process children need the hosted ancestry contract.
describe("--spawned-by parsing", () => {
	const ancestry = { parentSessionId: "parent", rootSessionId: "root", taskId: "task" };

	it("parses one JSON object without consuming the prompt", () => {
		const parsed = parseArgs(["--spawned-by", JSON.stringify(ancestry), "hello"]);
		expect(parsed).toMatchObject({ spawnedBy: ancestry, messages: ["hello"], diagnostics: [] });
		expect(parsed.unknownFlags.size).toBe(0);
	});

	it.each([
		"{",
		"null",
		"[]",
		"true",
		'"parent:root:task"',
		"{}",
		...Object.keys(ancestry).flatMap((key) =>
			[undefined, "", 1, null].map((value) => JSON.stringify({ ...ancestry, [key]: value })),
		),
	])("rejects malformed ancestry %s", (value) => {
		const parsed = parseArgs(["--spawned-by", value]);
		expect(parsed.diagnostics).toEqual([expect.objectContaining({ type: "error" })]);
		expect(parsed).not.toHaveProperty("spawnedBy");
	});

	it.each([{ remaining: [] }, { remaining: ["--offline"] }])(
		"rejects a missing value before $remaining",
		({ remaining }) => {
			const parsed = parseArgs(["--spawned-by", ...remaining]);
			expect(parsed.diagnostics).toEqual([expect.objectContaining({ type: "error" })]);
			if (remaining.length > 0) expect(parsed.offline).toBe(true);
		},
	);
});
