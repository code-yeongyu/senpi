import type { ShellCaptureOptions } from "../../src/kernels/js/worker-shell-capture.d.ts";

export type InstallShellCapture = (options: ShellCaptureOptions) => () => void;

export type EmittedText = { readonly stream: "stdout" | "stderr"; readonly data: string };

export type FakeShellOutput = {
	readonly stdout: Buffer;
	readonly stderr: Buffer;
	readonly exitCode: number;
};

export class FakeShellError extends Error implements FakeShellOutput {
	readonly name = "ShellError";
	readonly stdout: Buffer;
	readonly stderr: Buffer;
	readonly exitCode: number;

	constructor(output: FakeShellOutput) {
		super(`Failed with exit code ${output.exitCode}`);
		this.stdout = output.stdout;
		this.stderr = output.stderr;
		this.exitCode = output.exitCode;
	}
}

/**
 * Mirrors the Bun 1.4 ShellPromise contract that matters here (verified against bun 1.4.0):
 * - the command starts lazily on the first `then` call;
 * - without `quiet()`, the child's output is streamed to the process' fd 1/2 as it runs;
 * - `text()`/`json()`/`lines()` switch to quiet mode INTERNALLY (not via the instance `quiet` property);
 * - `quiet()`/`nothrow()`/`throws()` return the same promise.
 */
export class FakeShellPromise extends Promise<FakeShellOutput> {
	static get [Symbol.species](): PromiseConstructor {
		return Promise;
	}

	readonly printed: string[];
	#quiet = false;
	#nothrow = false;
	#started = false;
	readonly #output: FakeShellOutput;

	constructor(output: FakeShellOutput, printed: string[]) {
		let settle: (value: FakeShellOutput) => void = () => {};
		let fail: (error: unknown) => void = () => {};
		super((resolve, reject) => {
			settle = resolve;
			fail = reject;
		});
		this.#output = output;
		this.printed = printed;
		this.#start = () => {
			if (this.#started) return;
			this.#started = true;
			if (!this.#quiet) this.printed.push(this.#output.stdout.toString(), this.#output.stderr.toString());
			if (this.#output.exitCode !== 0 && !this.#nothrow) fail(new FakeShellError(this.#output));
			else settle(this.#output);
		};
	}

	#start: () => void;

	quiet(): this {
		this.#quiet = true;
		return this;
	}

	nothrow(): this {
		this.#nothrow = true;
		return this;
	}

	throws(shouldThrow: boolean): this {
		this.#nothrow = !shouldThrow;
		return this;
	}

	async text(): Promise<string> {
		this.#quiet = true;
		const result = await this.then((value) => value);
		return result.stdout.toString();
	}

	// biome-ignore lint/suspicious/noThenProperty: intentional thenable — Bun's ShellPromise starts the command on its own then()
	override then<TResult1 = FakeShellOutput, TResult2 = never>(
		onFulfilled?: ((value: FakeShellOutput) => TResult1 | PromiseLike<TResult1>) | null,
		onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
	): Promise<TResult1 | TResult2> {
		this.#start();
		return super.then(onFulfilled, onRejected);
	}
}

export type FakeSpawnCall = { readonly cmd: readonly string[]; readonly options: Record<string, unknown> };

export type FakeBun = {
	$: FakeShell;
	spawn: (...args: unknown[]) => FakeSubprocess;
	spawnSync: (...args: unknown[]) => unknown;
};

export type FakeShell = {
	(strings: TemplateStringsArray, ...expressions: unknown[]): FakeShellPromise;
	nothrow(): FakeShell;
	throws(shouldThrow: boolean): FakeShell;
	env(values?: Record<string, string>): FakeShell;
	cwd(path?: string): FakeShell;
	braces(pattern: string): string[];
	escape(value: string): string;
	Shell: () => void;
	ShellPromise: typeof FakeShellPromise;
	ShellError: typeof FakeShellError;
	calls: string[];
	/** Per template: whether it arrived wrapped in the stdin-isolation frame `true | (\n…\n)`. */
	framed: boolean[];
};

const STDIN_ISOLATION_FRAME = /^true \| \(\n([\s\S]*)\n\)$/u;

export type FakeSubprocess = {
	readonly stderr: ReadableStream<Uint8Array> | undefined;
	readonly exited: Promise<number>;
};

export function output(stdout: string, stderr = "", exitCode = 0): FakeShellOutput {
	return { stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), exitCode };
}

export function createFakeBun(): {
	bun: FakeBun;
	printed: string[];
	spawnCalls: FakeSpawnCall[];
	spawnSyncCalls: FakeSpawnCall[];
	outputs: Map<string, FakeShellOutput>;
} {
	const printed: string[] = [];
	const spawnCalls: FakeSpawnCall[] = [];
	const spawnSyncCalls: FakeSpawnCall[] = [];
	const outputs = new Map<string, FakeShellOutput>();
	const shell = ((strings: TemplateStringsArray) => {
		const joined = strings.join("");
		const framed = STDIN_ISOLATION_FRAME.exec(joined);
		shell.framed.push(framed !== null);
		const command = framed?.[1] ?? joined;
		return new FakeShellPromise(outputs.get(command) ?? output(""), printed);
	}) as FakeShell;
	shell.calls = [];
	shell.framed = [];
	shell.nothrow = () => {
		shell.calls.push("nothrow");
		return shell;
	};
	shell.throws = (shouldThrow) => {
		shell.calls.push(`throws:${shouldThrow}`);
		return shell;
	};
	shell.env = () => {
		shell.calls.push("env");
		return shell;
	};
	shell.cwd = () => {
		shell.calls.push("cwd");
		return shell;
	};
	shell.braces = (pattern) => [pattern];
	shell.escape = (value) => value;
	shell.Shell = () => {};
	shell.ShellPromise = FakeShellPromise;
	shell.ShellError = FakeShellError;
	const spawn = (...args: unknown[]): FakeSubprocess => {
		const [first, second] = args;
		const options: Record<string, unknown> = Array.isArray(first)
			? { ...(second as Record<string, unknown> | undefined) }
			: { ...(first as Record<string, unknown>) };
		const cmd = Array.isArray(first) ? (first as string[]) : (options.cmd as string[]);
		spawnCalls.push({ cmd, options });
		const stderr =
			options.stderr === "pipe"
				? new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode(`child stderr for ${cmd.join(" ")}\n`));
							controller.close();
						},
					})
				: undefined;
		return { stderr, exited: Promise.resolve(0) };
	};
	const spawnSync = (...args: unknown[]): unknown => {
		const [first, second] = args;
		const options: Record<string, unknown> = Array.isArray(first)
			? { ...(second as Record<string, unknown> | undefined) }
			: { ...(first as Record<string, unknown>) };
		const cmd = Array.isArray(first) ? (first as string[]) : (options.cmd as string[]);
		spawnSyncCalls.push({ cmd, options });
		return { stdout: Buffer.from(""), stderr: Buffer.from(""), exitCode: 0 };
	};
	const bun: FakeBun = { $: shell, spawn, spawnSync };
	return { bun, printed, spawnCalls, spawnSyncCalls, outputs };
}

export function installFakeBun(): ReturnType<typeof createFakeBun> {
	const fake = createFakeBun();
	Object.defineProperty(globalThis, "Bun", { value: fake.bun, configurable: true, writable: true });
	return fake;
}

export function emitter(): { emitted: EmittedText[]; emitText: (stream: "stdout" | "stderr", data: string) => void } {
	const emitted: EmittedText[] = [];
	return { emitted, emitText: (stream, data) => emitted.push({ stream, data }) };
}
