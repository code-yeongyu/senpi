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

	it.each([".git/hooks", "node_modules/pkg", "artifacts/cell"])(
		"neither lists nor reads a tracked path whose directory now links to the excluded %s",
		async (excluded) => {
			const harness = writtenFilesHarness();
			const { workspace } = harness;
			workspace.write("lib/hidden.ts", "export const tracked = 1;\n");
			workspace.commit();

			const listed = await cellListing(harness, () => {
				workspace.write(`${excluded}/hidden.ts`, "export const excluded = 2;\n");
				workspace.link("lib", workspace.absolute(excluded));
			});

			expect({ listed, hooked: reportedPaths(harness) }).toEqual({ listed: undefined, hooked: [] });
			expect(workspace.reads).not.toContain(workspace.absolute(`${excluded}/hidden.ts`));
		},
	);

	it("reads nothing when the last entry is swapped for a link out of the workspace after it was checked", async () => {
		const harness = writtenFilesHarness();
		const { workspace } = harness;
		workspace.write("src/swapped.ts", "export const value = 1;\n");
		workspace.commit();
		const outsideFile = join(OUTSIDE, "swapped.ts");
		workspace.writeAt(outsideFile, "export const outside = 'not the workspace';\n");
		workspace.beforeOpen = () => {
			workspace.beforeOpen = undefined;
			workspace.linkFile("src/swapped.ts", outsideFile);
		};

		const listed = await cellListing(harness, () => workspace.write("src/swapped.ts", "export const value = 2;\n"));

		expect({ listed, hooked: reportedPaths(harness) }).toEqual({ listed: undefined, hooked: [] });
		expect(workspace.reads).not.toContain(outsideFile);
	});

	// Third review findings: an excluded directory under another spelling, a path the index dropped, a moved file.
	it.each([
		["NODE_MODULES/pkg", "node_modules/pkg"],
		[".GIT/hooks", ".git/hooks"],
	])(
		"neither lists nor reads a tracked path whose directory links to %s on a case-insensitive filesystem",
		async (spelled, real) => {
			const harness = writtenFilesHarness();
			const { workspace } = harness;
			workspace.caseInsensitive = true;
			workspace.write("lib/hidden.ts", "export const tracked = 1;\n");
			workspace.commit();

			const listed = await cellListing(harness, () => {
				workspace.write(`${real}/hidden.ts`, "export const excluded = 2;\n");
				workspace.link("lib", workspace.absolute(spelled));
			});

			expect({ listed, hooked: reportedPaths(harness), reads: workspace.reads }).toEqual({
				listed: undefined,
				hooked: [],
				reads: [],
			});
		},
	);

	it.each(["NODE_MODULES/pkg", ".GIT/hooks"])(
		"lists a path below %s as an ordinary directory on a case-sensitive filesystem",
		async (spelled) => {
			const harness = writtenFilesHarness();
			const { workspace } = harness;
			workspace.write("lib/hidden.ts", "export const tracked = 1;\n");
			workspace.commit();

			const listed = await cellListing(harness, () => {
				workspace.write(`${spelled}/hidden.ts`, "export const ordinary = 2;\n");
				workspace.link("lib", workspace.absolute(spelled));
			});

			expect(listed).toEqual([`${spelled}/hidden.ts`, "lib/hidden.ts"]);
			expect(reportedPaths(harness)).toEqual([
				workspace.absolute(`${spelled}/hidden.ts`),
				workspace.absolute("lib/hidden.ts"),
			]);
		},
	);

	it.each([
		["before the cell", false],
		["inside the cell, after it was modified", true],
	])(
		"drops a file taken out of the index %s, then ignored and rewritten, and still reports a file restored to HEAD",
		async (_when, insideCell) => {
			const harness = writtenFilesHarness();
			const { workspace } = harness;
			const committed = "export const value = 1;\n";
			workspace.write("src/restored.ts", committed);
			workspace.write("src/removed.ts", "export const removed = 1;\n");
			workspace.commit();
			workspace.write("src/restored.ts", "export const value = 2;\n");
			if (insideCell) workspace.write("src/removed.ts", "export const removed = 2;\n");
			else workspace.untrack("src/removed.ts");

			const listed = await cellListing(harness, () => {
				if (insideCell) workspace.untrack("src/removed.ts");
				workspace.ignore("src/removed.ts");
				workspace.write("src/removed.ts", "export const removed = 3;\n");
				workspace.write("src/restored.ts", committed);
			});

			expect(listed).toEqual(["src/restored.ts"]);
			expect(reportedPaths(harness)).toEqual([workspace.absolute("src/restored.ts")]);
		},
	);

	it("reads nothing when the checked file moves out and a last-entry link to that same file replaces it", async () => {
		const harness = writtenFilesHarness();
		const { workspace } = harness;
		workspace.write("src/moved.ts", "export const value = 1;\n");
		workspace.commit();
		const outsideFile = join(OUTSIDE, "moved.ts");
		workspace.beforeOpen = () => {
			workspace.beforeOpen = undefined;
			workspace.moveOut("src/moved.ts", outsideFile);
			workspace.linkFile("src/moved.ts", outsideFile);
		};

		const listed = await cellListing(harness, () => workspace.write("src/moved.ts", "export const value = 2;\n"));

		expect({ listed, hooked: reportedPaths(harness), reads: workspace.reads }).toEqual({
			listed: undefined,
			hooked: [],
			reads: [],
		});
	});

	it("drops an untracked file the cell ignores and rewrites, and still reports a tracked file restored to HEAD", async () => {
		const harness = writtenFilesHarness();
		const { workspace } = harness;
		const committed = "export const value = 1;\n";
		workspace.write("src/restored.ts", committed);
		workspace.commit();
		workspace.write("src/restored.ts", "export const value = 2;\n");
		workspace.write("src/generated.ts", "export const generated = 1;\n");

		const listed = await cellListing(harness, () => {
			workspace.ignore("src/generated.ts");
			workspace.write("src/generated.ts", "export const generated = 2;\n");
			workspace.write("src/restored.ts", committed);
		});

		expect(listed).toEqual(["src/restored.ts"]);
		expect(reportedPaths(harness)).toEqual([workspace.absolute("src/restored.ts")]);
	});
});
