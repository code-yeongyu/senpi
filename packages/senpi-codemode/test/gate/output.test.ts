import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { writeGateOutput } from "../../scripts/gate-output.ts";

it.each(["file", "directory"])("refuses a %s output symlink without changing its destination", async (kind) => {
	const root = await mkdtemp(join(tmpdir(), "senpi-gate-output-"));
	try {
		const outside = join(root, "outside");
		await mkdir(outside);
		await writeFile(join(outside, "report.json"), "original");
		const output = kind === "file" ? join(root, "report.json") : join(root, "linked/report.json");
		if (kind === "file") await symlink(join(outside, "report.json"), output);
		else await symlink(outside, join(root, "linked"), "junction");
		await expect(writeGateOutput(output, "replacement")).rejects.toThrow();
		expect(await readFile(join(outside, "report.json"), "utf8")).toBe("original");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("writes an ordinary requested output path", async () => {
	const root = await mkdtemp(join(tmpdir(), "senpi-gate-output-"));
	try {
		const output = join(root, "report.json");
		await writeGateOutput(output, "measured");
		expect(await readFile(output, "utf8")).toBe("measured");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
