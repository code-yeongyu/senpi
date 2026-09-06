import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ShellCaptureOptions, ShellCaptureRestore } from "../src/kernels/js/worker-shell-capture.d.ts";

type InstallShellCapture = (options: ShellCaptureOptions) => ShellCaptureRestore;

const captureModuleUrl = pathToFileURL(join(process.cwd(), "src", "kernels", "js", "worker-shell-capture.js")).href;

function isShellCaptureModule(value: unknown): value is { readonly installShellCapture: InstallShellCapture } {
	return (
		typeof value === "object" && value !== null && typeof Reflect.get(value, "installShellCapture") === "function"
	);
}

async function loadInstallShellCapture(): Promise<InstallShellCapture> {
	const loaded: unknown = await import(captureModuleUrl);
	if (!isShellCaptureModule(loaded)) throw new Error("worker-shell-capture.js does not export installShellCapture");
	return loaded.installShellCapture;
}

type EmittedText = { readonly stream: "stdout" | "stderr"; readonly data: string };

type FakeShellOutput = {
	readonly stdout: Buffer;
	readonly stderr: Buffer;
	readonly exitCode: number;
};

class FakeShellError extends Error implements FakeShellOutput {
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
class FakeShellPromise extends Promise<FakeShellOutput> {
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

type FakeSpawnCall = { readonly cmd: readonly string[]; readonly options: Record<string, unknown> };

type FakeBun = {
	$: FakeShell;
	spawn: (...args: unknown[]) => FakeSubprocess;
	spawnSync: (...args: unknown[]) => unknown;
};

type FakeShell = {
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
};

type FakeSubprocess = {
	readonly stderr: ReadableStream<Uint8Array> | undefined;
	readonly exited: Promise<number>;
};

function output(stdout: string, stderr = "", exitCode = 0): FakeShellOutput {
	return { stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), exitCode };
}

function createFakeBun(): {
	bun: FakeBun;
	printed: string[];
	spawnCalls: FakeSpawnCall[];
	outputs: Map<string, FakeShellOutput>;
} {
	const printed: string[] = [];
	const spawnCalls: FakeSpawnCall[] = [];
	const outputs = new Map<string, FakeShellOutput>();
	const shell = ((strings: TemplateStringsArray) => {
		const command = strings.join("");
		return new FakeShellPromise(outputs.get(command) ?? output(""), printed);
	}) as FakeShell;
	shell.calls = [];
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
	const bun: FakeBun = { $: shell, spawn, spawnSync: () => ({}) };
	return { bun, printed, spawnCalls, outputs };
}

function installFakeBun(): ReturnType<typeof createFakeBun> {
	const fake = createFakeBun();
	Object.defineProperty(globalThis, "Bun", { value: fake.bun, configurable: true, writable: true });
	return fake;
}

function emitter(): { emitted: EmittedText[]; emitText: (stream: "stdout" | "stderr", data: string) => void } {
	const emitted: EmittedText[] = [];
	return { emitted, emitText: (stream, data) => emitted.push({ stream, data }) };
}

describe("JS kernel shell output capture", () => {
	const hadBun = Object.hasOwn(globalThis, "Bun");
	const originalBun: unknown = Reflect.get(globalThis, "Bun");
	let restore: ShellCaptureRestore = () => {};
	let installShellCapture: InstallShellCapture = () => () => {};

	beforeAll(async () => {
		installShellCapture = await loadInstallShellCapture();
	});

	afterEach(() => {
		restore();
		restore = () => {};
		if (hadBun) Object.defineProperty(globalThis, "Bun", { value: originalBun, configurable: true, writable: true });
		else Reflect.deleteProperty(globalThis, "Bun");
	});

	it("Given no Bun global when capture installs then it is a no-op with a callable restore", () => {
		Reflect.deleteProperty(globalThis, "Bun");
		const { emitText } = emitter();
		restore = installShellCapture({ isActive: () => true, emitText });
		expect(typeof restore).toBe("function");
		expect(Object.hasOwn(globalThis, "Bun")).toBe(false);
	});

	it("Given an active cell when `$` is awaited without quiet then nothing prints and the output is echoed into the cell", async () => {
		const fake = installFakeBun();
		fake.outputs.set("echo hi", output("hi\n", "warn\n"));
		const { emitted, emitText } = emitter();
		restore = installShellCapture({ isActive: () => true, emitText });

		const result = await fake.bun.$`echo hi`;

		expect(result.stdout.toString()).toBe("hi\n");
		expect(fake.printed).toEqual([]);
		expect(emitted).toEqual([
			{ stream: "stdout", data: "hi\n" },
			{ stream: "stderr", data: "warn\n" },
		]);
	});

	it("Given an active cell when `.nothrow()` is awaited then the failing command's output is echoed exactly once", async () => {
		const fake = installFakeBun();
		fake.outputs.set("exit 3", output("partial\n", "boom\n", 3));
		const { emitted, emitText } = emitter();
		restore = installShellCapture({ isActive: () => true, emitText });

		const promise = fake.bun.$`exit 3`.nothrow();
		const [first, second] = await Promise.all([promise, promise]);

		expect(first.exitCode).toBe(3);
		expect(second).toBe(first);
		expect(fake.printed).toEqual([]);
		expect(emitted).toEqual([
			{ stream: "stdout", data: "partial\n" },
			{ stream: "stderr", data: "boom\n" },
		]);
	});

	it("Given an active cell when a throwing command rejects then the rejection propagates and its output is echoed", async () => {
		const fake = installFakeBun();
		fake.outputs.set("exit 2", output("", "fatal\n", 2));
		const { emitted, emitText } = emitter();
		restore = installShellCapture({ isActive: () => true, emitText });

		await expect(fake.bun.$`exit 2`).rejects.toMatchObject({ name: "ShellError", exitCode: 2 });

		expect(fake.printed).toEqual([]);
		expect(emitted).toEqual([{ stream: "stderr", data: "fatal\n" }]);
	});

	it("Given an active cell when `.text()` or `.quiet()` reads the output then nothing is echoed", async () => {
		const fake = installFakeBun();
		fake.outputs.set("echo text", output("text\n"));
		fake.outputs.set("echo quiet", output("quiet\n"));
		const { emitted, emitText } = emitter();
		restore = installShellCapture({ isActive: () => true, emitText });

		const text = await fake.bun.$`echo text`.text();
		const quiet = await fake.bun.$`echo quiet`.quiet();

		expect(text).toBe("text\n");
		expect(quiet.stdout.toString()).toBe("quiet\n");
		expect(fake.printed).toEqual([]);
		expect(emitted).toEqual([]);
	});

	it("Given no active cell when `$` runs then the original shell promise is returned untouched", async () => {
		const fake = installFakeBun();
		fake.outputs.set("echo idle", output("idle\n"));
		const { emitted, emitText } = emitter();
		restore = installShellCapture({ isActive: () => false, emitText });

		const promise = fake.bun.$`echo idle`;
		await promise;

		expect(promise).toBeInstanceOf(FakeShellPromise);
		expect(fake.printed).toEqual(["idle\n", ""]);
		expect(emitted).toEqual([]);
	});

	it("Given the captured shell when shell-level configuration methods are used then they chain on the captured shell", () => {
		const fake = installFakeBun();
		const original = fake.bun.$;
		const { emitText } = emitter();
		restore = installShellCapture({ isActive: () => true, emitText });

		const captured = fake.bun.$;
		expect(captured).not.toBe(original);
		expect(captured.nothrow()).toBe(captured);
		expect(captured.throws(true)).toBe(captured);
		expect(captured.env({ A: "1" })).toBe(captured);
		expect(captured.cwd("/tmp")).toBe(captured);
		expect(original.calls).toEqual(["nothrow", "throws:true", "env", "cwd"]);
		expect(captured.braces("a{b,c}")).toEqual(["a{b,c}"]);
		expect(captured.escape("x")).toBe("x");
		expect(captured.Shell).toBe(original.Shell);
		expect(captured.ShellPromise).toBe(FakeShellPromise);
		expect(captured.ShellError).toBe(FakeShellError);
	});

	it("Given a captured runtime when restore runs then the original Bun surfaces come back", () => {
		const fake = installFakeBun();
		const originalShell = fake.bun.$;
		const originalSpawn = fake.bun.spawn;
		const { emitText } = emitter();
		restore = installShellCapture({ isActive: () => true, emitText });
		expect(fake.bun.$).not.toBe(originalShell);
		expect(fake.bun.spawn).not.toBe(originalSpawn);

		restore();
		restore = () => {};

		expect(fake.bun.$).toBe(originalShell);
		expect(fake.bun.spawn).toBe(originalSpawn);
	});

	it("Given an active cell when Bun.spawn runs with the default stderr then stderr is piped and drained into the cell", async () => {
		const fake = installFakeBun();
		const { emitted, emitText } = emitter();
		restore = installShellCapture({ isActive: () => true, emitText });

		const child = fake.bun.spawn(["sh", "-c", "echo x >&2"]);
		await child.exited;
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(fake.spawnCalls).toEqual([{ cmd: ["sh", "-c", "echo x >&2"], options: { stderr: "pipe" } }]);
		expect(emitted).toEqual([{ stream: "stderr", data: "child stderr for sh -c echo x >&2\n" }]);
	});

	it("Given an active cell when Bun.spawn uses the object form with the default stderr then stderr is piped as well", async () => {
		const fake = installFakeBun();
		const { emitted, emitText } = emitter();
		restore = installShellCapture({ isActive: () => true, emitText });

		fake.bun.spawn({ cmd: ["ls"], stdout: "pipe" });
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(fake.spawnCalls).toEqual([{ cmd: ["ls"], options: { cmd: ["ls"], stdout: "pipe", stderr: "pipe" } }]);
		expect(emitted).toEqual([{ stream: "stderr", data: "child stderr for ls\n" }]);
	});

	it("Given explicit stdio choices or no active cell when Bun.spawn runs then the options pass through unchanged", async () => {
		const fake = installFakeBun();
		const { emitted, emitText } = emitter();
		let active = true;
		restore = installShellCapture({ isActive: () => active, emitText });

		fake.bun.spawn(["a"], { stderr: "inherit" });
		fake.bun.spawn(["b"], { stdio: ["ignore", "pipe", "inherit"] });
		active = false;
		fake.bun.spawn(["c"]);
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(fake.spawnCalls).toEqual([
			{ cmd: ["a"], options: { stderr: "inherit" } },
			{ cmd: ["b"], options: { stdio: ["ignore", "pipe", "inherit"] } },
			{ cmd: ["c"], options: {} },
		]);
		expect(emitted).toEqual([]);
	});
});
