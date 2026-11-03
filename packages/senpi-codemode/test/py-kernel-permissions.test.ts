import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startBridgeServer } from "../src/bridge/http-server.ts";
import { createInterpreterDetector } from "../src/interpreters/detect.ts";
import type { CellDecider } from "../src/kernels/js/kernel-contract.ts";
import { revokeSessionKernels } from "../src/kernels/js/permission-sessions.ts";
import { PythonKernel } from "../src/kernels/py/kernel.ts";

const python = await createInterpreterDetector().detect("py");
const rule = { permission: "read", pattern: "subject", layer: "user" };
type Case = { name: string; code: string; directory?: boolean; absent?: boolean; exits?: boolean };
const cases: Case[] = [];
for (const api of ["open", "io.open", "io.FileIO"]) {
	for (const mode of ["r", "w", "a", "x", "r+", "w+", "a+", "x+"]) {
		cases.push({
			name: `${api} ${mode}`,
			code: `${api}('subject', '${mode}').close()`,
			absent: mode.startsWith("x"),
		});
	}
}
for (const [name, code] of [
	["os.open read", "fd = os.open('subject', os.O_RDONLY); os.close(fd)"],
	["os.open write", "fd = os.open('subject', os.O_WRONLY); os.close(fd)"],
	["os.open readwrite", "fd = os.open('subject', os.O_RDWR); os.close(fd)"],
	["os.read granted", "fd = os.open('subject', os.O_RDONLY); os.read(fd, 8); os.close(fd)"],
	["os.write granted", "fd = os.open('subject', os.O_WRONLY); os.write(fd, b'changed'); os.close(fd)"],
	["os.remove", "os.remove('subject')"],
	["os.unlink", "os.unlink('subject')"],
	["os.rename source", "os.rename('subject', 'other')"],
	["os.replace source", "os.replace('subject', 'other')"],
	["os.link source", "os.link('subject', 'new-link')"],
	["os.chmod", "os.chmod('subject', 0o600)"],
	["os.truncate", "os.truncate('subject', 0)"],
	["Path.read_text", "Path('subject').read_text()"],
	["Path.read_bytes", "Path('subject').read_bytes()"],
	["Path.write_text", "Path('subject').write_text('changed')"],
	["Path.write_bytes", "Path('subject').write_bytes(b'changed')"],
	["Path.open", "Path('subject').open().close()"],
	["Path.unlink", "Path('subject').unlink()"],
	["Path.rename", "Path('subject').rename('other')"],
	["Path.replace", "Path('subject').replace('other')"],
	["Path.touch", "Path('subject').touch()"],
	["shutil.copyfile source", "shutil.copyfile('subject', 'other')"],
	["shutil.copy source", "shutil.copy('subject', 'other')"],
	["shutil.copy2 source", "shutil.copy2('subject', 'other')"],
	["shutil.copymode source", "shutil.copymode('subject', 'other')"],
	["shutil.copystat source", "shutil.copystat('subject', 'other')"],
	["shutil.move source", "shutil.move('subject', 'other')"],
	["io.open_code", "io.open_code('subject').read()"],
	["_io.open_code", "_io.open_code('subject').read()"],
	["loader.get_data", "importlib.machinery.SourceFileLoader('test_subject', 'subject').get_data('subject')"],
	["prelude read", "read('subject')"],
	["prelude write", "write('subject', 'changed')"],
])
	cases.push({ name, code });
for (const api of ["os.mkdir", "os.makedirs", "Path.mkdir"]) {
	cases.push({
		name: api,
		code: api === "Path.mkdir" ? "Path('subject').mkdir()" : `${api}('subject')`,
		absent: true,
	});
}
for (const [name, code] of [
	["os.rmdir", "os.rmdir('subject')"],
	["Path.rmdir", "Path('subject').rmdir()"],
	["os.listdir", "os.listdir('subject')"],
	["os.scandir", "list(os.scandir('subject'))"],
	["os.walk", "list(os.walk('subject'))"],
	["glob.glob", "glob.glob('subject/*')"],
	["glob.iglob", "list(glob.iglob('subject/*'))"],
	["Path.iterdir", "list(Path('subject').iterdir())"],
	["Path.glob", "list(Path('subject').glob('*'))"],
	["Path.rglob", "list(Path('subject').rglob('*'))"],
	["shutil.copytree", "shutil.copytree('subject', 'copy')"],
	["shutil.rmtree", "shutil.rmtree('subject')"],
])
	cases.push({ name, code, directory: true });
for (const [name, code] of [
	["os.symlink", "os.symlink('other', 'subject')"],
	["Path.symlink_to", "Path('subject').symlink_to('other')"],
	["os.rename destination", "os.rename('other', 'subject')"],
	["os.replace destination", "os.replace('other', 'subject')"],
	["os.link destination", "os.link('other', 'subject')"],
	["shutil.copyfile destination", "shutil.copyfile('other', 'subject')"],
	["shutil.copy destination", "shutil.copy('other', 'subject')"],
	["shutil.copy2 destination", "shutil.copy2('other', 'subject')"],
	["shutil.move destination", "shutil.move('other', 'subject')"],
])
	cases.push({ name, code, absent: true });
const argv = "['/bin/sh', '-c', 'printf spawned > marker']";
for (const [name, code] of [
	["subprocess.Popen argv", `subprocess.Popen(${argv}).wait()`],
	["subprocess.Popen shell", "subprocess.Popen('printf spawned > marker', shell=True).wait()"],
	["os.system", "os.system('printf spawned > marker')"],
	["os.popen", "os.popen('printf spawned > marker').close()"],
	["pty.spawn", `pty.spawn(${argv})`],
	["os.posix_spawn", `os.waitpid(os.posix_spawn('/bin/sh', ${argv}, os.environ), 0)`],
	["os.posix_spawnp", `os.waitpid(os.posix_spawnp('/bin/sh', ${argv}, os.environ), 0)`],
])
	cases.push({ name, code });
for (const prefix of ["exec", "spawn"]) {
	for (const suffix of ["v", "ve", "vp", "vpe", "l", "le", "lp", "lpe"]) {
		const args = suffix.startsWith("v") ? argv : "'/bin/sh', '-c', 'printf spawned > marker'";
		cases.push({
			name: `os.${prefix}${suffix}`,
			code: `os.${prefix}${suffix}(${prefix === "spawn" ? "os.P_WAIT, " : ""}'/bin/sh', ${args}${suffix.endsWith("e") ? ", os.environ" : ""})`,
			exits: prefix === "exec",
		});
	}
}
for (const uri of ["subject", "file:subject?mode=ro", "file:subject?mode=rw", "file:subject?mode=rwc"]) {
	cases.push({
		name: `sqlite3.connect ${uri}`,
		code: `sqlite3.connect('${uri}', uri=True).close()`,
		absent: uri === "subject" || uri.endsWith("rwc"),
	});
}
const imports =
	"import os, io, _io, pathlib, shutil, subprocess, pty, glob, sqlite3, importlib.machinery\nfrom pathlib import Path\n";

async function harness(active: boolean, deny: boolean, item?: Case, customDecide?: CellDecider) {
	if (!python.ok) throw new Error("Python is required for permission enforcement tests");
	const cwd = await mkdtemp(join(tmpdir(), "py-permissions-"));
	if (item?.directory) await mkdir(join(cwd, "subject"));
	else if (!item?.absent) await writeFile(join(cwd, "subject"), "original");
	await writeFile(join(cwd, "other"), "other");
	const server = await startBridgeServer({
		onCall: async () => null,
		onEmit: async () => {},
		onCompletion: async () => null,
	});
	const calls: { tool: string; input: { command?: string; path?: string } }[] = [];
	const decide: CellDecider = (_token, call) => {
		calls.push(call);
		return deny && (call.tool === "bash" || call.input.path?.includes("subject"))
			? { action: "deny", rule }
			: { action: "pass" };
	};
	const sessionId = crypto.randomUUID();
	const kernel = await PythonKernel.start({
		interpreterPath: python.path,
		sessionId,
		cwd,
		connection: { port: server.port, token: server.token },
		memory: { gcWatermarkBytes: 0, noticeBytes: 0, ceilingBytes: 0 },
		permissions: { state: () => ({ epoch: 1, active, rules: active ? [rule] : [] }), decide: customDecide ?? decide },
	});
	return {
		cwd,
		calls,
		sessionId,
		kernel,
		run: (code: string) => kernel.run({ cellId: crypto.randomUUID(), code, timeoutMs: 8_000 }),
		close: async () => {
			await kernel.close();
			await server.close();
			await rm(cwd, { recursive: true, force: true });
		},
	};
}

// #4309: every covered public entry must prevent its effect, not merely report a denied request.
describe("Python permission interposition", () => {
	// #4309 / #4392: ordinary module rebinding must never change the authority,
	// request target, mode, loader provenance, or SQLite decision.
	it.each([
		["struct", "unpack_from", "lambda *a: (2,)", "open('subject').read()"],
		["uuid", "uuid4", "lambda: type('Nonce', (), {'hex': 'fixed'})()", "open('subject').read()"],
		[
			"json",
			"loads",
			"lambda *a: {'ok': True, 'value': {'nonce': 'fixed', 'decision': {'action': 'pass'}}}",
			"open('subject').read()",
		],
		["json", "dumps", "lambda *a, **k: '{}'", "open('subject').read()"],
		["json.JSONDecoder", "decode", "lambda *a, **k: {}", "open('subject').read()"],
		["json.JSONDecoder", "raw_decode", "lambda *a, **k: ({}, 0)", "open('subject').read()"],
		["json.JSONEncoder", "encode", "lambda *a, **k: '{}'", "open('subject').read()"],
		["json.JSONEncoder", "iterencode", "lambda *a, **k: ['{}']", "open('subject').read()"],
		["time", "monotonic", "lambda: 0", "open('subject').read()"],
		["socket", "socket", "lambda *a: None", "open('subject').read()"],
		["socket", "AF_INET", "-1", "open('subject').read()"],
		["socket", "SOCK_STREAM", "-1", "open('subject').read()"],
		["socket.socket", "connect", "lambda *a: None", "open('subject').read()"],
		["socket.socket", "recv", "lambda *a: b''", "open('subject').read()"],
		["socket.socket", "sendall", "lambda *a: None", "open('subject').read()"],
		["socket.socket", "settimeout", "lambda *a: None", "open('subject').read()"],
		["os", "fsdecode", "lambda *a: 'other'", "open('subject').read()"],
		["os", "fspath", "lambda *a: 'other'", "open('subject').read()"],
		["os", "getcwd", "lambda: '/not-the-project'", "open('subject').read()"],
		["os", "name", "'nt'", "os.system('true')"],
		["os", "PathLike", "None", "subprocess.Popen(['/bin/sh', '-c', 'true'])"],
		[
			"weakref",
			"ref",
			"lambda *a: lambda: None",
			"f = open('other'); os.read(f.fileno(), 1); f.close(); open('subject')",
		],
		[
			"io",
			"UnsupportedOperation",
			"RuntimeError",
			"importlib.resources.files('zipped').joinpath('other').open().close(); open('subject')",
		],
		["os", "O_WRONLY", "0", "fd = os.open('subject', saved); os.close(fd)"],
		["os", "O_RDWR", "0", "fd = os.open('subject', saved); os.close(fd)"],
		["os", "O_CREAT", "0", "fd = os.open('subject', saved); os.close(fd)"],
		["os", "O_TRUNC", "0", "fd = os.open('subject', saved); os.close(fd)"],
		["os.path", "join", "lambda *a: 'other'", "fd = os.open('.', 0); os.open('subject', 0, dir_fd=fd)"],
		["os.path", "dirname", "lambda *a: 'other'", "glob.glob('subject/*')"],
		[
			"os.path",
			"basename",
			"lambda *a: 'sh'",
			"subprocess.Popen('true', shell=True, executable='/unsupported-shell')",
		],
		["shlex", "join", "lambda *a: 'true'", "subprocess.Popen(['/bin/sh', '-c', 'true'])"],
		["shlex", "quote", "lambda *a: 'true'", "subprocess.Popen(['/bin/sh', '-c', 'true'])"],
		[
			"urllib.parse",
			"urlsplit",
			"lambda *a: type('URI', (), {'path': ':memory:', 'query': ''})()",
			"sqlite3.connect('file:subject?mode=ro', uri=True)",
		],
		[
			"urllib.parse",
			"parse_qs",
			"lambda *a: {'mode': ['memory']}",
			"sqlite3.connect('file:subject?mode=ro', uri=True)",
		],
		["urllib.parse", "unquote", "lambda *a: ':memory:'", "sqlite3.connect('file:subject?mode=ro', uri=True)"],
		["sqlite3", "SQLITE_ATTACH", "-1", "sqlite3.connect(':memory:').execute(\"ATTACH ':memory:' AS attached\")"],
		["sqlite3", "SQLITE_DENY", "0", "sqlite3.connect(':memory:').execute(\"ATTACH ':memory:' AS attached\")"],
		["sqlite3", "SQLITE_OK", "1", "sqlite3.connect(':memory:').execute('SELECT 42'); open('subject')"],
		[
			"sqlite3",
			"DatabaseError",
			"RuntimeError",
			"sqlite3.connect(':memory:').execute(\"ATTACH ':memory:' AS attached\")",
		],
		["sys", "_getframe", "lambda *a: None", "sys.modules['injected'] = object()"],
		["importlib.util", "resolve_name", "lambda *a: 'os'", "importlib.import_module('.subject_module', 'package')"],
	])("keeps private dependency %s.%s", async (owner, name, replacement, operation) => {
		const flags = name.startsWith("O_");
		const h = await harness(
			true,
			true,
			undefined,
			flags ? (_token, call) => (call.tool === "write" ? { action: "deny", rule } : { action: "pass" }) : undefined,
		);
		try {
			await mkdir(join(h.cwd, "package"));
			await writeFile(join(h.cwd, "package", "__init__.py"), "");
			await writeFile(join(h.cwd, "package", "subject_module.py"), "value = 42");
			if (name === "UnsupportedOperation") {
				if (!python.ok) throw new Error("Python unavailable");
				execFileSync(
					python.path,
					[
						"-c",
						"import zipfile\nwith zipfile.ZipFile('fixture.zip', 'w') as z:\n z.writestr('zipped/__init__.py', '')\n z.writestr('zipped/other', 'data')",
					],
					{ cwd: h.cwd, timeout: 8000 },
				);
			}
			const result = await h.run(
				`${imports}import struct, uuid, json, time, socket, urllib.parse, sys, importlib.util, importlib.resources, shlex, weakref\nsys.path.insert(0, '.')\nsys.path.insert(0, 'fixture.zip')\n` +
					`owner = ${owner}\nsaved = owner.${name}\nsaved_nonce = uuid.uuid4\n` +
					(name === "loads" ? "uuid.uuid4 = lambda: type('Nonce', (), {'hex': 'fixed'})()\n" : "") +
					`try:\n    owner.${name} = ${replacement}\n    ${operation}\nfinally:\n    owner.${name} = saved\n    uuid.uuid4 = saved_nonce`,
			);
			expect(result, JSON.stringify(result)).toMatchObject({
				ok: false,
				error: { code: "cell_permission_denied", permissionRule: rule },
			});
			expect(await readFile(join(h.cwd, "subject"), "utf8")).toBe("original");
			if (["join", "quote"].includes(name) && owner === "shlex")
				expect(h.calls).toContainEqual(
					expect.objectContaining({ tool: "bash", input: { command: "/bin/sh -c true" } }),
				);
			if (
				[
					"struct",
					"uuid",
					"json",
					"json.JSONDecoder",
					"json.JSONEncoder",
					"time",
					"socket",
					"socket.socket",
					"weakref",
				].includes(owner) ||
				["UnsupportedOperation", "SQLITE_OK"].includes(name)
			)
				expect(h.calls).toContainEqual(
					expect.objectContaining({
						tool: "read",
						input: expect.objectContaining({
							path: "subject",
							executedPath: join(realpathSync.native(h.cwd), "subject"),
						}),
					}),
				);
		} finally {
			await h.close();
		}
	});
	it.each([true, false])("preserves settled contexts only without enforcement: active=%s", async (active) => {
		const h = await harness(active, false);
		try {
			expect(
				await h.run(
					"import asyncio, contextvars\nsaved_context = contextvars.copy_context()\nready = asyncio.Event()\n" +
						"async def later():\n    await ready.wait()\n    return open('other').read()\n" +
						"pending = asyncio.create_task(later())",
				),
			).toMatchObject({ ok: true });
			for (const code of ["saved_context.run(lambda: open('other').read())", "ready.set()\nawait pending"]) {
				expect(await h.run(code)).toMatchObject(
					active ? { ok: false, error: { code: "cell_permission_denied" } } : { ok: true, valueRepr: "'other'" },
				);
			}
		} finally {
			await h.close();
		}
	});
	it.each([
		"native.open('subject', os.O_WRONLY)",
		"native.system('printf escaped > marker')",
		"native.mkdir('marker')",
		"native.listdir('subject')",
		"os.utime('subject', None)",
		"os.chown('subject', -1, -1)",
		"os.lchown('subject', -1, -1)",
		"os.mkfifo('subject-new')",
		"os.mknod('subject-new')",
		"os.setxattr('subject', 'user.test', b'value')",
		"os.removexattr('subject', 'user.test')",
		"_io.FileIO.__mro__[1]('subject', 'w')",
	])("prevents native alias or path mutation: %s", async (code) => {
		const h = await harness(true, true, { name: code, code, directory: code.includes("listdir") }, (_token, call) =>
			call.tool === "ls" || call.tool === "write" || call.tool === "bash"
				? { action: "deny", rule }
				: { action: "pass" },
		);
		try {
			const result = await h.run(`${imports}import importlib\nnative = importlib.import_module(os.name)\n${code}`);
			expect(result, JSON.stringify(result)).toMatchObject({ ok: false });
			if (!code.includes("__mro__") && !code.includes("xattr") && !code.includes("mknod"))
				expect(result).toMatchObject({ error: { code: "cell_permission_denied" } });
			expect(existsSync(join(h.cwd, "marker"))).toBe(false);
			expect(existsSync(join(h.cwd, "subject-new"))).toBe(false);
			if (!code.includes("listdir")) expect(await readFile(join(h.cwd, "subject"), "utf8")).toBe("original");
		} finally {
			await h.close();
		}
	});
	it.each([
		"list.append(sys.meta_path, object())",
		"list.clear(sys.path_hooks)",
		"dict.__setitem__(sys.modules, 'injected', object())",
		"vars(sys)['path_hooks'] = []",
		"sys.__dict__['meta_path'] = []",
	])("prevents base descriptor registry mutation: %s", async (code) => {
		const h = await harness(true, false);
		try {
			const result = await h.run(`import sys\n${code}`);
			expect(result).toMatchObject({ ok: false });
			expect(
				await h.run("('injected' not in sys.modules, len(sys.path_hooks) > 0, len(sys.meta_path) > 0)"),
			).toMatchObject({ ok: true, valueRepr: "(True, True, True)" });
		} finally {
			await h.close();
		}
	});
	it.each([
		"list.append(sys.meta_path, object())",
		"list.clear(sys.path_hooks)",
		"dict.__setitem__(sys.modules, 'injected', object())",
		"vars(sys)['path_hooks'] = []",
		"sys.__dict__['meta_path'] = []",
	])("preserves inactive base descriptor mutations: %s", async (code) => {
		const h = await harness(false, false);
		try {
			expect(
				await h.run("import sys\nbefore = (list(sys.meta_path), list(sys.path_hooks), set(sys.modules))"),
			).toMatchObject({ ok: true });
			expect(await h.run(code)).toMatchObject({ ok: true });
			expect(await h.run("before != (list(sys.meta_path), list(sys.path_hooks), set(sys.modules))")).toMatchObject({
				ok: true,
				valueRepr: "True",
			});
		} finally {
			await h.close();
		}
	});
	it.each([true, false])("keeps FileIO subclass and buffered interfaces: active=%s", async (active) => {
		const h = await harness(active, false);
		try {
			expect(
				await h.run(
					"import io\nclass Raw(io.FileIO):\n    pass\n" +
						"raw = Raw('other', 'r')\nassert isinstance(raw, io.RawIOBase)\n" +
						"with io.BufferedReader(raw) as buffered:\n    value = buffered.read()\nvalue",
				),
			).toMatchObject({ ok: true, valueRepr: "b'other'" });
		} finally {
			await h.close();
		}
	});
	it.each([
		"_imp.create_builtin(importlib.machinery.ModuleSpec('_ctypes', importlib.machinery.BuiltinImporter))",
		"_imp.exec_builtin(sys)",
		"_imp.create_dynamic(importlib.machinery.ModuleSpec('missing', None, origin='missing.so'))",
		"_imp.exec_dynamic(sys)",
	])("refuses direct extension entry: %s", async (code) => {
		const h = await harness(true, false);
		try {
			expect(await h.run(`import _imp, sys, importlib.machinery\n${code}`)).toMatchObject({
				ok: false,
				error: { code: "cell_permission_denied", permissionRule: rule },
			});
		} finally {
			await h.close();
		}
	});
	it.each([true, false])("composes SQLite authorizers with custom factories: enforcing=%s", async (active) => {
		const h = await harness(active, false);
		try {
			const setup =
				"import sqlite3\nclass Custom(sqlite3.Connection):\n    def answer(self): return 42\nconnection = sqlite3.connect(':memory:', factory=Custom)\nconnection.set_authorizer(lambda *args: sqlite3.SQLITE_OK)\nconnection.answer()";
			expect(await h.run(setup)).toMatchObject({ ok: true, valueRepr: "42" });
			expect(await h.run("connection.execute(\"ATTACH ':memory:' AS attached\")")).toMatchObject(
				active ? { ok: false, error: { code: "cell_permission_denied", permissionRule: rule } } : { ok: true },
			);
		} finally {
			await h.close();
		}
	});
	for (const policy of ["denied", "allowed", "inactive"]) {
		it.each([
			"resources.files('zipped').joinpath('subject.txt').read_text()",
			"resources.files('zipped').joinpath('subject.txt').read_bytes()",
			"resources.files('zipped').joinpath('subject.txt').open().read()",
			"resources.read_text('zipped', 'subject.txt')",
		])(`${policy} archive resource: %s`, async (code) => {
			const h = await harness(policy !== "inactive", policy !== "allowed");
			try {
				if (!python.ok) throw new Error("Python unavailable");
				execFileSync(
					python.path,
					[
						"-c",
						"import zipfile\nwith zipfile.ZipFile('fixture.zip', 'w') as z:\n z.writestr('zipped/__init__.py', '')\n z.writestr('zipped/subject.txt', 'archive fixture')",
					],
					{
						cwd: h.cwd,
						timeout: 8000,
					},
				);
				const result = await h.run(
					"import sys; sys.path.insert(0, 'fixture.zip')\nfrom importlib import resources\n" + code,
				);
				expect(result).toMatchObject(
					policy === "denied"
						? { ok: false, error: { code: "cell_permission_denied", permissionRule: rule } }
						: { ok: true, valueRepr: expect.stringContaining("archive fixture") },
				);
			} finally {
				await h.close();
			}
		});
	}
	it.each(["os.O_TRUNC", "os.O_CREAT"])("checks write side effects of readonly flags %s", async (flags) => {
		const h = await harness(true, false, { name: flags, code: "", absent: flags === "os.O_CREAT" }, (_token, call) =>
			call.tool === "write" ? { action: "deny", rule } : { action: "pass" },
		);
		try {
			expect(await h.run(`import os\nfd = os.open('subject', os.O_RDONLY | ${flags}); os.close(fd)`)).toMatchObject({
				ok: false,
				error: { code: "cell_permission_denied" },
			});
			if (flags === "os.O_CREAT") expect(existsSync(join(h.cwd, "subject"))).toBe(false);
			else expect(await readFile(join(h.cwd, "subject"), "utf8")).toBe("original");
		} finally {
			await h.close();
		}
	});
	it("keeps engine memory probes working without user read exemptions", async () => {
		const h = await harness(true, true, undefined, () => ({ action: "deny", rule }));
		try {
			expect(await h.run("42")).toMatchObject({ ok: true, memory: { liveBytes: expect.any(Number) } });
			expect(await h.run("open('subject')")).toMatchObject({ ok: false, error: { code: "cell_permission_denied" } });
		} finally {
			await h.close();
		}
	});
	it("allows user imports under a write deny without granting their writes", async () => {
		const h = await harness(true, false, undefined, (_token, call) =>
			call.tool === "write" ? { action: "deny", rule } : { action: "pass" },
		);
		try {
			await writeFile(join(h.cwd, "ordinary_module.py"), "value = 42\n");
			expect(
				await h.run("import sys; sys.path.insert(0, '.')\nimport ordinary_module\nordinary_module.value"),
			).toMatchObject({ ok: true, valueRepr: "42" });
			expect(await h.run("open('marker', 'w')")).toMatchObject({
				ok: false,
				error: { code: "cell_permission_denied" },
			});
			expect(existsSync(join(h.cwd, "marker"))).toBe(false);
		} finally {
			await h.close();
		}
	});
	it.each([true, false])("extension loader and mutation controls: enforcing=%s", async (active) => {
		const h = await harness(active, false);
		try {
			for (const code of [
				"import _json; _json.__spec__.loader.create_module(_json.__spec__)",
				"import _json; _json.__spec__.loader.exec_module(_json)",
				// `_json` is an extension on some builds and a builtin on others; `sys` is always a builtin.
				"import sys; sys.__spec__.loader.create_module(sys.__spec__)",
				"import ctypes",
				"import importlib, os; importlib.reload(os)",
				"import sys; sys.modules['permission_test'] = object()",
			]) {
				const result = await h.run(code);
				expect(result).toMatchObject(
					active ? { ok: false, error: { code: "cell_permission_denied", permissionRule: rule } } : { ok: true },
				);
			}
		} finally {
			await h.close();
		}
	});
	it.each(["open", "io.open", "io.FileIO"])("does not retain a grant after closing %s", async (api) => {
		const h = await harness(true, false);
		try {
			expect(
				await h.run(
					`import io, os\nfile = ${api}('subject', 'r')\nfd = file.fileno()\nfile.close()\nos.read(fd, 0)`,
				),
			).toMatchObject({ ok: false, error: { code: "cell_permission_denied" } });
		} finally {
			await h.close();
		}
	});
	it.each(["", ":memory:", "file:ephemeral?mode=memory"])(
		"in-memory SQLite %s has no file checks",
		async (database) => {
			const h = await harness(true, true);
			try {
				expect(
					await h.run(
						`import sqlite3\nsqlite3.connect(${JSON.stringify(database)}, uri=True).execute('select 42').fetchone()`,
					),
				).toMatchObject({ ok: true, valueRepr: "(42,)" });
				expect(h.calls).toHaveLength(0);
			} finally {
				await h.close();
			}
		},
	);
	it.each(["r", "w", "a", "x", "r+", "w+", "a+", "x+"])("uses the exact tool projection for mode %s", async (mode) => {
		const h = await harness(true, false, { name: mode, code: "", absent: mode.startsWith("x") });
		try {
			expect(await h.run(`open('subject', '${mode}').close()`)).toMatchObject({ ok: true });
			expect(h.calls.filter((call) => call.input.path === "subject").map((call) => call.tool)).toEqual(
				mode.includes("+") ? ["read", "write"] : [mode === "r" ? "read" : "write"],
			);
		} finally {
			await h.close();
		}
	});
	it.each([true, false])("preserves original filesystem exceptions: enforcing=%s", async (active) => {
		const h = await harness(active, false);
		try {
			expect(await h.run("open('does-not-exist')")).toMatchObject({
				ok: false,
				error: { name: "FileNotFoundError" },
			});
		} finally {
			await h.close();
		}
	});
	for (const mode of ["denied", "allowed", "inactive"]) {
		it.each(cases)(`${mode}: $name`, async (item) => {
			const h = await harness(mode !== "inactive", mode !== "allowed", item);
			try {
				if (item.name.startsWith("sqlite3") && !item.absent) {
					// A real SQLite header is required for the allowed readonly control.
					await writeFile(join(h.cwd, "subject"), "");
				}
				const result = await h.run(imports + item.code);
				if (mode === "denied") {
					expect(result).toMatchObject({
						ok: false,
						error: { code: "cell_permission_denied", permissionRule: rule },
					});
					expect(existsSync(join(h.cwd, "marker"))).toBe(false);
					if (item.absent) expect(existsSync(join(h.cwd, "subject"))).toBe(false);
					else if (!item.directory && !item.name.startsWith("sqlite3"))
						expect(await readFile(join(h.cwd, "subject"), "utf8")).toBe("original");
				} else if (item.exits) expect(await readFile(join(h.cwd, "marker"), "utf8")).toBe("spawned");
				else expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
				if (mode === "inactive") expect(h.calls).toHaveLength(0);
			} finally {
				await h.close();
			}
		});
	}

	it.each(["ctypes", "cffi", "_posixsubprocess", "multiprocessing"])("refuses capability import %s", async (name) => {
		const h = await harness(true, false);
		try {
			expect(await h.run(`import ${name}`)).toMatchObject({
				ok: false,
				error: { code: "cell_permission_denied", permissionRule: rule },
			});
		} finally {
			await h.close();
		}
	});
	it.each([
		"import os; os.fork()",
		"import os; os.forkpty()",
		"import importlib, os; importlib.reload(os)",
		"import sys; sys.modules['injected'] = object()",
		"import sys; sys.meta_path.append(object())",
		"import sys; sys.path_hooks.clear()",
		"import sys; sys.modules = {}",
		"import sys; sys.meta_path = []",
		"import sys; sys.path_hooks = []",
		"import os; os.read(0, 1)",
		"import os; os.write(1, b'forbidden')",
		"import sqlite3; sqlite3.connect(':memory:').enable_load_extension(True)",
		"import sqlite3; sqlite3.connect(':memory:').execute(\"ATTACH DATABASE 'attached' AS extra\")",
	])("refuses an enforcing escape before effect: %s", async (code) => {
		const h = await harness(true, false);
		try {
			expect(await h.run(code)).toMatchObject({
				ok: false,
				error: { code: "cell_permission_denied", permissionRule: rule },
			});
			expect(existsSync(join(h.cwd, "attached"))).toBe(false);
		} finally {
			await h.close();
		}
	});

	it.each(["read", "write"])("refuses a descriptor outside its %s grant", async (grant) => {
		const h = await harness(true, false);
		try {
			const result = await h.run(
				`import os\nfd = os.open('subject', os.O_${grant === "read" ? "RDONLY" : "WRONLY"})\nos.${grant === "read" ? "write(fd, b'x')" : "read(fd, 1)"}`,
			);
			expect(result).toMatchObject({ ok: false, error: { code: "cell_permission_denied" } });
		} finally {
			await h.close();
		}
	});
	it("retires the interpreter on revocation before admitting a replacement", async () => {
		const h = await harness(true, false);
		try {
			expect(await h.run("retained = open('subject')")).toMatchObject({ ok: true });
			await revokeSessionKernels(h.sessionId);
			expect(await h.run("'retained' in globals()")).toMatchObject({ ok: true, valueRepr: "False" });
		} finally {
			await h.close();
		}
	});

	it.each([
		"import subject_module",
		"import importlib; importlib.import_module('subject_module')",
		"import importlib.machinery; importlib.machinery.SourceFileLoader('subject_module', 'subject_module.py').get_source('subject_module')",
		"import pkgutil; pkgutil.get_data('data_package', 'subject.txt')",
		"import importlib.resources; importlib.resources.files('data_package').joinpath('subject.txt').read_text()",
		"import importlib.resources; importlib.resources.read_text('data_package', 'subject.txt')",
	])("applies selective read denies to loader and resource reads: %s", async (code) => {
		const h = await harness(true, true);
		try {
			await writeFile(join(h.cwd, "subject_module.py"), "open('marker', 'w').write('loaded')\n");
			await mkdir(join(h.cwd, "data_package"));
			await writeFile(join(h.cwd, "data_package", "__init__.py"), "");
			await writeFile(join(h.cwd, "data_package", "subject.txt"), "secret");
			expect(await h.run("import sys; sys.path.insert(0, '.')\n" + code)).toMatchObject({
				ok: false,
				error: { code: "cell_permission_denied", permissionRule: rule },
			});
			expect(existsSync(join(h.cwd, "marker"))).toBe(false);
		} finally {
			await h.close();
		}
	});
	it.each(["source", "target"])("checks SQLite backup's %s path", async (deniedPath) => {
		let backup = false;
		const h = await harness(true, false, undefined, (_token, call) =>
			backup && call.input.path === deniedPath && call.tool === (deniedPath === "source" ? "read" : "write")
				? { action: "deny", rule }
				: { action: "pass" },
		);
		try {
			expect(
				await h.run(
					"import sqlite3\nsource = sqlite3.connect('source')\ntarget = sqlite3.connect('target')\nsource.execute('create table proof (value)')\nsource.commit()",
				),
			).toMatchObject({ ok: true });
			// Exercise the backup transaction separately from the open-time decisions.
			backup = true;
			expect(await h.run("source.backup(target)")).toMatchObject({
				ok: false,
				error: { code: "cell_permission_denied" },
			});
			expect(
				await h.run("target.execute(\"select name from sqlite_master where name='proof'\").fetchall()"),
			).toMatchObject({ ok: true, valueRepr: "[]" });
		} finally {
			await h.close();
		}
	});
	it("write-only opens do not request read permission", async () => {
		const h = await harness(true, false, undefined, (_token, call) =>
			call.tool === "read" && call.input.path === "subject" ? { action: "deny", rule } : { action: "pass" },
		);
		try {
			expect(await h.run("open('subject', 'w').write('allowed')")).toMatchObject({ ok: true });
			expect(await readFile(join(h.cwd, "subject"), "utf8")).toBe("allowed");
		} finally {
			await h.close();
		}
	});
	it("carries invocation authority into a registered Python callback", async () => {
		const h = await harness(true, true);
		try {
			expect(await h.run("@tool\ndef denied_write():\n    open('subject', 'w').write('changed')")).toMatchObject({
				ok: true,
			});
			const entry = (await h.kernel.describeKernelTools(["denied_write"])).results[0];
			if (!entry?.ok) throw new Error("Missing callback");
			await expect(
				h.kernel.invokeKernelTool({ ...entry.descriptor, call_id: crypto.randomUUID(), args: {} }),
			).rejects.toThrow(/refused/);
			expect(await readFile(join(h.cwd, "subject"), "utf8")).toBe("original");
		} finally {
			await h.close();
		}
	});
	it.each(["throw", "deadline"])("fails closed on a host %s", async (failure) => {
		const h = await harness(true, false, undefined, () => {
			if (failure === "throw") throw new Error("Synthetic host failure");
			return new Promise(() => {});
		});
		try {
			expect(await h.run("open('subject', 'w')")).toMatchObject({
				ok: false,
				error: { code: "cell_permission_denied" },
			});
			expect(await readFile(join(h.cwd, "subject"), "utf8")).toBe("original");
		} finally {
			await h.close();
		}
	});
	it("interrupts a parked permission check without waiting for its deadline", async () => {
		const entered = Promise.withResolvers<void>();
		const cancelled = Promise.withResolvers<void>();
		const h = await harness(true, false, undefined, (token) => {
			token.signal?.addEventListener("abort", () => cancelled.resolve(), { once: true });
			entered.resolve();
			return new Promise(() => {});
		});
		try {
			const result = h.run("open('subject', 'w')");
			await entered.promise;
			const interrupted = await h.kernel.interrupt();
			await cancelled.promise;
			await expect(interrupted.stateRetained).resolves.toBe(true);
			expect(await result).toMatchObject({ ok: false });
			expect(await readFile(join(h.cwd, "subject"), "utf8")).toBe("original");
		} finally {
			await h.close();
		}
	});
});
