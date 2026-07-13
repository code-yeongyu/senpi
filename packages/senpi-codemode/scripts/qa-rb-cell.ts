import { startBridgeServer } from "../src/bridge/http-server.ts";
import { RESERVED_AGENT_TOOL, RESERVED_OUTPUT_TOOL } from "../src/bridge/reserved.ts";
import { createInterpreterDetector } from "../src/interpreters/detect.ts";
import { RubyKernel } from "../src/kernels/rb/kernel.ts";

class QaUsageError extends Error {
	readonly name = "QaUsageError";
}

type QaOptions = {
	readonly codes: readonly string[];
	readonly cwd: string;
};

function parseOptions(argv: readonly string[]): QaOptions {
	const codes: string[] = [];
	let cwd = process.cwd();
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--code") {
			const code = argv[index + 1];
			if (code === undefined) throw new QaUsageError("--code requires a value");
			codes.push(code);
			index += 1;
			continue;
		}
		if (argument === "--cwd") {
			const value = argv[index + 1];
			if (value === undefined) throw new QaUsageError("--cwd requires a value");
			cwd = value;
			index += 1;
			continue;
		}
		throw new QaUsageError("unknown argument: " + argument);
	}
	if (codes.length === 0) throw new QaUsageError("provide at least one --code cell");
	return { codes, cwd };
}

async function runQa(options: QaOptions): Promise<void> {
	const detected = await createInterpreterDetector().detect("rb");
	if (!detected.ok) throw new QaUsageError("No rb interpreter is available");
	const server = await startBridgeServer({
		onCall: async (request) => {
			if (request.toolName === RESERVED_AGENT_TOOL) {
				throw new Error("agent() unavailable: no host handler is registered");
			}
			if (request.toolName === RESERVED_OUTPUT_TOOL) {
				throw new Error("output() unavailable: no host handler is registered");
			}
			throw new Error("tool unavailable in qa driver: " + request.toolName);
		},
		onEmit: async (event) => {
			console.log(JSON.stringify({ type: "emit", event }));
		},
		onCompletion: async () => {
			throw new Error("completion unavailable in qa driver");
		},
	});
	try {
		const kernel = RubyKernel.start({
			command: detected.path,
			sessionId: "qa-rb-" + crypto.randomUUID(),
			cwd: options.cwd,
			connection: { port: server.port, token: server.token },
			onMessage: (message) => console.log(JSON.stringify(message)),
		});
		try {
			for (const [index, code] of options.codes.entries()) {
				await kernel.run({ cellId: "qa-cell-" + String(index + 1), code, timeoutMs: 30_000 });
			}
		} finally {
			await kernel.close();
		}
	} finally {
		await server.close();
	}
}

runQa(parseOptions(process.argv.slice(2))).catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
