import { PassThrough } from "node:stream";
import { restoreStdout } from "../../../src/core/output-guard.ts";
import { ServerCore } from "../../../src/modes/app-server/server/server-core.ts";
import { startStdioTransport } from "../../../src/modes/app-server/transports/stdio.ts";

type WriteCallback = (error?: Error | null) => void;

interface CapturedProcessOutput {
	readonly stdout: readonly string[];
	readonly stderr: readonly string[];
	restore(): void;
}

function initializeFrame(id: number): string {
	return `${JSON.stringify({ id, method: "initialize", params: { clientInfo: { name: "qa", version: "0.0.1" } } })}\n`;
}

function createCapturedProcessOutput(): CapturedProcessOutput {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const originalStdoutWrite = process.stdout.write;
	const originalStderrWrite = process.stderr.write;

	function writeStdout(
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | WriteCallback,
		callback?: WriteCallback,
	): boolean {
		stdout.push(String(chunk));
		const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		done?.();
		return true;
	}

	function writeStderr(
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | WriteCallback,
		callback?: WriteCallback,
	): boolean {
		stderr.push(String(chunk));
		const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		done?.();
		return true;
	}

	process.stdout.write = writeStdout;
	process.stderr.write = writeStderr;

	return {
		stdout,
		stderr,
		restore: () => {
			process.stdout.write = originalStdoutWrite;
			process.stderr.write = originalStderrWrite;
		},
	};
}

function parsedStdoutLines(output: CapturedProcessOutput): unknown[] {
	return output.stdout
		.join("")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line));
}

const output = createCapturedProcessOutput();
const stdin = new PassThrough();
let shutdownReason: string | undefined;
const shutdown = new Promise<string>((resolve) => {
	startStdioTransport({
		core: new ServerCore({ version: "2026.7.2", codexHome: "/tmp/senpi-task13-stdout-purity" }),
		stdin,
		onShutdown: (reason) => {
			shutdownReason = reason;
			resolve(reason);
		},
	});
});

try {
	process.stdout.write("session output must not reach stdout\n");
	stdin.end(`not-json\n${initializeFrame(13)}`);
	await shutdown;
	const parsed = parsedStdoutLines(output);
	const stderrText = output.stderr.join("");

	if (shutdownReason !== "stdin ended") {
		throw new Error(`expected stdin ended shutdown, received ${shutdownReason ?? "<none>"}`);
	}
	if (parsed.length !== 2) {
		throw new Error(`expected 2 stdout JSON frames, received ${parsed.length}`);
	}
	if (!JSON.stringify(parsed[0]).includes("-32700")) {
		throw new Error("malformed input did not produce a parse-error response");
	}
	if (!JSON.stringify(parsed[1]).includes('"/tmp/senpi-task13-stdout-purity"')) {
		throw new Error("initialize response was not written to stdout");
	}
	if (!stderrText.includes("session output must not reach stdout")) {
		throw new Error("session stdout was not redirected to stderr");
	}
} finally {
	restoreStdout();
	output.restore();
}

process.stderr.write("task13 stdout purity: stdout frames parsed as NDJSON; session output captured on stderr\n");
