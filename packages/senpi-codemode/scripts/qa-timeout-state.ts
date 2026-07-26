import { startBridgeServer } from "../src/bridge/http-server.ts";
import { createInterpreterDetector } from "../src/interpreters/detect.ts";
import { PythonKernel } from "../src/kernels/py/kernel.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type { ExtensionContext } from "@code-yeongyu/senpi";

class QaScenarioError extends Error {
	readonly name = "QaScenarioError";
}

const detected = await createInterpreterDetector().detect("py");
if (!detected.ok) throw new QaScenarioError("no python interpreter");
const server = await startBridgeServer({
	onCall: async () => {
		throw new QaScenarioError("no bridge tools in qa");
	},
	onEmit: async () => {},
	onCompletion: async () => {
		throw new QaScenarioError("no completion in qa");
	},
});
try {
	const kernel = await PythonKernel.start({
		interpreterPath: detected.path,
		sessionId: "qa-timeout-state-" + crypto.randomUUID(),
		cwd: process.cwd(),
		connection: { port: server.port, token: server.token },
	});
	try {
		const tool = createEvalTool({
			enabledLanguages: { js: false, py: true, rb: false, jl: false },
			kernelManager: { getKernel: async () => kernel },
			cellTimeoutSeconds: 1,
			executeTool: (async () => {
				throw new QaScenarioError("no executeTool in qa");
			}) as never,
		});
		const ctx = { mode: "print" } as unknown as ExtensionContext;

		// Cooperative interrupt: the runner answers SIGINT, so state must survive and
		// the timeout message must say the kernel remains running.
		const cooperative = await tool
			.execute("qa-coop", { language: "py", code: "x=42\nimport time\ntime.sleep(30)", on_timeout: "error", timeout: 1 }, undefined, undefined, ctx)
			.then(() => "UNEXPECTED-SUCCESS", (error: Error) => `${error.name}: ${error.message}`);
		console.log(`COOPERATIVE_TIMEOUT: ${cooperative}`);

		// Assert on the kernel's own readback so output-capture formatting cannot
		// mask whether the interrupted kernel actually kept its variables.
		const readback = await kernel.run({ cellId: "qa-readback", code: "x", timeoutMs: 5_000 });
		console.log(`STATE_READBACK: ${JSON.stringify(readback)}`);

		if (!cooperative.includes("TimeoutError")) throw new QaScenarioError(`expected TimeoutError: ${cooperative}`);
		if (!/remains running|preserved/i.test(cooperative))
			throw new QaScenarioError(`timeout message did not name preserved state: ${cooperative}`);
		if (!readback.ok || readback.valueRepr !== "42")
			throw new QaScenarioError(`python state did not survive timeout: ${JSON.stringify(readback)}`);
	} finally {
		await kernel.close();
	}
} finally {
	await server.close();
}
