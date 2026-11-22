import { appendFileSync, closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAtMost } from "../src/tool/load-cell.ts";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fileWith(content: string): string {
	const dir = mkdtempSync(join(tmpdir(), "senpi-bounded-read-"));
	dirs.push(dir);
	const path = join(dir, "f.py");
	writeFileSync(path, content);
	return path;
}

describe("Given a %load file read through one handle", () => {
	it("When the file grows after it was checked, then the read stops one byte past the limit", () => {
		const path = fileWith("x".repeat(10));
		const fd = openSync(path, "r");
		try {
			appendFileSync(path, "y".repeat(100));

			const bytes = readAtMost(fd, 21);

			expect(bytes.length).toBe(21);
		} finally {
			closeSync(fd);
		}
	});

	it("When the file is shorter than the limit, then the whole file is read", () => {
		const path = fileWith("print('ok')\n");
		const fd = openSync(path, "r");
		try {
			expect(readAtMost(fd, 1024).toString("utf8")).toBe("print('ok')\n");
		} finally {
			closeSync(fd);
		}
	});
});
