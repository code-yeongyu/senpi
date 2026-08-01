import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentToolResult, ExtensionContext } from "@code-yeongyu/senpi";
import { startBridgeServer } from "../src/bridge/http-server.ts";
import { createInterpreterDetector } from "../src/interpreters/detect.ts";
import { PythonKernel } from "../src/kernels/py/kernel.ts";
import { EvalDetachedCellManager } from "../src/tool/detached-cell-manager.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { renderEvalResult } from "../src/tool/render.ts";
import type {
	EvalKernel,
	EvalKernelManager,
	EvalToolDetails,
	EvalToolRequest,
} from "../src/tool/types.ts";

const execFileAsync = promisify(execFile);

class QaScenarioError extends Error {
	readonly name = "QaScenarioError";
}

function qaContext(cwd: string): ExtensionContext {
	return Object.assign(Object.create(null), {
		mode: "tui",
		hasUI: true,
		cwd,
		model: undefined,
		signal: undefined,
	});
}

function render(
	result: AgentToolResult<EvalToolDetails>,
	args: EvalToolRequest,
	cwd: string,
): string {
	const context = Object.assign(Object.create(null), {
		args,
		toolCallId: "qa-render",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd,
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: true,
		showImages: false,
		imageProtocol: null,
		isError: result.details.isError === true,
		hasResult: true,
		spinnerFrame: 0,
	});
	return renderEvalResult(
		result,
		{ expanded: true, isPartial: false },
		undefined,
		context,
	)
		.render(100)
		.join("\n");
}

function requireText(
	text: string,
	expected: string,
	label: string,
): void {
	if (!text.includes(expected))
		throw new QaScenarioError(`${label} missing ${JSON.stringify(expected)}`);
}

async function main(): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "senpi-detached-peek-"));
	const fifoPath = join(root, "release.fifo");
	const inputPath = join(root, "input.json");
	await writeFile(inputPath, JSON.stringify({ answer: 42 }));
	await execFileAsync("/usr/bin/mkfifo", [fifoPath]);
	const detected = await createInterpreterDetector().detect("py");
	if (!detected.ok)
		throw new QaScenarioError("No Python interpreter is available");
	const bridge = await startBridgeServer({
		onCall: async (request) => {
			throw new QaScenarioError(`unexpected tool call: ${request.toolName}`);
		},
		onEmit: async () => {},
		onCompletion: async () => {
			throw new QaScenarioError("unexpected completion call");
		},
	});
	let kernel: PythonKernel | undefined;
	const kernelManager: EvalKernelManager = {
		async getKernel(
			_language: string,
			onMessage: Parameters<EvalKernelManager["getKernel"]>[1],
		): Promise<EvalKernel> {
			if (kernel === undefined) {
				kernel = await PythonKernel.start({
					interpreterPath: detected.path,
					sessionId: `qa-detached-${crypto.randomUUID()}`,
					cwd: root,
					connection: { port: bridge.port, token: bridge.token },
					onMessage,
				});
			}
			return kernel;
		},
	};
	const manager = new EvalDetachedCellManager({ artifactsDir: root });
	const tool = createEvalTool({
		enabledLanguages: { js: false, py: true, rb: false, jl: false },
		kernelManager,
		cellTimeoutSeconds: 1,
		executeTool: async (name) => {
			throw new QaScenarioError(`unexpected host tool call: ${name}`);
		},
		cellManager: manager,
	});
	const code = [
		'phase("waiting")',
		`payload = read(${JSON.stringify(inputPath)})`,
		'display("before detach")',
		`with open(${JSON.stringify(fifoPath)}, "r") as gate:`,
		"    gate.readline()",
		'display("terminal value")',
	].join("\n");
	let cleanup = "not started";
	try {
		console.log("QA_STAGE: execute");
		const ready = Promise.withResolvers<void>();
		const execution = tool.execute(
			"qa-detached",
			{
				language: "py",
				code,
				title: "real detached peek",
				on_timeout: "detach",
			},
			undefined,
			(update) => {
				const cell = update.details.cells?.[0];
				console.log(
					`QA_UPDATE: phase=${update.details.phase ?? "none"} output=${JSON.stringify(cell?.output ?? "")} status=${update.details.statusEvents?.map((event) => event.op).join(",") ?? "none"}`,
				);
				if (
					update.details.phase === "waiting" &&
					cell?.output.includes("before detach") === true &&
					update.details.statusEvents?.some(
						(event) => event.op === "read",
					)
				)
					ready.resolve(undefined);
			},
			qaContext(root),
		);
		await ready.promise;
		console.log("QA_STAGE: rich update observed");
		await execution;
		console.log("QA_STAGE: detached");
		const running = await tool.execute(
			"qa-peek-running",
			{ action: "peek", cell_id: "qa-detached" },
			undefined,
			undefined,
			qaContext(root),
		);
		const runningRender = render(
			running,
			{ action: "peek", cell_id: "qa-detached" },
			root,
		);
		for (const expected of [
			"real detached peek",
			'phase("waiting")',
			"detached",
			"before detach",
			"waiting",
			"read",
			inputPath,
		])
			requireText(runningRender, expected, "running render");
		console.log("RUNNING_PEEK_PASS: true");
		console.log("--- RUNNING RENDER ---");
		console.log(runningRender);

		await writeFile(fifoPath, "release\n");
		console.log("QA_STAGE: fifo released");
		await manager.waitForTerminal("qa-detached");
		console.log("QA_STAGE: terminal");
		const terminal = await tool.execute(
			"qa-peek-terminal",
			{ action: "peek", cell_id: "qa-detached" },
			undefined,
			undefined,
			qaContext(root),
		);
		const terminalRender = render(
			terminal,
			{ action: "peek", cell_id: "qa-detached" },
			root,
		);
		requireText(terminalRender, "terminal value", "terminal render");
		if (terminal.details.cells?.[0]?.status !== "complete")
			throw new QaScenarioError("terminal cell status was not complete");
		if (terminal.details.durationMs <= 0)
			throw new QaScenarioError("terminal duration was not positive");
		console.log("TERMINAL_PEEK_PASS: true");
		console.log("--- TERMINAL RENDER ---");
		console.log(terminalRender);
	} finally {
		await manager.dispose();
		await kernel?.close();
		await bridge.close();
		await rm(root, { recursive: true, force: true });
		cleanup = `removed ${root}; kernel closed; bridge closed`;
		console.log(`CLEANUP: ${cleanup}`);
	}
}

await main().catch((error: unknown) => {
	console.error(
		error instanceof Error ? `${error.name}: ${error.message}` : String(error),
	);
	process.exitCode = 1;
});
