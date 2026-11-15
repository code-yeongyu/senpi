import { constants } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_LIMITS, type ExecResult, type MachineOps } from "@code-yeongyu/senpi-machine-ops";

export interface ScriptedExec {
	readonly output: readonly { readonly stream: "stdout" | "stderr"; readonly text: string }[];
	readonly exitCode: number | null;
	readonly signal?: string;
}

/**
 * A MachineOps for parity tests: files live in a real directory (the local tools' extras probe the disk), commands
 * never reach a shell and answer from `scripts`. With `errorCodes: "op"` a missing path is reported with the
 * operation layer's own code, as a machine reached over a wire does.
 */
export function createFakeMachine(options: {
	scripts: Readonly<Record<string, ScriptedExec>>;
	errorCodes: "fs" | "op";
}): MachineOps & { readonly calls: string[] } {
	const calls: string[] = [];
	const asOpError = (error: unknown): unknown =>
		options.errorCodes === "op" && error instanceof Error && "code" in error && error.code === "ENOENT"
			? Object.assign(new Error(`not found: ${error.message}`), { code: "not_found" })
			: error;
	const recorded = async <T>(op: string, run: () => Promise<T>): Promise<T> => {
		calls.push(op);
		try {
			return await run();
		} catch (error) {
			throw asOpError(error);
		}
	};
	const unused = (op: string) => () => Promise.reject(new Error(`${op} is not part of the parity scenarios`));
	return {
		calls,
		limits: DEFAULT_LIMITS,
		files: {
			read: (req) =>
				recorded("files.read", async () => {
					const whole = await readFile(req.path);
					const offset = req.offset ?? 0;
					const end = req.limitBytes === undefined ? whole.length : offset + req.limitBytes;
					return { path: req.path, bytes: whole.subarray(offset, end), size: whole.length, offset };
				}),
			write: (req) =>
				recorded("files.write", async () => {
					if (req.createParentDirs) await mkdir(dirname(req.path), { recursive: true });
					if (req.offset === undefined) {
						await writeFile(req.path, req.bytes);
					} else {
						const existing = await readFile(req.path).catch(() => Buffer.alloc(0));
						const next = Buffer.alloc(Math.max(existing.length, req.offset + req.bytes.length));
						existing.copy(next);
						next.set(req.bytes, req.offset);
						await writeFile(req.path, next);
					}
					return { path: req.path, writtenBytes: req.bytes.length };
				}),
			stat: (req) =>
				recorded("files.stat", async () => {
					const info = await stat(req.path);
					if (req.access === "read") await access(req.path, constants.R_OK);
					if (req.access === "readwrite") await access(req.path, constants.R_OK | constants.W_OK);
					const type = info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
					return { path: req.path, type, size: info.size, mtimeMs: info.mtimeMs, mode: info.mode };
				}),
			edit: unused("files.edit"),
			glob: unused("files.glob"),
			grep: unused("files.grep"),
			list: unused("files.list"),
		},
		process: {
			exec: (req) =>
				recorded("process.exec", async (): Promise<ExecResult> => {
					const script = options.scripts[req.command];
					if (script === undefined) throw new Error(`no scripted answer for ${req.command}`);
					for (const chunk of script.output) req.onOutput?.(Buffer.from(chunk.text), chunk.stream);
					return {
						pid: undefined,
						exitCode: script.exitCode,
						signal: script.signal ?? null,
						stdout: new Uint8Array(),
						stderr: new Uint8Array(),
						stdoutTruncated: false,
						stderrTruncated: false,
						timedOut: false,
						aborted: false,
						startedAtMs: 0,
						durationMs: 0,
						scopeToken: undefined,
					};
				}),
			spawn: unused("process.spawn"),
			handle: () => undefined,
			list: () => [],
			sweep: async () => {},
		},
		info: {
			host: () => ({ os: process.platform, arch: process.arch, load1: 0, cores: 1, runtime: "parity-fake" }),
			processInfo: unused("info.processInfo"),
			message: unused("info.message"),
		},
	};
}
