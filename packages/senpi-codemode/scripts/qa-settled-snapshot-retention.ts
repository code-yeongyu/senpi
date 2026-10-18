import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, ExtensionContext } from "@code-yeongyu/senpi";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";
import { EvalDetachedCellManager } from "../src/tool/detached-cell-manager.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";

const PNG_1X1_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

class QaScenarioError extends Error {
	readonly name = "QaScenarioError";
}

function context(cwd: string, mode: "print" | "tui", steeringSignal?: AbortSignal): ExtensionContext {
	return Object.assign(Object.create(null), {
		mode,
		hasUI: mode === "tui",
		cwd,
		model: undefined,
		signal: undefined,
		steeringSignal,
	});
}

function images(result: AgentToolResult<unknown>): number {
	return result.content.filter((part) => part.type === "image").length;
}

function imageData(result: AgentToolResult<unknown>): string[] {
	return result.content.flatMap((part) => (part.type === "image" ? [part.data] : []));
}

function expectEqual(actual: unknown, expected: unknown, label: string): void {
	const shown = JSON.stringify(actual);
	if (shown !== JSON.stringify(expected)) throw new QaScenarioError(`${label}: ${shown} !== ${JSON.stringify(expected)}`);
	console.log(`${label}: ${shown}`);
}

async function main(): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "senpi-settled-retention-"));
	const pngPath = join(root, "tiny.png");
	await writeFile(pngPath, Buffer.from(PNG_1X1_BASE64, "base64"));
	const gateEntered = Promise.withResolvers<void>();
	const releaseGate = Promise.withResolvers<void>();
	const kernel = new JavaScriptKernel({ sessionId: `qa-retention-${crypto.randomUUID()}`, cwd: root, parallelPoolWidth: 2 });
	const manager = new EvalDetachedCellManager({ artifactsDir: root });
	const tool = createEvalTool({
		enabledLanguages: { js: true, py: false, rb: false, jl: false },
		kernelManager: { getKernel: async () => kernel },
		cellTimeoutSeconds: 1,
		executeTool: async (name) => {
			if (name !== "read") throw new QaScenarioError(`unexpected host tool call: ${name}`);
			gateEntered.resolve();
			await releaseGate.promise;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
		cellManager: manager,
	});
	const spillDir = join(root, "settled-images");
	const spillFiles = () => (existsSync(spillDir) ? readdirSync(spillDir) : []);
	const show = `display(await Bun.file(${JSON.stringify(pngPath)}).arrayBuffer());`;
	const peek = (cellId: string) =>
		tool.execute(`peek-${cellId}`, { action: "peek", cell_id: cellId }, undefined, undefined, context(root, "tui"));
	try {
		const foreground = await tool.execute(
			"fg-image",
			{ language: "js", code: `${show} "fg done"`, summary: "foreground image" },
			undefined,
			undefined,
			context(root, "print"),
		);
		expectEqual(images(foreground), 1, "FOREGROUND_RESULT_IMAGES");
		const foregroundPeek = await peek("fg-image");
		expectEqual(images(foregroundPeek), 1, "FOREGROUND_PEEK_IMAGES");
		expectEqual(imageData(foregroundPeek), imageData(foreground), "FOREGROUND_PEEK_IMAGE_IDENTICAL");
		expectEqual(manager.list().recent.flatMap((snapshot) => imageData(snapshot.result)).length, 0, "IN_MEMORY_IMAGE_PARTS");

		const steering = new AbortController();
		const execution = tool.execute(
			"bg-image",
			{
				language: "js",
				code: `${show} await tool.read({ path: "gate" }); "bg done"`,
				summary: "detached image",
				on_timeout: "detach",
			},
			undefined,
			undefined,
			context(root, "tui", steering.signal),
		);
		await Promise.race([gateEntered.promise, execution]);
		steering.abort();
		const detached = await execution;
		expectEqual(detached.details.cells?.[0]?.status, "detached", "DETACHED_STATUS");
		const terminal = manager.waitForTerminal("bg-image");
		releaseGate.resolve();
		await terminal;
		expectEqual(images(await peek("bg-image")), 1, "DETACHED_PEEK_IMAGES");

		expectEqual(spillFiles().length, 2, "SPILL_FILES_ON_DISK");

		await tool.execute(
			"reset-js",
			{ language: "js", code: "1", summary: "reset", reset: true },
			undefined,
			undefined,
			context(root, "print"),
		);
		expectEqual(
			manager.list().recent.map((snapshot) => snapshot.cellId),
			["fg-image", "bg-image", "reset-js"],
			"RECENT_AFTER_RESET",
		);
		expectEqual(images(await peek("fg-image")), 1, "FOREGROUND_PEEK_IMAGES_AFTER_RESET");

		for (const name of spillFiles()) await rm(join(spillDir, name));
		const lost = await peek("fg-image");
		expectEqual(images(lost), 0, "PEEK_IMAGES_AFTER_SPILL_FILE_REMOVED");
		const note = lost.content.flatMap((part) => (part.type === "text" ? part.text.split("\n") : [])).at(-1) ?? "";
		console.log(`PEEK_NOTE_AFTER_SPILL_FILE_REMOVED: ${note.replace(root, "<artifacts>")}`);
		if (!note.startsWith("[image/png image")) throw new QaScenarioError("missing spilled-image note");

		await manager.dispose();
		expectEqual(existsSync(spillDir), false, "SPILL_DIR_AFTER_DISPOSE");
		console.log("QA_SETTLED_RETENTION_PASS: true");
	} finally {
		releaseGate.resolve();
		await manager.dispose();
		await kernel.close();
		await rm(root, { recursive: true, force: true });
		console.log(`CLEANUP: removed ${root}; kernel closed`);
	}
}

await main().catch((error: unknown) => {
	console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
	process.exitCode = 1;
});
