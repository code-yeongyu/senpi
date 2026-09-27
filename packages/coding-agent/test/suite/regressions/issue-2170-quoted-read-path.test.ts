import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveReadPath, resolveReadPathAsync } from "../../../src/core/tools/path-utils.ts";

// senpi#2170: Windows Explorer "Copy as path" wraps the path in double quotes.
describe("senpi#2170 quoted read paths", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "issue-2170-quoted-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("resolves an absolute path wrapped in double quotes to the file itself", async () => {
		const file = join(dir, "aaa.png");
		writeFileSync(file, "png");

		expect(resolveReadPath(`"${file}"`, "/unrelated/cwd")).toBe(file);
		expect(await resolveReadPathAsync(`"${file}"`, "/unrelated/cwd")).toBe(file);
		expect(await resolveReadPathAsync(`@"${file}"`, "/unrelated/cwd")).toBe(file);
		expect(await resolveReadPathAsync(`'${file}'`, "/unrelated/cwd")).toBe(file);
	});

	it.skipIf(process.platform === "win32")("prefers a file whose name really contains the quotes", async () => {
		writeFileSync(join(dir, '"quoted.txt"'), "literal");
		writeFileSync(join(dir, "quoted.txt"), "unquoted");

		expect(await resolveReadPathAsync('"quoted.txt"', dir)).toBe(join(dir, '"quoted.txt"'));
	});
});
