// S0 feasibility spike for the Windows private-fd pair (desktop#5194 design rev 2.2, section 8).
// Compiled with `bun build --compile --target=bun-windows-x64`, the same way the desktop builds omo.exe.
// Roles: hop <depth> <clear> <mode> | engine <mode> <clear> | sleep. Fd 5 = r (parent writes), fd 6 = w (parent reads).
// Every result line is `S0 <json>` on stdout, which every hop inherits up to the driver.
import { spawn } from "node:child_process";
import { closeSync, createReadStream, fstatSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";

const role = process.argv[2];
const say = (item: string, data: Record<string, unknown>) =>
	process.stdout.write(`S0 ${JSON.stringify({ item, pid: process.pid, role, ...data })}\n`);

const k32 = dlopen("kernel32.dll", {
	GetFileType: { args: [FFIType.i64], returns: FFIType.u32 },
	GetHandleInformation: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
	SetHandleInformation: { args: [FFIType.i64, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
	WriteFile: { args: [FFIType.i64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	GetLastError: { args: [], returns: FFIType.u32 },
});
const crt = dlopen("ucrtbase.dll", { _get_osfhandle: { args: [FFIType.i32], returns: FFIType.i64 } });

const handleOf = (fd: number) => crt.symbols._get_osfhandle(fd) as bigint;
const inheritFlag = (h: bigint) => {
	const flags = new Uint32Array(1);
	const ok = k32.symbols.GetHandleInformation(h, ptr(flags));
	return ok ? (flags[0] & 1) === 1 : `error ${k32.symbols.GetLastError()}`;
};
const describe = (fd: number) => {
	let type = "none";
	try {
		const s = fstatSync(fd);
		type = s.isFIFO() ? "fifo" : s.isSocket() ? "socket" : s.isFile() ? "file" : s.isCharacterDevice() ? "char" : "other";
	} catch (e) {
		type = `fstat-error ${(e as Error).message}`;
	}
	const h = handleOf(fd);
	const valid = h !== -1n && h !== 0n;
	return {
		fd,
		type,
		handle: valid ? `0x${h.toString(16)}` : String(h),
		fileType: valid ? k32.symbols.GetFileType(h) : null, // 3 = FILE_TYPE_PIPE
		inheritable: valid ? inheritFlag(h) : null,
	};
};
const clearInherit = (fd: number) => {
	const h = handleOf(fd);
	return h !== -1n ? k32.symbols.SetHandleInformation(h, 1, 0) === 1 : false;
};
const childArgs = (args: string[]) => ({
	cmd: process.execPath,
	args: process.execPath.toLowerCase().endsWith("probe.exe") ? args : [process.argv[1]!, ...args],
});

if (role === "sleep") {
	setTimeout(() => process.exit(0), 20_000);
} else if (role === "hop") {
	const depth = Number(process.argv[3]);
	const clear = process.argv[4] === "1";
	const mode = process.argv[5]!;
	const before = [describe(5), describe(6)];
	const cleared = clear ? [clearInherit(5), clearInherit(6)] : null;
	say("hop-receipt", { depth, before, cleared, after: [describe(5), describe(6)] });
	const next = depth > 1 ? ["hop", String(depth - 1), clear ? "1" : "0", mode] : ["engine", mode, clear ? "1" : "0"];
	const { cmd, args } = childArgs(next);
	// Numeric stdio forwarding of fds 5 and 6, as senpi's preparePrivateFdSpawn does.
	const child = spawn(cmd, [...args], { stdio: ["ignore", "inherit", "inherit", "ignore", "ignore", 5, 6] });
	child.once("spawn", () => {
		closeSync(5);
		closeSync(6);
		say("hop-forwarded", { depth, closedOwnCopies: true });
	});
	child.once("exit", (code) => process.exit(code ?? 1));
} else if (role === "engine") {
	const mode = process.argv[3]!;
	const clear = process.argv[4] === "1";
	const received = [describe(5), describe(6)];
	if (clear) {
		clearInherit(5);
		clearInherit(6);
	}
	say("engine-receipt", { mode, received, afterClear: [describe(5), describe(6)] });
	if (mode === "main") {
		// Item 1: the fd->HANDLE mapping is the one Bun's fs uses: bytes written both ways reach the peer.
		writeSync(6, "via-fs\n");
		const h6 = handleOf(6);
		const buf = Buffer.from("via-handle\n");
		const written = new Uint32Array(1);
		const okWrite = k32.symbols.WriteFile(h6, ptr(buf), buf.length, ptr(written), null);
		say("item1-write", { okWrite: okWrite === 1, written: written[0] });
		// Item 4: park a read on r, then write on w while the read is pending.
		const input = createReadStream("", { fd: 5, autoClose: true });
		let buffered = "";
		const scratch = join(tmpdir(), `s0-${process.pid}.txt`);
		writeFileSync(scratch, "x".repeat(4096));
		input.on("data", (chunk) => {
			buffered += chunk.toString();
			if (buffered.includes("go\n") && !buffered.includes("#go")) {
				buffered += "#go";
				// Item 7: closeSync on an inherited CRT fd closes the handle; the driver answers "eof" on r.
				closeSync(6);
				say("item7-closed-w", {});
			}
			if (buffered.includes("eof-seen\n")) {
				say("item7-peer-saw-eof", { ok: true });
				input.destroy();
				process.exit(0);
			}
		});
		setImmediate(() => {
			writeSync(6, "while-read-pending\n");
			say("item4-wrote-while-read-pending", {});
			// Item 8: other fs operations complete while the read on r is parked.
			const started = Date.now();
			for (let i = 0; i < 50; i++) readFileSync(scratch);
			say("item8-fs-while-parked", { syncReads: 50, ms: Date.now() - started });
			void import("node:fs/promises")
				.then((fsp) => Promise.all(Array.from({ length: 20 }, () => fsp.readFile(scratch))))
				.then(() => {
					say("item8-async-fs-while-parked", { asyncReads: 20, ms: Date.now() - started });
					writeSync(6, "ready-for-go\n");
				});
		});
	} else if (mode === "leak") {
		// Item 5: a grandchild spawned with ordinary stdio must not hold w; the driver sees EOF on w while it lives.
		const { cmd, args } = childArgs(["sleep"]);
		const grandchild = spawn(cmd, [...args], { stdio: "ignore" });
		grandchild.once("spawn", () => {
			say("item5-grandchild", { grandchildPid: grandchild.pid });
			closeSync(6);
			say("item5-closed-w", {});
			setTimeout(() => {
				grandchild.kill();
				process.exit(0);
			}, 8_000);
		});
	}
}
