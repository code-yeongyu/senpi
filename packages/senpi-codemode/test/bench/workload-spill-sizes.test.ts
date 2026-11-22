import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { largestSpill, spillCandidates } from "../../scripts/bench-scenarios-workload.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sessionWith(files: Record<string, number>): { root: string; paths: string[] } {
	const root = mkdtempSync(join(tmpdir(), "codemode-spill-"));
	roots.push(root);
	mkdirSync(join(root, "kernels"));
	const paths = Object.entries(files).map(([name, size]) => {
		const path = join(root, name);
		writeFileSync(path, "x".repeat(size));
		return path;
	});
	return { root, paths };
}

describe("output-spill candidates (codemode-gate race on main 46d15a1c93)", () => {
	it("never stats a kernel temp file, which the kernel can rename away between listing and stat", async () => {
		// Listed, then renamed by the kernel before the bench stats it: the original race.
		const { root, paths } = sessionWith({ "spill.txt": 10 });
		const vanished = join(root, "kernels", "py-globals.json.4242.tmp");
		expect(await largestSpill([...paths, vanished])).toBe(paths[0]);
	});

	it("never picks a temp file as the spill even when it exists and is the largest", async () => {
		// The narrower race: a temp file that wins the size pick could still be renamed before readFile.
		const { paths } = sessionWith({ "spill.txt": 10, "kernels/py-globals.json.4242.tmp": 100 });
		expect(spillCandidates(paths)).toEqual([paths[0]]);
		expect(await largestSpill(paths)).toBe(paths[0]);
	});

	it("still fails when a final path cannot be stat'ed", async () => {
		await expect(largestSpill(["\0bad"])).rejects.toThrow();
	});
});
