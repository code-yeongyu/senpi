import { execFile } from "node:child_process";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInterpreterDetector } from "../src/interpreters/detect.ts";

const execute = promisify(execFile);
const python = await createInterpreterDetector().detect("py");
const driver = fileURLToPath(new URL("./fixtures/python-canonical-parity.mjs", import.meta.url));

// #4392: independent cross-language wire contract, not a second fixture decider.
describe("Python canonical identity equals the JS native canonicalizer", () => {
	let root: string;
	let rows: string[];
	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "py-canonical-parity-"));
		mkdirSync(join(root, "Real", "sub"), { recursive: true });
		writeFileSync(join(root, "Real", "sub", "File"), "fixture");
		writeFileSync(join(root, "Real", "secret"), "secret");
		writeFileSync(join(root, "Real", "cafe\u0301"), "unicode");
		linkSync(join(root, "Real", "secret"), join(root, "hardlink"));
		symlinkSync(join(root, "Real", "sub"), join(root, "link"), process.platform === "win32" ? "junction" : "dir");
		symlinkSync("Real/secret", join(root, "flink"));
		symlinkSync("Real/missing", join(root, "dangle"));
		symlinkSync("Real/missing/tail", join(root, "deep-dangle"));
		symlinkSync("loop-b", join(root, "loop-a"));
		symlinkSync("loop-a", join(root, "loop-b"));
		for (let i = 0; i < 42; i++) symlinkSync(i === 41 ? "Real/new" : `hop-${i + 1}`, join(root, `hop-${i}`));
		mkdirSync(join(root, "noperm"));
		chmodSync(join(root, "noperm"), 0);
		rows = [
			"/",
			root,
			"Real/sub/File",
			`${root}/Real/sub/File`,
			"flink",
			"hardlink",
			"link/File",
			"link/../secret",
			"link/../missing",
			"./link/File",
			"Real//sub///File",
			"Real/sub/",
			"Real/new/a/b",
			"Real/sub/File/not-a-directory",
			"dangle",
			"deep-dangle",
			"dangle/child",
			"loop-a",
			"loop-a/child",
			"hop-0",
			"hop-2",
			"REAL/SUB/file",
			"Real/caf\u00e9",
			"Real/cafe\u0301",
			"Real/missing/cafe\u0301",
			"Real/sub/../../new",
			"noperm/child",
			`${root}/missing/${"x".repeat(300)}`,
			`${root}/null\0tail`,
			...(process.platform === "darwin"
				? [`/System/Volumes/Data${root}/Real/secret`, "/System/Volumes/Data/Users", "/dev/null"]
				: ["/proc/self/root", "/dev/null"]),
		];
	});
	afterAll(() => {
		chmodSync(join(root, "noperm"), 0o700);
		rmSync(root, { recursive: true, force: true });
	});
	it.each(["node", "bun"])(
		"matches every canonical field and error under %s",
		async (runtime) => {
			if (!python.ok) throw new Error("Python is required for canonical parity tests");
			const result = await execute(runtime, [driver, python.path, root, JSON.stringify(rows)], {
				cwd: root,
				timeout: 60_000,
			});
			const values: { js: unknown[]; py: unknown[]; freshJs: unknown[]; freshPy: unknown[] } = JSON.parse(
				result.stdout,
			);
			expect(values.py).toHaveLength(rows.length);
			expect(values.freshPy).toHaveLength(rows.length);
			for (const [index, row] of rows.entries()) {
				expect(values.py[index], `${runtime}: ${row}`).toEqual(values.js[index]);
				expect(values.freshPy[index], `${runtime} uncached: ${row}`).toEqual(values.freshJs[index]);
			}
		},
		90_000,
	);
	it.runIf(process.platform !== "win32")("omits a native result that has no lossless UTF-8 wire form", async () => {
		if (!python.ok) throw new Error("Python is required for canonical parity tests");
		// APFS rejects invalid UTF-8 names at creation. Supply the native byte
		// result before capturing libc primitives, not a replacement canonicalizer.
		const result = await execute(
			"node",
			[driver, python.path, root, JSON.stringify(["Real/secret"]), "invalid-native"],
			{ cwd: root, timeout: 60_000 },
		);
		const values: { py: unknown[] } = JSON.parse(result.stdout);
		expect(values.py).toEqual([{}]);
	});
	it.runIf(process.platform === "win32")("leaves drive-relative and device namespace paths to the host", async () => {
		if (!python.ok) throw new Error("Python is required for canonical parity tests");
		const result = await execute(
			"node",
			[driver, python.path, root, JSON.stringify(["C:relative", "\\\\?\\C:\\missing", "\\\\.\\C:\\missing"]), "raw"],
			{ cwd: root, timeout: 60_000 },
		);
		const values: { py: unknown[] } = JSON.parse(result.stdout);
		expect(values.py).toEqual([{}, {}, {}]);
	});
	it("sends no canonical, and still loads, when the interpreter has no ctypes", async () => {
		if (!python.ok) throw new Error("Python is required for canonical parity tests");
		const asset = fileURLToPath(new URL("../src/kernels/py/path_identity.py", import.meta.url));
		// A None entry makes `import ctypes` raise ImportError, as on a Python built without it.
		const code = [
			"import json, os, sys",
			"sys.modules['ctypes'] = None",
			"namespace = {'__file__': sys.argv[1]}",
			"with open(sys.argv[1], 'rb') as source:",
			"    exec(compile(source.read(), sys.argv[1], 'exec'), namespace)",
			"identity = namespace['create_identity']('node')",
			"print(json.dumps([identity(os.path.join(os.getcwd(), p)) for p in ('flink', 'Real/secret')]))",
		].join("\n");
		const result = await execute(python.path, ["-c", code, asset], { cwd: root, timeout: 20_000 });
		expect(JSON.parse(result.stdout)).toEqual([{}, {}]);
	});
	it("matches Win32 lexical joining without dropping earlier path components", async () => {
		if (!python.ok) throw new Error("Python is required for canonical parity tests");
		const inputs = [
			["C:/real", "missing", "D:leaf"],
			["C:/real", "new", "../tail/"],
			["//server/share/real", "new", "D:leaf"],
			["C:/real", "", "tail"],
		];
		const asset = fileURLToPath(new URL("../src/kernels/py/path_identity_windows.py", import.meta.url));
		// Only native DLL initialization is stubbed. These lexical operations are
		// compared to node:path.win32 on every platform, including non-Windows CI.
		const code = [
			"import ctypes, json, sys, types",
			"ctypes.WinDLL = lambda *a, **kw: types.SimpleNamespace(CreateFileW=lambda *a: 0,",
			"    GetFinalPathNameByHandleW=lambda *a: 0, CloseHandle=lambda *a: 0)",
			"ctypes.get_last_error = lambda: 0",
			"namespace = {}",
			"with open(sys.argv[1], 'rb') as source:",
			"    exec(compile(source.read(), sys.argv[1], 'exec'), namespace)",
			"join = namespace['windows_primitives'](OSError)[4]",
			"print(json.dumps([join(*parts) for parts in json.loads(sys.argv[2])]))",
		].join("\n");
		const result = await execute(python.path, ["-c", code, asset, JSON.stringify(inputs)], {
			cwd: root,
			timeout: 20_000,
		});
		expect(JSON.parse(result.stdout)).toEqual(inputs.map((parts) => win32.join(...parts)));
	});
});
