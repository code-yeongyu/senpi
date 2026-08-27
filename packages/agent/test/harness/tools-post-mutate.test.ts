import { rmSync } from "node:fs";
import { symlink } from "node:fs/promises";
import { applyPatch } from "diff";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { createEditTool } from "../../src/harness/tools/edit.ts";
import type { PostMutateContext, PostMutateResult } from "../../src/harness/tools/tool-context.ts";
import { createWriteTool } from "../../src/harness/tools/write.ts";
import { getOrThrow } from "../../src/harness/types.ts";
import { createTempDir } from "./session-test-utils.ts";

function textOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("\n");
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function createEnv(): NodeExecutionEnv {
	return new NodeExecutionEnv({ cwd: createTempDir() });
}

describe("AgentHarness tools postMutate", () => {
	it("calls postMutate with the resolved absolute path and appends its note to write output", async () => {
		const env = createEnv();
		const calls: PostMutateContext[] = [];
		const result = await createWriteTool().execute(
			"write-post-mutate",
			{ path: "nested/file.txt", content: "hello" },
			undefined,
			undefined,
			{
				env,
				postMutate: async (input) => {
					calls.push(input);
					return { changed: false, note: "formatted with biome" };
				},
			},
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.path).toBe(getOrThrow(await env.absolutePath("nested/file.txt")));
		expect(calls[0]?.tool).toBe("write");
		expect(textOutput(result)).toBe("Successfully wrote 5 bytes to nested/file.txt\nformatted with biome");
	});

	it("observes the freshly written bytes from inside postMutate", async () => {
		const env = createEnv();
		let observed: string | undefined;
		await createWriteTool().execute(
			"write-post-mutate-read",
			{ path: "file.txt", content: "written-bytes" },
			undefined,
			undefined,
			{
				env,
				postMutate: async (input) => {
					observed = getOrThrow(await env.readTextFile(input.path));
					return { changed: false };
				},
			},
		);

		expect(observed).toBe("written-bytes");
	});

	it("hands the hook the path the tool wrote, not the canonical target, when editing through a symlink", async () => {
		const env = createEnv();
		getOrThrow(await env.writeFile("target.txt", "alpha\nbeta\n"));
		await symlink("target.txt", `${env.cwd}/link.txt`);
		const seen: string[] = [];

		await createEditTool().execute(
			"edit-post-mutate-symlink",
			{ path: "link.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] },
			undefined,
			undefined,
			{
				env,
				postMutate: async (input) => {
					seen.push(input.path);
					return { changed: false };
				},
			},
		);

		expect(seen).toEqual([getOrThrow(await env.absolutePath("link.txt"))]);
		expect(getOrThrow(await env.readTextFile("target.txt"))).toBe("ALPHA\nbeta\n");
	});

	it("recomputes edit diff metadata against the post-mutate file contents", async () => {
		const env = createEnv();
		const original = "alpha\nbeta\ngamma\n";
		getOrThrow(await env.writeFile("edit.txt", original));

		const result = await createEditTool().execute(
			"edit-post-mutate",
			{ path: "edit.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] },
			undefined,
			undefined,
			{
				env,
				postMutate: async (input) => {
					const current = getOrThrow(await env.readTextFile(input.path));
					getOrThrow(await env.writeFile(input.path, current.replace("gamma", "GAMMA")));
					return { changed: true, note: "auto-formatted edit.txt" };
				},
			},
		);

		const onDisk = getOrThrow(await env.readTextFile("edit.txt"));
		expect(onDisk).toBe("ALPHA\nbeta\nGAMMA\n");
		expect(result.details?.diff).toContain("GAMMA");
		expect(applyPatch(original, result.details?.patch ?? "")).toBe(onDisk);
		expect(textOutput(result)).toBe("Successfully replaced 1 block(s) in edit.txt.\nauto-formatted edit.txt");
	});

	it("keeps edit diff metadata unchanged when postMutate reports no change", async () => {
		const env = createEnv();
		const original = "alpha\nbeta\n";
		getOrThrow(await env.writeFile("edit.txt", original));

		const result = await createEditTool().execute(
			"edit-post-mutate-unchanged",
			{ path: "edit.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] },
			undefined,
			undefined,
			{ env, postMutate: async () => ({ changed: false }) },
		);

		expect(applyPatch(original, result.details?.patch ?? "")).toBe("ALPHA\nbeta\n");
		expect(textOutput(result)).toBe("Successfully replaced 1 block(s) in edit.txt.");
	});

	it("runs postMutate inside the mutation queue so same-path mutations stay serialized", async () => {
		const env = createEnv();
		const events: string[] = [];
		const firstHookEntered = deferred();
		const releaseFirstHook = deferred();
		const tool = createWriteTool();
		const context = {
			env,
			postMutate: async (input: PostMutateContext): Promise<PostMutateResult> => {
				const content = getOrThrow(await env.readTextFile(input.path));
				events.push(`hook-start:${content}`);
				if (content === "first") {
					firstHookEntered.resolve();
					await releaseFirstHook.promise;
				}
				events.push(`hook-end:${content}`);
				return { changed: false };
			},
		};

		const first = tool.execute("write-a", { path: "file.txt", content: "first" }, undefined, undefined, context);
		await firstHookEntered.promise;
		const second = tool.execute("write-b", { path: "file.txt", content: "second" }, undefined, undefined, context);
		releaseFirstHook.resolve();
		await Promise.all([first, second]);

		expect(events).toEqual(["hook-start:first", "hook-end:first", "hook-start:second", "hook-end:second"]);
		expect(getOrThrow(await env.readTextFile("file.txt"))).toBe("second");
	});

	it("surfaces a throwing postMutate as a warning note without losing the landed write", async () => {
		const env = createEnv();
		const result = await createWriteTool().execute(
			"write-post-mutate-throws",
			{ path: "file.txt", content: "payload" },
			undefined,
			undefined,
			{
				env,
				postMutate: async () => {
					throw new Error("formatter exploded");
				},
			},
		);

		expect(getOrThrow(await env.readTextFile("file.txt"))).toBe("payload");
		expect(textOutput(result)).toBe(
			"Successfully wrote 7 bytes to file.txt\npostMutate hook failed: formatter exploded",
		);
	});

	it("surfaces a throwing postMutate as a warning note without losing the landed edit", async () => {
		const env = createEnv();
		getOrThrow(await env.writeFile("edit.txt", "alpha\nbeta\n"));

		const result = await createEditTool().execute(
			"edit-post-mutate-throws",
			{ path: "edit.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] },
			undefined,
			undefined,
			{
				env,
				postMutate: async () => {
					throw new Error("formatter exploded");
				},
			},
		);

		expect(getOrThrow(await env.readTextFile("edit.txt"))).toBe("ALPHA\nbeta\n");
		expect(textOutput(result)).toBe(
			"Successfully replaced 1 block(s) in edit.txt.\npostMutate hook failed: formatter exploded",
		);
		expect(result.details?.diff).toContain("ALPHA");
	});

	it("reports the on-disk bytes when postMutate rewrites the file and then throws", async () => {
		const env = createEnv();
		const original = "alpha\nbeta\ngamma\n";
		getOrThrow(await env.writeFile("edit.txt", original));

		const result = await createEditTool().execute(
			"edit-post-mutate-partial",
			{ path: "edit.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] },
			undefined,
			undefined,
			{
				env,
				postMutate: async (input) => {
					const current = getOrThrow(await env.readTextFile(input.path));
					getOrThrow(await env.writeFile(input.path, current.replace("gamma", "GAMMA")));
					throw new Error("formatter exploded after writing");
				},
			},
		);

		const onDisk = getOrThrow(await env.readTextFile("edit.txt"));
		expect(onDisk).toBe("ALPHA\nbeta\nGAMMA\n");
		expect(applyPatch(original, result.details?.patch ?? "")).toBe(onDisk);
		expect(textOutput(result)).toBe(
			"Successfully replaced 1 block(s) in edit.txt.\npostMutate hook failed: formatter exploded after writing",
		);
	});

	it("keeps the landed edit result when the post-mutate re-read fails", async () => {
		const env = createEnv();
		getOrThrow(await env.writeFile("edit.txt", "alpha\nbeta\n"));

		const result = await createEditTool().execute(
			"edit-post-mutate-reread-fails",
			{ path: "edit.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] },
			undefined,
			undefined,
			{
				env,
				postMutate: async (input) => {
					rmSync(input.path);
					return { changed: true, note: "replaced the file with nothing" };
				},
			},
		);

		expect(textOutput(result)).toBe(
			"Successfully replaced 1 block(s) in edit.txt.\nreplaced the file with nothing\npostMutate left the file unreadable: not_found. Reported diff describes the edit before the hook ran.",
		);
		expect(result.details?.diff).toContain("ALPHA");
	});

	it("forwards the abort signal to postMutate and aborts the write when the hook observes it", async () => {
		const env = createEnv();
		const controller = new AbortController();
		let receivedSignal: AbortSignal | undefined;

		const pending = createWriteTool().execute(
			"write-post-mutate-abort",
			{ path: "file.txt", content: "payload" },
			controller.signal,
			undefined,
			{
				env,
				postMutate: async (input) => {
					receivedSignal = input.signal;
					controller.abort();
					return { changed: false };
				},
			},
		);

		await expect(pending).rejects.toThrow("Operation aborted");
		expect(receivedSignal).toBe(controller.signal);
		expect(getOrThrow(await env.readTextFile("file.txt"))).toBe("payload");
	});

	it("skips postMutate entirely when the signal is already aborted before the hook runs", async () => {
		const env = createEnv();
		const controller = new AbortController();
		let hookCalls = 0;

		const pending = createEditTool().execute(
			"edit-post-mutate-pre-abort",
			{ path: "missing.txt", edits: [{ oldText: "a", newText: "b" }] },
			controller.signal,
			undefined,
			{
				env,
				postMutate: async () => {
					hookCalls += 1;
					return { changed: false };
				},
			},
		);
		controller.abort();

		await expect(pending).rejects.toThrow();
		expect(hookCalls).toBe(0);
	});

	it("produces byte-identical results to the pre-seam behavior when postMutate is absent", async () => {
		const env = createEnv();
		const writeResult = await createWriteTool().execute(
			"write-no-hook",
			{ path: "file.txt", content: "hello" },
			undefined,
			undefined,
			{ env },
		);
		getOrThrow(await env.writeFile("edit.txt", "alpha\nbeta\n"));
		const editResult = await createEditTool().execute(
			"edit-no-hook",
			{ path: "edit.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] },
			undefined,
			undefined,
			{ env },
		);

		expect(writeResult).toEqual({
			content: [{ type: "text", text: "Successfully wrote 5 bytes to file.txt" }],
			details: undefined,
		});
		expect(textOutput(editResult)).toBe("Successfully replaced 1 block(s) in edit.txt.");
		expect(editResult.details?.firstChangedLine).toBe(1);
		expect(applyPatch("alpha\nbeta\n", editResult.details?.patch ?? "")).toBe("ALPHA\nbeta\n");
	});
});
