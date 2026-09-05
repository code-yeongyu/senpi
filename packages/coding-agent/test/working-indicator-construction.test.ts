import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("working indicator construction", () => {
	it("uses the configured chrome indicator without a duplicate fallback", () => {
		const source = readFileSync(
			resolve(import.meta.dirname, "../src/modes/interactive/interactive-mode.ts"),
			"utf8",
		);
		const method = source.match(/\tprivate setWorkingVisible\(visible: boolean\): void \{([\s\S]*?)\n\t\}\n\n\tprivate setWorkingIndicator/);
		expect(method).not.toBeNull();
		const body = method?.[1] ?? "";
		expect(body).toMatch(/this\.chrome\s*[\s\S]*?createWorkingIndicator/);
		expect(body.match(/this\.showStatusIndicator\(/g)).toHaveLength(1);
		expect(body).not.toMatch(/this\.showStatusIndicator\(\s*new WorkingStatusIndicator/);
	});
});
