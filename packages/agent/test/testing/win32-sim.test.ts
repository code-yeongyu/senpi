import { type ChildProcess, spawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	isWin32DrivePath,
	isWin32PipeEndpoint,
	toWin32Path,
	WIN32_PIPE_PREFIX,
	Win32SimFs,
	win32Error,
	win32Kill,
	win32NamesEqual,
	win32PipeEndpoint,
} from "../../src/testing/win32-sim.ts";

const BOUND_MS = 10_000;

function within<T>(promise: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out after ${BOUND_MS}ms: ${label}`)), BOUND_MS);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

let root = "";
let fs: Win32SimFs;

beforeEach(async () => {
	root = await fsp.mkdtemp(path.join(os.tmpdir(), "win32-sim-"));
	fs = new Win32SimFs({ root });
});

afterEach(async () => {
	await fsp.rm(root, { recursive: true, force: true });
});

describe("win32 paths with drive letters", () => {
	it("builds backslash drive-letter paths and maps them under the backing root", async () => {
		expect(toWin32Path("Users/dev/session.jsonl")).toBe("C:\\Users\\dev\\session.jsonl");
		expect(toWin32Path("data", "d")).toBe("D:\\data");
		expect(() => toWin32Path("x", "CD")).toThrow(RangeError);
		expect(() => toWin32Path("/abs")).toThrow(RangeError);
		expect(isWin32DrivePath("C:\\dir")).toBe(true);
		expect(isWin32DrivePath("c:/dir/file")).toBe(true);
		expect(isWin32DrivePath("/posix/dir")).toBe(false);

		await fs.mkdir("C:\\Users\\dev");
		await fs.writeFile("C:\\Users\\dev\\a.txt", "one");
		expect(await fsp.readFile(path.join(root, "C", "Users", "dev", "a.txt"), "utf8")).toBe("one");
		expect((await fs.readFile("C:\\Users\\dev\\..\\dev\\a.txt")).toString()).toBe("one");
		await expect(fs.readFile("/Users/dev/a.txt")).rejects.toThrow(TypeError);
	});
});

describe("case-insensitive names", () => {
	it("resolves any case to the existing entry and keeps the case it was created with", async () => {
		expect(win32NamesEqual("Session.JSONL", "session.jsonl")).toBe(true);
		await fs.mkdir("C:\\Data");
		await fs.writeFile("C:\\Data\\Session.JSONL", "first");

		expect((await fs.readFile("c:\\DATA\\session.jsonl")).toString()).toBe("first");
		expect(await fs.exists("C:\\data\\SESSION.jsonl")).toBe(true);
		await fs.writeFile("C:\\DATA\\SESSION.jsonl", "second");
		expect(await fs.readdir("c:\\data")).toEqual(["Session.JSONL"]);
		expect((await fs.readFile("C:\\Data\\Session.JSONL")).toString()).toBe("second");

		await fs.rename("C:\\Data\\Session.JSONL", "C:\\data\\session.jsonl");
		expect(await fs.readdir("C:\\Data")).toEqual(["session.jsonl"]);
		expect(await fs.exists("C:\\Data\\missing.txt")).toBe(false);
	});
});

describe("named-pipe endpoints", () => {
	it("names local pipes \\\\.\\pipe\\<name> and keeps them out of the filesystem", async () => {
		const endpoint = win32PipeEndpoint("senpi-session-7");
		expect(endpoint).toBe("\\\\.\\pipe\\senpi-session-7");
		expect(endpoint.startsWith(WIN32_PIPE_PREFIX)).toBe(true);
		expect(isWin32PipeEndpoint(endpoint)).toBe(true);
		expect(isWin32PipeEndpoint("\\\\.\\PIPE\\senpi-session-7")).toBe(true);
		expect(win32NamesEqual(endpoint, "\\\\.\\PIPE\\SENPI-SESSION-7")).toBe(true);
		expect(isWin32PipeEndpoint("/tmp/senpi.sock")).toBe(false);
		expect(isWin32PipeEndpoint(WIN32_PIPE_PREFIX)).toBe(false);
		expect(() => win32PipeEndpoint("")).toThrow(RangeError);
		expect(() => win32PipeEndpoint("a\\b")).toThrow(RangeError);
		expect(() => win32PipeEndpoint("x".repeat(256 - WIN32_PIPE_PREFIX.length))).not.toThrow();
		expect(() => win32PipeEndpoint("x".repeat(257 - WIN32_PIPE_PREFIX.length))).toThrow(RangeError);
		expect(isWin32DrivePath(endpoint)).toBe(false);
		await expect(fs.writeFile(endpoint, "x")).rejects.toThrow(TypeError);
	});
});

describe("EBUSY/EPERM on rename or delete of an open file", () => {
	it("refuses rename and delete while open with Windows errors, then allows them after close", async () => {
		await fs.mkdir("C:\\store");
		await fs.writeFile("C:\\store\\db.sqlite", "data");
		await fs.writeFile("C:\\store\\next.sqlite", "next");
		const open = await fs.open("c:\\STORE\\DB.sqlite");

		const renameError = await fs
			.rename("C:\\store\\db.sqlite", "C:\\store\\moved.sqlite")
			.catch((error: unknown) => error);
		expect(renameError).toMatchObject({
			code: "EPERM",
			errno: -4048,
			syscall: "rename",
			path: "C:\\store\\db.sqlite",
			dest: "C:\\store\\moved.sqlite",
		});
		await expect(fs.rename("C:\\store\\next.sqlite", "C:\\store\\db.sqlite")).rejects.toMatchObject({
			code: "EPERM",
		});
		await expect(fs.unlink("C:\\store\\db.sqlite")).rejects.toMatchObject({
			code: "EBUSY",
			errno: -4082,
			syscall: "unlink",
		});
		await expect(fs.rm("C:\\store")).rejects.toMatchObject({ code: "EBUSY", syscall: "rm" });
		expect(await fs.readdir("C:\\store")).toEqual(["db.sqlite", "next.sqlite"]);
		expect((await fs.readFile("C:\\store\\db.sqlite")).toString()).toBe("data");

		await open.close();
		await open.close();
		await fs.rename("C:\\store\\next.sqlite", "C:\\store\\db.sqlite");
		expect((await fs.readFile("C:\\store\\db.sqlite")).toString()).toBe("next");
		await fs.unlink("C:\\store\\db.sqlite");
		await fs.rm("C:\\store");
		expect(await fs.exists("C:\\store")).toBe(false);
	});

	it("keeps a file busy until its last handle closes and uses the configured error codes", async () => {
		const swapped = new Win32SimFs({ root, renameOpenFileError: "EBUSY", deleteOpenFileError: "EPERM" });
		await swapped.mkdir("C:\\wal");
		await swapped.writeFile("C:\\wal\\log", "x");
		const first = await swapped.open("C:\\wal\\log");
		const second = await swapped.open("C:\\WAL\\LOG", "r+");

		await first.close();
		await expect(swapped.rename("C:\\wal\\log", "C:\\wal\\old")).rejects.toMatchObject({
			code: "EBUSY",
			errno: -4082,
		});
		await expect(swapped.unlink("C:\\wal\\log")).rejects.toMatchObject({ code: "EPERM", errno: -4048 });
		await second.close();
		await swapped.unlink("C:\\wal\\log");
		expect(await swapped.readdir("C:\\wal")).toEqual([]);
	});

	it("formats errors the way Node does on Windows", () => {
		const error = win32Error("EBUSY", "rename", "C:\\a", "C:\\b");
		expect(error.message).toBe("EBUSY: resource busy or locked, rename 'C:\\a' -> 'C:\\b'");
		expect(win32Error("ENOSYS", "kill")).toMatchObject({
			code: "ENOSYS",
			errno: -4054,
			message: "ENOSYS: function not implemented, kill",
		});
	});
});

const HANDLER_CHILD = [
	"process.on('SIGTERM', () => { process.stdout.write('handler-ran\\n'); process.exit(0); });",
	"process.on('SIGINT', () => { process.stdout.write('handler-ran\\n'); process.exit(0); });",
	"process.stdout.write('ready\\n');",
	"setInterval(() => {}, 1000);",
].join("\n");

interface RunningChild {
	child: ChildProcess;
	output: () => string;
	closed: Promise<[number | null, NodeJS.Signals | null]>;
}

async function spawnHandlerChild(): Promise<RunningChild> {
	const child = spawn(process.execPath, ["-e", HANDLER_CHILD], { stdio: ["ignore", "pipe", "inherit"] });
	let output = "";
	const ready = new Promise<void>((resolve) => {
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString();
			if (output.includes("ready\n")) resolve();
		});
	});
	const closed = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
		child.once("close", (code: number | null, signal: NodeJS.Signals | null) => resolve([code, signal]));
	});
	await within(ready, "child ready");
	return { child, output: () => output, closed };
}

describe("signal-less process termination", () => {
	it("POSIX contrast: a plain SIGTERM runs the child's handler", async () => {
		const running = await spawnHandlerChild();
		running.child.kill("SIGTERM");
		expect(await within(running.closed, "posix close")).toEqual([0, null]);
		expect(running.output()).toContain("handler-ran");
	});

	it("terminates at once on SIGTERM or SIGINT with no handler running", async () => {
		const byChild = await spawnHandlerChild();
		expect(win32Kill(byChild.child, "SIGTERM")).toBe(true);
		expect(await within(byChild.closed, "win32 close by child")).toEqual([null, "SIGKILL"]);
		expect(byChild.output()).not.toContain("handler-ran");

		const byPid = await spawnHandlerChild();
		const pid = byPid.child.pid;
		if (pid === undefined) throw new Error("child has no pid");
		expect(win32Kill(pid, 0)).toBe(true);
		expect(win32Kill(pid, "SIGINT")).toBe(true);
		expect(await within(byPid.closed, "win32 close by pid")).toEqual([null, "SIGKILL"]);
		expect(byPid.output()).not.toContain("handler-ran");
	});

	it("rejects signals Windows does not support and leaves the process running", async () => {
		const running = await spawnHandlerChild();
		expect(() => win32Kill(running.child, "SIGUSR1")).toThrow(
			expect.objectContaining({ code: "ENOSYS", syscall: "kill" }),
		);
		expect(running.child.exitCode).toBeNull();
		expect(win32Kill(running.child, 0)).toBe(true);
		win32Kill(running.child);
		expect(await within(running.closed, "cleanup close")).toEqual([null, "SIGKILL"]);
	});
});

const PACKAGES_DIR = fileURLToPath(new URL("../../../", import.meta.url));
const MODULE_SPECIFIER = /testing\/win32-sim(\.ts|\.js)?["']/;

describe("test-support boundary", () => {
	it("no product source under packages/*/src imports the profile", async () => {
		const offenders: string[] = [];
		for (const pkg of await fsp.readdir(PACKAGES_DIR)) {
			const src = path.join(PACKAGES_DIR, pkg, "src");
			const files = await fsp.readdir(src, { recursive: true }).catch((error: unknown) => {
				if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
				throw error;
			});
			for (const file of files) {
				if (!/\.(m|c)?[jt]sx?$/.test(file) || /\.test\.|\.spec\./.test(file)) continue;
				const full = path.join(src, file);
				if (full.endsWith(path.join("agent", "src", "testing", "win32-sim.ts"))) continue;
				if (MODULE_SPECIFIER.test(await fsp.readFile(full, "utf8")))
					offenders.push(path.relative(PACKAGES_DIR, full));
			}
		}
		expect(offenders).toEqual([]);
	});
});
