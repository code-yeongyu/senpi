import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TASK_MANAGEMENT_SECTION } from "../../src/core/extensions/builtin/todotools/prompt.js";

const TASK_MANAGEMENT_SECTION_FIXTURE_PATH = fileURLToPath(
	new URL("./fixtures/task-management-section.txt", import.meta.url),
);

describe("TASK_MANAGEMENT_SECTION golden snapshot", () => {
	it("matches the committed fixture byte-for-byte", () => {
		const fixtureBytes = readFileSync(TASK_MANAGEMENT_SECTION_FIXTURE_PATH);
		const currentBytes = Buffer.from(TASK_MANAGEMENT_SECTION, "utf8");

		expect(currentBytes).toEqual(fixtureBytes);
	});
});
