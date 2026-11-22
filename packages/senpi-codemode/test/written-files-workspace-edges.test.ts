import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { type WrittenFilesHarness, writtenFilesHarness } from "./eval/written-files-fakes.ts";

const OUTSIDE = sep === "/" ? "/elsewhere" : "C:\\elsewhere";

/** Runs `work` as one cell's writes and returns what the cell would list. */
async function cellListing(harness: WrittenFilesHarness, work: () => void): Promise<readonly string[] | undefined> {
	const cell = harness.writtenFiles.open(harness.ctx);
	await cell.ready;
	work();
	const outcome = await cell.settle(new AbortController().signal);
	cell.close();
	return outcome?.kind === "written" ? outcome.report.files : undefined;
}

function reportedPaths(harness: WrittenFilesHarness): unknown[] {
	return harness.reported.map((report) => report.input.path);
}

// senpi#7232 review findings: what git reports is checked against the filesystem before a file is listed or read.
describe("written files at the edges of the workspace", () => {
	it("neither lists, reads nor hooks a tracked path whose directory now links outside the workspace", async () => {
		const harness = writtenFilesHarness();
		const { workspace } = harness;
		workspace.write("lib/secret.ts", "export const tracked = 1;\n");
		workspace.commit();
		const outsideFile = join(OUTSIDE, "secret.ts");
		workspace.writeAt(outsideFile, "export const outside = 'not the workspace';\n");

		const listed = await cellListing(harness, () => workspace.link("lib", OUTSIDE));

		expect({ listed, hooked: reportedPaths(harness) }).toEqual({ listed: undefined, hooked: [] });
		expect(workspace.reads).not.toContain(outsideFile);
	});

	it("lists a tracked path whose directory now links to another directory of the workspace", async () => {
		const harness = writtenFilesHarness();
		const { workspace } = harness;
		workspace.write("lib/moved.ts", "export const tracked = 1;\n");
		workspace.commit();

		const listed = await cellListing(harness, () => {
			workspace.write("vendor/lib/moved.ts", "export const moved = 2;\n");
			workspace.link("lib", workspace.absolute("vendor/lib"));
		});

		expect(listed).toEqual(["lib/moved.ts", "vendor/lib/moved.ts"]);
		expect(reportedPaths(harness)).toEqual([
			workspace.absolute("lib/moved.ts"),
			workspace.absolute("vendor/lib/moved.ts"),
		]);
	});

	it("lists and hooks once a modified tracked file the cell writes back to its committed content", async () => {
		const harness = writtenFilesHarness();
		const { workspace } = harness;
		const committed = "export const value = 1;\n";
		workspace.write("src/restored.ts", committed);
		workspace.commit();
		workspace.write("src/restored.ts", "export const value = 2;\n");

		const listed = await cellListing(harness, () => workspace.write("src/restored.ts", committed));

		expect(listed).toEqual(["src/restored.ts"]);
		expect(harness.reported.map((report) => report.input)).toEqual([
			{ path: workspace.absolute("src/restored.ts"), content: committed },
		]);
	});

	it("does not list a modified tracked file the cell deletes", async () => {
		const harness = writtenFilesHarness();
		const { workspace } = harness;
		workspace.write("src/deleted.ts", "export const value = 1;\n");
		workspace.commit();
		workspace.write("src/deleted.ts", "export const value = 2;\n");

		const listed = await cellListing(harness, () => workspace.remove("src/deleted.ts"));

		expect({ listed, hooked: reportedPaths(harness) }).toEqual({ listed: undefined, hooked: [] });
	});
});
