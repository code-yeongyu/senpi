import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseJavaScriptResult, runJavaScriptCell, withJavaScriptKernel } from "./eval/js-kernel-harness.ts";

describe("JavaScript helper parity", () => {
	it("Given a local root when write and read use local URLs then files stay under that root", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-js-local-root-"));
		const localRoot = join(root, "local");
		try {
			await withJavaScriptKernel(
				async (kernel) => {
					// Given: a kernel initialized with a local:// root.
					// When
					const run = await runJavaScriptCell(
						kernel,
						`const written = await write("local://notes/merge-map.md", "hello");
return { written, content: await read("local://notes/merge-map.md") };`,
					);

					// Then
					expect(parseJavaScriptResult(run.result)).toEqual({
						written: join(localRoot, "notes", "merge-map.md"),
						content: "hello",
					});
					expect(await readFile(join(localRoot, "notes", "merge-map.md"), "utf8")).toBe("hello");
				},
				{ cwd: root, localRoots: { local: localRoot } },
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.each([
		["traversal", 'await write("local://../escape.md", "x")', /traversal|escapes/iu],
		["unsupported scheme", 'await read("memory://x.md")', /not supported/iu],
	] as const)("Given %s when a helper resolves a protocol URL then the cell rejects it", async (_name, code, error) => {
		const root = await mkdtemp(join(tmpdir(), "senpi-js-local-guard-"));
		try {
			await withJavaScriptKernel(
				async (kernel) => {
					// Given: a confined local root.
					// When
					const run = await runJavaScriptCell(kernel, code);

					// Then
					expect(run.result.ok).toBe(false);
					if (run.result.ok) throw new Error("protocol guard unexpectedly succeeded");
					expect(run.result.error.message).toMatch(error);
				},
				{ cwd: root, localRoots: { local: join(root, "local") } },
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("Given plain relative and absolute paths when helpers run then both resolve against their documented bases", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-js-plain-path-"));
		const absolute = join(root, "absolute.txt");
		try {
			await mkdir(join(root, "nested"), { recursive: true });
			await writeFile(absolute, "absolute");
			await withJavaScriptKernel(
				async (kernel) => {
					// Given: one relative target and one existing absolute file.
					// When
					const run = await runJavaScriptCell(
						kernel,
						`const written = await write("nested/relative.txt", "relative");
return { written, relative: await read("nested/relative.txt"), absolute: await read(${JSON.stringify(absolute)}) };`,
					);

					// Then
					expect(parseJavaScriptResult(run.result)).toEqual({
						written: join(root, "nested", "relative.txt"),
						relative: "relative",
						absolute: "absolute",
					});
				},
				{ cwd: root },
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("Given handle and schema options when agent returns task metadata then the DAG node carries parsed data", async () => {
		await withJavaScriptKernel(async (kernel) => {
			// Given
			const execution = kernel.run({
				cellId: "agent-handle",
				code: 'return await agent("solve", { agent: "reviewer", schema: { type: "object" }, handle: true })',
				timeoutMs: 2_000,
			});

			// When
			const call = await kernel.nextToolCall();
			kernel.deliverToolReply({
				type: "tool-reply",
				callId: call.callId,
				ok: true,
				value: { text: '{"answer":42}', data: { answer: 42 }, id: "st_agent", handle: "agent://st_agent" },
			});
			const result = await execution;

			// Then
			expect(call).toMatchObject({ toolName: "__agent__", args: { handle: true, agent: "reviewer" } });
			expect(parseJavaScriptResult(result)).toEqual({
				text: '{"answer":42}',
				output: '{"answer":42}',
				handle: "agent://st_agent",
				id: "st_agent",
				agent: "reviewer",
				data: { answer: 42 },
			});
		});
	});

	it("Given no handle option when agent returns text then the helper returns bare text", async () => {
		await withJavaScriptKernel(async (kernel) => {
			// Given
			const execution = kernel.run({ cellId: "agent-text", code: 'return await agent("say hi")', timeoutMs: 2_000 });

			// When
			const call = await kernel.nextToolCall();
			kernel.deliverToolReply({ type: "tool-reply", callId: call.callId, ok: true, value: { text: "hello" } });
			const result = await execution;

			// Then
			expect(parseJavaScriptResult(result)).toBe("hello");
		});
	});

	it("Given a handle response without task metadata when agent settles then the helper returns a null handle node", async () => {
		await withJavaScriptKernel(async (kernel) => {
			// Given
			const execution = kernel.run({
				cellId: "agent-null-handle",
				code: 'return await agent("say hi", { handle: true })',
				timeoutMs: 2_000,
			});

			// When
			const call = await kernel.nextToolCall();
			kernel.deliverToolReply({ type: "tool-reply", callId: call.callId, ok: true, value: { text: "lonely" } });
			const result = await execution;

			// Then
			expect(parseJavaScriptResult(result)).toEqual({
				text: "lonely",
				output: "lonely",
				handle: null,
				id: null,
				agent: null,
			});
		});
	});

	it("Given completion options when the JS helper delegates then the structured bridge value is returned", async () => {
		await withJavaScriptKernel(async (kernel) => {
			// Given
			const execution = kernel.run({
				cellId: "completion-structured",
				code: 'return await completion("question", { model: "slow", system: "Be terse.", schema: { type: "object" } })',
				timeoutMs: 2_000,
			});

			// When
			const call = await kernel.nextToolCall();
			kernel.deliverToolReply({ type: "tool-reply", callId: call.callId, ok: true, value: { answer: 42 } });
			const result = await execution;

			// Then
			expect(call).toMatchObject({
				toolName: "completion",
				args: {
					prompt: "question",
					opts: { model: "slow", system: "Be terse.", schema: { type: "object" } },
				},
			});
			expect(parseJavaScriptResult(result)).toEqual({ answer: 42 });
		});
	});
});
