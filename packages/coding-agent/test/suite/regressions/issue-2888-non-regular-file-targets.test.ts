import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { EntryType } from "@code-yeongyu/senpi-machine-ops";
import { afterEach, describe, expect, it } from "vitest";
import { createEditTool } from "../../../src/core/tools/edit.ts";
import { createToolMachine, defaultToolMachine, type ToolMachine } from "../../../src/core/tools/machine.ts";
import { createReadTool } from "../../../src/core/tools/read.ts";
import { createWriteTool } from "../../../src/core/tools/write.ts";

// code-yeongyu/senpi#2888: edit, write and read refuse an existing target that is not a regular file before opening it.
// Opening a FIFO with no peer blocks, so each call runs in a child. After its imports the child gives the call 5 s, then
// aborts a call that is still pending and reports whether that settled it; the spawn timeout only guards the worker.

const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const toolUrl = (name: string) =>
	JSON.stringify(pathToFileURL(fileURLToPath(new URL(`../../../src/core/tools/${name}.ts`, import.meta.url))).href);

type Outcome = { outcome: "resolved" | "rejected" | "pending"; message?: string };
type Report = { outcome?: Outcome; afterAbort?: Outcome };
type ToolCall = { module: string; factory: string; args: Record<string, unknown> };
type MachineCall = (cwd: string, machine: ToolMachine, path: string) => Promise<unknown>;

function runToolCall(cwd: string, { module, factory, args }: ToolCall) {
	const script = `import { writeSync } from "node:fs";
		const { ${factory} } = await import(${toolUrl(module)});
		const report = (value) => writeSync(1, JSON.stringify(value) + "\\n");
		const settle = (call, ms) => Promise.race([
			call.then(
				() => ({ outcome: "resolved" }),
				(error) => ({ outcome: "rejected", message: error instanceof Error ? error.message : String(error) }),
			),
			new Promise((resolve) => setTimeout(() => resolve({ outcome: "pending" }), ms)),
		]);
		const controller = new AbortController();
		const call = ${factory}(process.cwd()).execute("c", ${JSON.stringify(args)}, controller.signal);
		const outcome = await settle(call, 5000);
		report({ outcome });
		if (outcome.outcome === "pending") {
			controller.abort();
			report({ afterAbort: await settle(call, 2000) });
			process.kill(process.pid, "SIGKILL");
		}
		process.exit(0);`;
	const child = spawnSync(process.execPath, ["--import", TSX, "--input-type=module", "-e", script], {
		cwd,
		encoding: "utf8",
		timeout: 60_000,
		env: { ...process.env, HOME: cwd },
	});
	const reports = child.stdout
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.map((line) => JSON.parse(line) as Report);
	return {
		outcome: reports.find((report) => report.outcome)?.outcome,
		afterAbort: reports.find((report) => report.afterAbort)?.afterAbort,
		stderr: child.stderr,
	};
}

function machineReporting(type: EntryType): ToolMachine {
	const base = defaultToolMachine().ops;
	let content = "alpha\n";
	return createToolMachine({
		ops: {
			...base,
			files: {
				...base.files,
				async stat({ path }) {
					return { path, type, size: content.length, mtimeMs: 0, mode: 0o600 };
				},
				async read({ path }) {
					const bytes = Buffer.from(content);
					return { path, bytes, size: bytes.length, offset: 0 };
				},
				async write({ path, bytes }) {
					content = Buffer.from(bytes).toString("utf8");
					return { path, writtenBytes: bytes.byteLength };
				},
			},
		},
	});
}

describe.runIf(process.platform !== "win32")("edit, write and read with a non-regular target (#2888)", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function fifoRoot(): string {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "senpi-2888-")));
		roots.push(root);
		const made = spawnSync("mkfifo", [join(root, "pipe")]);
		if (made.status !== 0) throw new Error(`mkfifo failed: ${made.stderr}`);
		return root;
	}

	it.each([
		{
			name: "edit on a FIFO",
			call: {
				module: "edit",
				factory: "createEditTool",
				args: { path: "pipe", edits: [{ oldText: "a", newText: "b" }] },
			},
			refusal: /Could not edit file: pipe\. It is a FIFO, not a regular file\./,
		},
		{
			name: "write on a FIFO",
			call: { module: "write", factory: "createWriteTool", args: { path: "pipe", content: "x" } },
			refusal: /Could not write file: pipe\. It is a FIFO, not a regular file\./,
		},
		{
			name: "read on a FIFO",
			call: { module: "read", factory: "createReadTool", args: { path: "pipe" } },
			refusal: /Could not read file: pipe\. It is a FIFO, not a regular file\./,
		},
		{
			name: "write on a character device",
			call: { module: "write", factory: "createWriteTool", args: { path: "/dev/null", content: "x" } },
			refusal: /Could not write file: \/dev\/null\. It is a character device, not a regular file\./,
		},
	])(
		"$name is refused at once and the target is untouched",
		({ call, refusal }) => {
			const root = fifoRoot();

			const run = runToolCall(root, call);

			expect(run.outcome, `after abort: ${JSON.stringify(run.afterAbort)}; ${run.stderr.slice(-400)}`).toMatchObject(
				{
					outcome: "rejected",
				},
			);
			expect(run.outcome?.message).toMatch(refusal);
			expect(lstatSync(join(root, "pipe")).isFIFO()).toBe(true);
		},
		90_000,
	);

	it.each<{ name: string; call: MachineCall; localSpecialControl: boolean }>([
		{
			name: "edit",
			call: (cwd, machine, path) =>
				createEditTool(cwd, { machine }).execute(
					"c",
					{ path, edits: [{ oldText: "alpha", newText: "beta" }] },
					undefined,
				),
			localSpecialControl: true,
		},
		{
			name: "write",
			call: (cwd, machine, path) =>
				createWriteTool(cwd, { machine }).execute("c", { path, content: "fresh\n" }, undefined),
			localSpecialControl: true,
		},
		{
			name: "read",
			call: (cwd, machine, path) => createReadTool(cwd, { machine }).execute("c", { path }, undefined),
			localSpecialControl: false,
		},
	])("$name follows the configured machine's target type", async ({ call, localSpecialControl }) => {
		const root = fifoRoot();
		writeFileSync(join(root, "regular.txt"), "local\n");

		await expect(call(root, machineReporting("other"), "regular.txt")).rejects.toThrow(
			"It is a special file, not a regular file.",
		);

		if (localSpecialControl) {
			await expect(call(root, machineReporting("file"), "pipe")).resolves.toBeDefined();
		}
	});
});
