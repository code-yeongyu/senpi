import { format } from "node:util";

/** The longest a print-then-exit command waits for its reader before exiting anyway. */
export const OUTPUT_DELIVERY_LIMIT_MS = 30_000;

const nativeLog = console.log;
const nativeStdoutWrite = process.stdout.write;

type WriteCallback = (error?: Error | null) => void;
type ExitCode = Parameters<typeof process.exit>[0];

/**
 * Runs `print` with stdout collected instead of written. Both runtimes can drop queued stdout at
 * exit: Node writes to a pipe asynchronously, and Bun discards `console.log` output queued behind
 * an earlier `process.stdout` write (senpi#2937). One write whose own callback is awaited is the
 * shape both deliver in full. Output already redirected (json mode sends it to stderr) is left alone.
 */
export async function captureStdout<T>(print: () => T | Promise<T>): Promise<{ result: T; output: string }> {
	if (console.log !== nativeLog || process.stdout.write !== nativeStdoutWrite) {
		return { result: await print(), output: "" };
	}
	const chunks: string[] = [];
	console.log = (...args: unknown[]) => {
		chunks.push(`${format(...args)}\n`);
	};
	process.stdout.write = ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | WriteCallback,
		callback?: WriteCallback,
	): boolean => {
		chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
		const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		done?.();
		return true;
	}) as typeof process.stdout.write;
	let printed = false;
	try {
		const result = await print();
		printed = true;
		return { result, output: chunks.join("") };
	} finally {
		console.log = nativeLog;
		process.stdout.write = nativeStdoutWrite;
		if (!printed && chunks.length > 0) process.stdout.write(chunks.join(""));
	}
}

function delivered(stream: NodeJS.WriteStream, text: string): Promise<void> {
	if (stream.destroyed || stream.writableEnded) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, OUTPUT_DELIVERY_LIMIT_MS);
		timer.unref();
		const done = (): void => {
			clearTimeout(timer);
			resolve();
		};
		// A reader that went away (`| head -1`) surfaces as EPIPE: it ends the wait instead of crashing.
		stream.once("error", done);
		try {
			stream.write(text, done);
		} catch {
			done();
		}
	});
}

export async function exitAfterOutput(output = "", code?: ExitCode): Promise<never> {
	await Promise.all([delivered(process.stdout, output), delivered(process.stderr, "")]);
	process.exit(code);
}

export async function printThenExit(print: () => unknown, code?: ExitCode): Promise<never> {
	const { output } = await captureStdout(print);
	return exitAfterOutput(output, code);
}
