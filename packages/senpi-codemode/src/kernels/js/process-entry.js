// JavaScript kernel process-mode entry: worker-core over the framed subprocess transport.
//
// Trust model: process mode isolates CRASHES (memory, segfaults, out-of-memory), not hostile code. A cell runs in this
// process and can reach everything it holds, exactly like worker mode; hostile code belongs in isolate: true sandbox
// cells. The frame token below guards against ACCIDENTAL corruption of the channel (a cell's raw fd writes, a child
// process's output), not against a cell that sets out to forge frames.
//
// Channel: the host writes a random token as the first line of fd 0 and frames after it. Where the runtime allows it
// (Bun on macOS/Linux) the frame reader moves to a private duplicate of fd 0 and fd 0 becomes /dev/null, and fd 1 is
// re-pointed at a blocking pipe whose bytes a reader thread writes out as text frames; frames go out on a duplicate
// of the original fd 1 taken before the re-point, under one lock shared by both threads. Every frame is written as
// "<token> <json>", and the host parses only lines that carry it.
//
// Lifetime: the kernel exits the moment its control channel reaches end-of-file (the host closed it, exited or was
// killed). A watchdog thread also checks the parent pid and kills this process when the host is gone, so a cell
// that never yields (a busy loop, a blocking call) cannot keep the kernel alive past its host.
import { closeSync, createReadStream, openSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { Worker } from "node:worker_threads";
import { scanDrainText } from "./process-drain-scan.js";

// Captured before any cell runs, so a cell that later replaces these never sees a frame being built.
const stringify = JSON.stringify;
const writeBytes = writeSync;
const exit = process.exit.bind(process);
const fromString = (text) => Buffer.from(text, "utf8");

// The host refuses a frame over 10 MiB; text is split well below it (a char can escape to 6 bytes of JSON).
const TEXT_CHUNK_CHARS = 1 << 20;
const FRAME_LIMIT_BYTES = 9 * 1024 * 1024;
// Values JSON cannot carry are sent as markers the host turns back into the value, matching worker mode. Each marker
// carries the frame token, so a cell's own data can never be taken for one.
const BIGINT_MARKER = "\u0000senpi:bigint:";
const UNDEFINED_MARKER = "\u0000senpi:undefined:";
const DRAIN_MARKER = "\u0000senpi-drain:";

// Set when libc could not be loaded; shown once, as stderr output of the first cell, so the user sees why.
let libcUnavailableNotice;

function libcSymbols() {
	if (process.platform === "win32") return null;
	const libcPath = { darwin: "/usr/lib/libSystem.B.dylib", linux: "libc.so.6" }[process.platform];
	if (libcPath === undefined) return null;
	let ffi;
	try {
		ffi = createRequire(import.meta.url)("bun:ffi");
	} catch {
		return null;
	}
	try {
		return loadLibcSymbols(ffi, libcPath);
	} catch (error) {
		// dlopen can fail where libc is not where this expects it (a minimal image, an unusual libc). The kernel then
		// runs as it does on Windows, framing on fd 1 without the raw-output pipe, instead of dying before it can say why.
		libcUnavailableNotice = `[senpi-codemode] process kernel: libc could not be loaded (${error instanceof Error ? error.message : String(error)}); raw fd 1 output from child processes is not captured\n`;
		return null;
	}
}

function loadLibcSymbols(ffi, libcPath) {
	const symbols = ffi.dlopen(libcPath, {
		dup: { args: [ffi.FFIType.i32], returns: ffi.FFIType.i32 },
		dup2: { args: [ffi.FFIType.i32, ffi.FFIType.i32], returns: ffi.FFIType.i32 },
		fcntl: { args: [ffi.FFIType.i32, ffi.FFIType.i32, ffi.FFIType.i32], returns: ffi.FFIType.i32 },
		pipe: { args: [ffi.FFIType.ptr], returns: ffi.FFIType.i32 },
		...(process.platform === "linux"
			? {
					prctl: {
						args: [ffi.FFIType.i32, ffi.FFIType.u64, ffi.FFIType.u64, ffi.FFIType.u64, ffi.FFIType.u64],
						returns: ffi.FFIType.i32,
					},
				}
			: {}),
	}).symbols;
	if (!(process.platform === "darwin" && process.arch === "arm64")) return symbols;
	// fcntl is variadic. bun:ffi makes only non-variadic calls, and on Apple arm64 a variadic argument is read from the
	// stack, not a register: declared with six padding arguments, the value is the ninth argument, which is the first
	// stack slot. Elsewhere the three-argument form passes it where fcntl reads it.
	const stackArgs = ffi.dlopen(libcPath, {
		fcntl: {
			args: [
				ffi.FFIType.i32,
				ffi.FFIType.i32,
				ffi.FFIType.i64,
				ffi.FFIType.i64,
				ffi.FFIType.i64,
				ffi.FFIType.i64,
				ffi.FFIType.i64,
				ffi.FFIType.i64,
				ffi.FFIType.i64,
			],
			returns: ffi.FFIType.i32,
		},
	}).symbols;
	return { ...symbols, fcntlStack: stackArgs.fcntl };
}

const libc = libcSymbols();

// On Linux a crash is reported through the kernel's core-dump handler first; where that is a pipe to
// systemd-coredump or apport, the dying child is held until the dump is consumed, which can freeze its cell for
// about 30 s. Marking this process non-dumpable skips the dump, so the crash (signal included) is reported at once.
// exec resets the flag, so a cell's own subprocesses dump as usual. SENPI_KERNEL_CORE_DUMPS=1 keeps dumps.
const PR_SET_DUMPABLE = 4;
if (libc?.prctl !== undefined && process.env.SENPI_KERNEL_CORE_DUMPS !== "1") libc.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0);

/** The control channel's fd: a private duplicate of fd 0 where possible, so a cell reading fd 0 reads /dev/null. */
function privateControlFd() {
	if (libc === null) return 0;
	const duplicate = libc.dup(0);
	if (duplicate === -1) return 0;
	const devNull = openSync("/dev/null", "r");
	// dup2 returns the new descriptor (0) on success and -1 on failure.
	if (libc.dup2(devNull, 0) === -1) {
		closeSync(devNull);
		return duplicate;
	}
	closeSync(devNull);
	return duplicate;
}

const F_GETFL = 3;
const F_SETFL = 4;
const O_NONBLOCK = process.platform === "darwin" ? 0x4 : 0x800;
const variadicOnStack = process.platform === "darwin" && process.arch === "arm64";

function setFileStatusFlags(fd, flags) {
	if (libc === null) return;
	if (variadicOnStack) libc.fcntlStack(fd, F_SETFL, 0, 0, 0, 0, 0, 0, flags);
	else libc.fcntl(fd, F_SETFL, flags);
}

/**
 * Keeps fd 1 blocking. O_NONBLOCK belongs to the pipe's open file description, which every child inheriting fd 1
 * shares: bun sets it the first time a process touches process.stdout and never clears it, and a SIGKILLed node child
 * cannot restore it. A writer that does not retry EAGAIN (`cat`, writeSync) would then lose output whenever it outran
 * the reader thread, so this runs before every cell and before and after every child process a cell starts.
 */
function ensureBlocking() {
	if (libc === null || textPipe === null) return;
	const flags = libc.fcntl(1, F_GETFL, 0);
	if (flags !== -1 && (flags & O_NONBLOCK) !== 0) setFileStatusFlags(1, flags & ~O_NONBLOCK);
}

/** Points fd 1 at a pipe this process reads, so raw fd 1 writes become text frames; null when unavailable. */
function repointStdoutToPipe() {
	if (libc === null) return null;
	const fds = new Int32Array(2);
	if (libc.pipe(fds) !== 0) return null;
	// dup2 returns the new descriptor (1) on success and -1 on failure.
	if (libc.dup2(fds[1], 1) === -1) return null;
	// Bun makes fd 1 non-blocking when process.stdout is first touched: set it up now, then keep it blocking.
	void process.stdout;
	return { readFd: fds[0] };
}

const controlFd = privateControlFd();
// Frames go out on a duplicate of the original fd 1, taken before the re-point. A duplicate rather than a reopen of
// /dev/fd/1: on Linux the spawn's stdout is a socket, which cannot be opened by path.
const duplicatedFd = libc === null ? -1 : libc.dup(1);
const frameFd = duplicatedFd === -1 ? 1 : duplicatedFd;
const textPipe = duplicatedFd === -1 ? null : repointStdoutToPipe();
ensureBlocking();
keepChildProcessesBlocking();

/** Wraps the ways a cell starts a child process, so fd 1 is blocking again before each starts and after it ends. */
function keepChildProcessesBlocking() {
	if (textPipe === null) return;
	const childProcess = createRequire(import.meta.url)("node:child_process");
	for (const name of ["execSync", "execFileSync", "spawnSync"]) {
		const original = childProcess[name];
		childProcess[name] = function (...args) {
			ensureBlocking();
			try {
				return original.apply(this, args);
			} finally {
				ensureBlocking();
			}
		};
	}
	for (const name of ["spawn", "exec", "execFile", "fork"]) {
		const original = childProcess[name];
		childProcess[name] = function (...args) {
			ensureBlocking();
			const child = original.apply(this, args);
			child.once("exit", ensureBlocking);
			return child;
		};
	}
	if (globalThis.Bun === undefined) return;
	const bun = globalThis.Bun;
	const spawnSync = bun.spawnSync;
	const spawn = bun.spawn;
	// Bun.spawn and Bun.spawnSync are writable but not configurable, so they are replaced by assignment (as the
	// per-cell shell capture also does); a redefinition would throw.
	bun.spawnSync = (...args) => {
		ensureBlocking();
		try {
			return spawnSync.apply(bun, args);
		} finally {
			ensureBlocking();
		}
	};
	bun.spawn = (...args) => {
		ensureBlocking();
		const child = spawn.apply(bun, args);
		child.exited.then(ensureBlocking, ensureBlocking);
		return child;
	};
}
const pause = new Int32Array(new SharedArrayBuffer(4));
// Frames are written by this thread and by the fd 1 reader thread; one lock keeps every frame line whole.
const frameLock = new Int32Array(new SharedArrayBuffer(4));

/** Writes all of `bytes`, waiting out a full pipe; a closed channel means the host is gone, so the kernel exits. */
function writeAll(fd, bytes) {
	let offset = 0;
	while (offset < bytes.length) {
		try {
			offset += writeBytes(fd, bytes, offset, bytes.length - offset);
		} catch (error) {
			if (error?.code === "EAGAIN") {
				Atomics.wait(pause, 0, 0, 2);
				continue;
			}
			exit(0);
		}
	}
}

// Without the re-point, cell output shares the channel: a leading newline ends any unterminated output line, so the
// frame always starts its own line.
const framePrefix = textPipe === null ? "\n" : "";
let frameToken;

function replacer(_key, value) {
	if (typeof value === "bigint") return { [`${BIGINT_MARKER}${frameToken}`]: value.toString() };
	if (value === undefined) return { [`${UNDEFINED_MARKER}${frameToken}`]: 1 };
	return value;
}

function writeFrame(message) {
	const bytes = fromString(stringify(message, replacer));
	if (bytes.length <= FRAME_LIMIT_BYTES) {
		const line = Buffer.concat([fromString(`${framePrefix}${frameToken} `), bytes, fromString("\n")]);
		while (Atomics.compareExchange(frameLock, 0, 0, 1) !== 0) Atomics.wait(frameLock, 0, 1, 5);
		try {
			writeAll(frameFd, line);
		} finally {
			Atomics.store(frameLock, 0, 0);
			Atomics.notify(frameLock, 0, 1);
		}
		return;
	}
	const tooLarge = (what) => ({ name: "RangeError", message: `${what} is too large to send (${bytes.length} bytes)` });
	if (message.type === "result") {
		const error = tooLarge("cell result");
		writeFrame({ type: "result", cellId: message.cellId, ok: false, error, durationMs: message.durationMs ?? 0 });
		return;
	}
	if (message.type === "tool-call") {
		// The host never sees the call, so the cell gets the refusal as the call's own failure instead of waiting on it.
		const reply = { type: "tool-reply", callId: message.callId, ok: false, error: tooLarge(`the ${message.toolName} call`) };
		deliver(reply);
		return;
	}
	const data = `[a ${message.type} message of ${bytes.length} bytes was too large to send and was dropped]\n`;
	writeFrame({ type: "text", stream: "stderr", data });
}

function sendFrame(message) {
	if (message.type !== "text" || typeof message.data !== "string" || message.data.length <= TEXT_CHUNK_CHARS) {
		writeFrame(message);
		return;
	}
	for (let start = 0; start < message.data.length; ) {
		let end = Math.min(start + TEXT_CHUNK_CHARS, message.data.length);
		// Never split a surrogate pair.
		if (end < message.data.length && /[\uD800-\uDBFF]/.test(message.data[end - 1])) end -= 1;
		writeFrame({ ...message, data: message.data.slice(start, end) });
		start = end;
	}
}

// A cell that reads stdin sees an already-ended stream instead of the control channel.
const ended = new Readable({
	read() {
		this.push(null);
	},
});
Object.defineProperty(process, "stdin", { value: ended, configurable: true });
if (globalThis.Bun !== undefined) {
	try {
		Object.defineProperty(globalThis.Bun, "stdin", { get: () => ended, configurable: true });
	} catch {
		// Bun.stdin is already non-configurable on this runtime
	}
}

const frameReader = createReadStream("", { fd: controlFd });
const frameLines = createInterface({ input: frameReader });
// End-of-file on the control channel means the host is gone (closed, exited or killed): never outlive it.
frameReader.once("end", () => exit(0));
frameReader.once("close", () => exit(0));
// The same, from a thread a running cell cannot block: once the parent pid changes the host is gone.
const WATCHDOG = `const { workerData } = require("node:worker_threads");
setInterval(() => {
	if (process.ppid !== workerData.parent) process.kill(process.pid, "SIGKILL");
}, 100);`;
new Worker(WATCHDOG, { eval: true, workerData: { parent: process.ppid } }).unref();

let lineHandler;
const bufferedLines = [];
function deliver(message) {
	if (message.type === "run") ensureBlocking();
	if (message.type === "run" && libcUnavailableNotice !== undefined) {
		sendFrame({ type: "text", stream: "stderr", data: libcUnavailableNotice });
		libcUnavailableNotice = undefined;
	}
	if (lineHandler === undefined) bufferedLines.push(message);
	else lineHandler(message);
}
const tokenReceived = new Promise((resolve) => {
	frameLines.on("line", (line) => {
		if (frameToken === undefined) {
			frameToken = line;
			resolve();
			return;
		}
		if (line.length === 0) return;
		deliver(JSON.parse(line));
	});
});

const transport = {
	send(message) {
		if (message.type === "result" && textPipe !== null) {
			drainSequence += 1;
			const key = String(drainSequence);
			pendingResults.set(key, message);
			writeAll(1, fromString(`${DRAIN_MARKER}${key}\u0000`));
			return;
		}
		sendFrame(message);
	},
	onMessage(handler) {
		lineHandler = handler;
		for (const message of bufferedLines.splice(0)) handler(message);
		return () => frameLines.close();
	},
	close() {
		setTimeout(() => exit(0), 0);
	},
};

await tokenReceived;

// Raw fd 1 output is read on its own thread, which writes it out as text frames itself: a cell that fills the pipe
// from this thread (a child process inheriting fd 1, a writeSync loop) never waits on this thread, and output is never
// held in memory while the cell runs. A result waits behind a drain marker written to the same pipe, so every byte a
// cell wrote before it returned reaches the host before its result.
const pendingResults = new Map();
let drainSequence = 0;
const DRAINER = `const { readSync, writeSync } = require("node:fs");
const { StringDecoder } = require("node:string_decoder");
const { parentPort, workerData } = require("node:worker_threads");
const { fd, frameFd, token, lock, marker } = workerData;
const pause = new Int32Array(new SharedArrayBuffer(4));
function writeAll(bytes) {
	let offset = 0;
	while (offset < bytes.length) {
		try {
			offset += writeSync(frameFd, bytes, offset, bytes.length - offset);
		} catch (error) {
			if (error && error.code === "EAGAIN") { Atomics.wait(pause, 0, 0, 2); continue; }
			// The host is gone. process.exit would end only this thread, leaving the frame lock held.
			process.kill(process.pid, "SIGKILL");
		}
	}
}
// One read is at most 64 KiB, so a text frame never nears the frame limit.
function sendText(data) {
	const line = Buffer.from(token + " " + JSON.stringify({ type: "text", stream: "stdout", data }) + "\\n", "utf8");
	while (Atomics.compareExchange(lock, 0, 0, 1) !== 0) Atomics.wait(lock, 0, 1, 5);
	try { writeAll(line); } finally { Atomics.store(lock, 0, 0); Atomics.notify(lock, 0, 1); }
}
const decoder = new StringDecoder("utf8");
const buffer = Buffer.alloc(1 << 16);
let carry = "";
${scanDrainText.toString()}
for (;;) {
	let read;
	try {
		read = readSync(fd, buffer, 0, buffer.length, null);
	} catch {
		break;
	}
	if (read === 0) break;
	const scanned = scanDrainText(carry, decoder.write(buffer.subarray(0, read)), marker);
	carry = scanned.carry;
	for (const part of scanned.parts) {
		if (part.key !== undefined) parentPort.postMessage(part.key);
		else sendText(part.text);
	}
}`;
if (textPipe !== null) {
	const reader = new Worker(DRAINER, {
		eval: true,
		workerData: {
			fd: textPipe.readFd,
			frameFd,
			token: frameToken,
			lock: frameLock,
			marker: DRAIN_MARKER,
		},
	});
	reader.on("message", (key) => {
		const result = pendingResults.get(key);
		pendingResults.delete(key);
		if (result !== undefined) sendFrame(result);
	});
}

// The crash cause reaches the host on stderr, tagged with the token, before the kernel ends (worker mode reports it
// through the thread's error event). It ends by SIGKILL, not process.exit: a crashed kernel runs no more code, and
// Node's exit can stall joining its own platform threads, which would keep a dead kernel and its cell waiting (#2757).
function reportCrash(error) {
	const message = error instanceof Error ? error.message : String(error);
	// Capped well below the host's stderr window, so the cause line is never cut off.
	const cause = { name: error instanceof Error ? error.name : "Error", message: message.slice(0, 4096) };
	// Wait (briefly) for a frame another thread is writing, so the channel ends on a frame boundary and the host reads
	// the crash, not a cut line. Holding the lock past this point keeps any new frame from starting.
	const deadline = Date.now() + 200;
	while (Atomics.compareExchange(frameLock, 0, 0, 1) !== 0 && Date.now() < deadline) Atomics.wait(frameLock, 0, 1, 5);
	try {
		writeBytes(2, fromString(`\nsenpi-kernel-crash ${frameToken} ${stringify(cause)}\n`));
	} finally {
		process.kill(process.pid, "SIGKILL");
	}
}
process.on("uncaughtException", reportCrash);
// Once the worker core is up it reports unhandled rejections to the cells (the kernel keeps running); before that, one
// is a startup crash.
process.on("unhandledRejection", (reason) => {
	if (process.listenerCount("unhandledRejection") === 1) reportCrash(reason);
});

const cwd = process.env.SENPI_CODEMODE_PROCESS_CWD ?? process.cwd();
const poolWidth = Number.parseInt(process.env.SENPI_CODEMODE_PROCESS_POOL_WIDTH ?? "1", 10) || 1;
// Kernel plumbing, not the session's environment: cells and their children do not inherit it.
delete process.env.SENPI_CODEMODE_PROCESS_CWD;
delete process.env.SENPI_CODEMODE_PROCESS_POOL_WIDTH;

const { markKernelProcessMode } = await import("./worker-webview.js");
markKernelProcessMode();

const { createWorkerCore } = await import("./worker-core.js");

createWorkerCore(transport, {
	cwd,
	parallelPoolWidth: poolWidth,
	cwdInstallOptions: { allowMainThread: true },
	processModeMemory: true,
});
