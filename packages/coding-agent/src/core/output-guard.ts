interface StdoutTakeoverState {
	rawStdoutWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	rawStderrWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	originalStdoutWrite: typeof process.stdout.write;
}

interface StderrTakeoverState {
	originalStderrWrite: typeof process.stderr.write;
	onHiddenDiagnostic: ((text: string) => void) | undefined;
	formatHiddenDiagnosticFallback: ((text: string) => string) | undefined;
}

let stdoutTakeoverState: StdoutTakeoverState | undefined;
let stderrTakeoverState: StderrTakeoverState | undefined;

const RAW_STDOUT_RETRY_DELAY_MS = 10;

let rawStdoutWriteTail: Promise<void> = Promise.resolve();

function getRawStdoutWrite(): StdoutTakeoverState["rawStdoutWrite"] {
	if (stdoutTakeoverState) {
		return stdoutTakeoverState.rawStdoutWrite;
	}
	return process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
}

async function writeRawStdoutChunk(text: string): Promise<void> {
	while (true) {
		try {
			await new Promise<void>((resolve, reject) => {
				try {
					getRawStdoutWrite()(text, (error) => {
						if (error) reject(error);
						else resolve();
					});
				} catch (error) {
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
			return;
		} catch (error) {
			const writeError = error instanceof Error ? error : new Error(String(error));
			const code = (writeError as Error & { code?: unknown }).code;
			if (code !== "ENOBUFS" && code !== "EAGAIN" && code !== "EWOULDBLOCK") {
				throw writeError;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, RAW_STDOUT_RETRY_DELAY_MS));
		}
	}
}

export function takeOverStdout(): void {
	if (stdoutTakeoverState) {
		return;
	}

	const rawStdoutWrite = process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
	const rawStderrWrite = process.stderr.write.bind(process.stderr) as StdoutTakeoverState["rawStderrWrite"];
	const originalStdoutWrite = process.stdout.write;

	process.stdout.write = ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		if (typeof encodingOrCallback === "function") {
			return rawStderrWrite(String(chunk), encodingOrCallback);
		}
		return rawStderrWrite(String(chunk), callback);
	}) as typeof process.stdout.write;

	stdoutTakeoverState = {
		rawStdoutWrite,
		rawStderrWrite,
		originalStdoutWrite,
	};
}

export function restoreStdout(): void {
	if (!stdoutTakeoverState) {
		return;
	}

	process.stdout.write = stdoutTakeoverState.originalStdoutWrite;
	stdoutTakeoverState = undefined;
}

function stdioChunkToString(chunk: string | Uint8Array, encoding: BufferEncoding | undefined): string {
	if (typeof chunk === "string") {
		return chunk;
	}
	return Buffer.from(chunk).toString(encoding);
}

function normalizeThrownError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function writeOriginalStderr(state: StderrTakeoverState, text: string): void {
	if (text.length === 0) {
		return;
	}
	state.originalStderrWrite.call(process.stderr, text);
}

export function takeOverStderr(
	onHiddenDiagnostic?: (text: string) => void,
	formatHiddenDiagnosticFallback?: (text: string) => string,
): void {
	if (stderrTakeoverState) {
		return;
	}

	const originalStderrWrite = process.stderr.write;

	process.stderr.write = ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
		const text = stdioChunkToString(chunk, encoding);
		try {
			stderrTakeoverState?.onHiddenDiagnostic?.(text);
		} catch (error) {
			const state = stderrTakeoverState;
			if (state) {
				const fallbackText = state.formatHiddenDiagnosticFallback?.(text) ?? text;
				writeOriginalStderr(state, fallbackText);
			}
			const writeError = normalizeThrownError(error);
			if (typeof encodingOrCallback === "function") {
				encodingOrCallback(writeError);
			} else {
				callback?.(writeError);
			}
			return false;
		}
		if (typeof encodingOrCallback === "function") {
			encodingOrCallback(null);
		} else {
			callback?.(null);
		}
		return true;
	}) satisfies typeof process.stderr.write;

	stderrTakeoverState = {
		formatHiddenDiagnosticFallback,
		originalStderrWrite,
		onHiddenDiagnostic,
	};
}

export function restoreStderr(): void {
	if (!stderrTakeoverState) {
		return;
	}

	process.stderr.write = stderrTakeoverState.originalStderrWrite;
	stderrTakeoverState = undefined;
}

export function isStdoutTakenOver(): boolean {
	return stdoutTakeoverState !== undefined;
}

export function writeRawStdout(text: string): void {
	if (text.length === 0) {
		return;
	}
	rawStdoutWriteTail = rawStdoutWriteTail.then(() => writeRawStdoutChunk(text));
	void rawStdoutWriteTail.catch(() => {
		process.exit(1);
	});
}

export async function waitForRawStdoutBackpressure(): Promise<void> {
	while (true) {
		const tail = rawStdoutWriteTail;
		await tail;
		if (tail === rawStdoutWriteTail) {
			return;
		}
	}
}

export async function flushRawStdout(): Promise<void> {
	await waitForRawStdoutBackpressure();
	await writeRawStdoutChunk("");
}
