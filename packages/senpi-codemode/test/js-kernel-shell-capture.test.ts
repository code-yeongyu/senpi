import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ShellCaptureRestore } from "../src/kernels/js/worker-shell-capture.d.ts";
import {
	emitter,
	FakeShellError,
	FakeShellPromise,
	type InstallShellCapture,
	installFakeBun,
	output,
} from "./eval/fake-bun-shell.ts";

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
		Reflect.deleteProperty(globalThis, "__senpi_session_env_deletions__");
		Reflect.deleteProperty(globalThis, "__senpi_session_env_applied__");
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
		expect(fake.bun.$.framed).toEqual([false]);
	});

	it("Given an active cell when `$` runs then the template is framed so its commands read an empty stdin", async () => {
		const fake = installFakeBun();
		fake.outputs.set("cat file.txt | wc -c", output("0\n"));
		const { emitText } = emitter();
		let active = true;
		restore = installShellCapture({ isActive: () => active, emitText });

		const framed = await fake.bun.$`cat file.txt | wc -c`.text();
		active = false;
		await fake.bun.$`echo after`;

		expect(framed).toBe("0\n");
		expect(fake.bun.$.framed).toEqual([true, false]);
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

	it("Given deleted session keys when capture installs then Bun spawns pin the worker's environment view", async () => {
		const fake = installFakeBun();
		process.env.PI_SESSION_ID = "capture-pin-session";
		globalThis.__senpi_session_env_deletions__ = ["PI_SESSION_FILE"];
		const { emitText } = emitter();
		try {
			restore = installShellCapture({ isActive: () => true, emitText });

			fake.bun.spawn(["sh", "-c", 'printf %s "$PI_SESSION_ID"']);
			fake.bun.spawn(["keep"], { env: { CUSTOM: "1" } });
			await new Promise<void>((resolve) => setImmediate(resolve));

			const pinned = fake.spawnCalls[0]?.options;
			expect(pinned?.env).toEqual({ ...process.env });
			expect(pinned?.stderr).toBe("pipe");
			expect(fake.spawnCalls[1]?.options.env).toEqual({ CUSTOM: "1" });
			// The shell default environment is seeded from the same view before wrapping.
			expect(fake.bun.$.calls).toContain("env");
		} finally {
			delete process.env.PI_SESSION_ID;
		}
	});

	it("Given a session environment applied without deletions when Bun.spawn runs without env then the worker view is pinned", async () => {
		const fake = installFakeBun();
		process.env.PI_SESSION_ID = "capture-applied-session";
		globalThis.__senpi_session_env_deletions__ = [];
		globalThis.__senpi_session_env_applied__ = true;
		const { emitText } = emitter();
		try {
			restore = installShellCapture({ isActive: () => true, emitText });

			fake.bun.spawn(["sh", "-c", 'printf %s "$PI_SESSION_ID"']);
			await new Promise<void>((resolve) => setImmediate(resolve));

			const pinned = fake.spawnCalls[0]?.options;
			expect(pinned?.env).toEqual({ ...process.env });
			expect(pinned?.env).toHaveProperty("PI_SESSION_ID", "capture-applied-session");
		} finally {
			delete process.env.PI_SESSION_ID;
		}
	});

	it("Given a session environment when Bun.spawnSync runs without env then the worker view is pinned and explicit env is kept", () => {
		const fake = installFakeBun();
		process.env.PI_SESSION_ID = "capture-sync-session";
		globalThis.__senpi_session_env_applied__ = true;
		try {
			restore = installShellCapture({ isActive: () => true, emitText: emitter().emitText });

			fake.bun.spawnSync(["sh", "-c", 'printf %s "$PI_SESSION_ID"']);
			fake.bun.spawnSync(["keep"], { env: { CUSTOM: "1" } });
			fake.bun.spawnSync({ cmd: ["obj"] });

			expect(fake.spawnSyncCalls[0]?.options.env).toEqual({ ...process.env });
			expect(fake.spawnSyncCalls[0]?.options.env).toHaveProperty("PI_SESSION_ID", "capture-sync-session");
			expect(fake.spawnSyncCalls[1]?.options.env).toEqual({ CUSTOM: "1" });
			expect(fake.spawnSyncCalls[2]?.options.env).toEqual({ ...process.env });
		} finally {
			delete process.env.PI_SESSION_ID;
		}
	});

	it("Given no session environment when Bun.spawnSync runs then it passes through unchanged and restore reinstates it", () => {
		const fake = installFakeBun();
		const originalSpawnSync = fake.bun.spawnSync;
		restore = installShellCapture({ isActive: () => true, emitText: emitter().emitText });
		expect(fake.bun.spawnSync).not.toBe(originalSpawnSync);

		fake.bun.spawnSync(["sh", "-c", "true"]);
		expect(fake.spawnSyncCalls).toEqual([{ cmd: ["sh", "-c", "true"], options: {} }]);

		restore();
		restore = () => {};
		expect(fake.bun.spawnSync).toBe(originalSpawnSync);
	});

	it("Given no session environment when capture installs then spawn options pass through unchanged", async () => {
		const fake = installFakeBun();
		const { emitText } = emitter();
		restore = installShellCapture({ isActive: () => true, emitText });

		fake.bun.spawn(["sh", "-c", 'printf %s "$PI_SESSION_ID"']);
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(fake.spawnCalls).toEqual([
			{ cmd: ["sh", "-c", 'printf %s "$PI_SESSION_ID"'], options: { stderr: "pipe" } },
		]);
		expect(fake.bun.$.calls).toEqual([]);
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
