import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultCodemodeSettings } from "../src/config/settings.ts";
import { type CodemodeSessionManager, createCodemodeSessionManager } from "../src/extension/session-manager.ts";
import { createInterpreterDetector, type InterpreterAvailability } from "../src/interpreters/detect.ts";
import type { EvalKernelResult, EvalLanguage } from "../src/tool/types.ts";

const detector = createInterpreterDetector();
const [python, ruby, julia] = await Promise.all([detector.detect("py"), detector.detect("rb"), detector.detect("jl")]);

const managers: CodemodeSessionManager[] = [];
const dirs: string[] = [];

afterEach(async () => {
	await Promise.allSettled(managers.splice(0).map((manager) => manager.dispose()));
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function sessionFor(language: Exclude<EvalLanguage, "js">): Promise<CodemodeSessionManager> {
	const detected = { py: python, rb: ruby, jl: julia }[language];
	const off = { enabled: false, detected: { ok: false } } as const;
	const availability: InterpreterAvailability = {
		js: off,
		py: off,
		rb: off,
		jl: off,
		[language]: { enabled: true, detected },
	};
	const dir = mkdtempSync(join(tmpdir(), "codemode-death-"));
	dirs.push(dir);
	const manager = await createCodemodeSessionManager({
		sessionId: `death-${language}`,
		cwd: dir,
		settings: defaultCodemodeSettings,
		availability,
		executeTool: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
		complete: async () => {
			throw new Error("completion is not exercised here");
		},
	});
	managers.push(manager);
	return manager;
}

let cellCounter = 0;

async function submit(
	manager: CodemodeSessionManager,
	language: Exclude<EvalLanguage, "js">,
	code: string,
): Promise<EvalKernelResult> {
	const kernel = await manager.getKernel(language, () => undefined);
	cellCounter += 1;
	return await kernel.run({ cellId: `${language}-cell-${cellCounter}`, code });
}

function interpreterPid(result: EvalKernelResult): number {
	const pid = Number(result.ok ? result.valueRepr : Number.NaN);
	if (!Number.isInteger(pid) || pid <= 0) throw new Error(`no interpreter pid in ${JSON.stringify(result)}`);
	return pid;
}

/** The interpreter is reaped (and its exit observed by the host) once its pid no longer exists. */
async function killAndAwaitReap(pid: number): Promise<void> {
	process.kill(pid, "SIGKILL");
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`interpreter ${pid} was not reaped`);
}

const restartNotice = (language: string): string =>
	`[${language} kernel was restarted after signal 9; every global is lost]`;

describe("a kernel whose interpreter dies is replaced once and keeps its queue", () => {
	it.skipIf(!ruby.ok)(
		"rb: an interpreter SIGKILLed between cells is replaced and the next cell runs with the notice",
		async () => {
			const manager = await sessionFor("rb");
			const pid = interpreterPid(await submit(manager, "rb", "Process.pid"));

			await killAndAwaitReap(pid);
			const next = await submit(manager, "rb", "1 + 1");

			expect(next).toMatchObject({ ok: true, valueRepr: "2" });
			expect(next.notice).toBe(restartNotice("rb"));
			expect(interpreterPid(await submit(manager, "rb", "Process.pid"))).not.toBe(pid);
		},
		60_000,
	);

	it.skipIf(!julia.ok)(
		"jl: an interpreter SIGKILLed between cells is replaced and the next cell runs with the notice",
		async () => {
			const manager = await sessionFor("jl");
			const pid = interpreterPid(await submit(manager, "jl", "getpid()"));

			await killAndAwaitReap(pid);
			const next = await submit(manager, "jl", "1 + 1");

			expect(next).toMatchObject({ ok: true, valueRepr: "2" });
			expect(next.notice).toBe(restartNotice("jl"));
		},
		180_000,
	);

	it.skipIf(!python.ok)(
		"py: a cell queued behind one whose interpreter dies runs on the replacement, in order",
		async () => {
			const manager = await sessionFor("py");
			const kernel = await manager.getKernel("py", () => undefined);
			const order: string[] = [];
			const run = (cellId: string, code: string) =>
				kernel.run({ cellId, code, onStarted: () => order.push(cellId) });

			const [dying, first, second] = await Promise.all([
				run("dying", "import os\nos.kill(os.getpid(), 9)"),
				run("first", "x = 41\nx + 1"),
				run("second", "x"),
			]);

			expect(dying).toMatchObject({
				ok: false,
				error: { message: expect.stringContaining("every global is lost") },
				kernelState: "lost",
			});
			expect(first).toMatchObject({ ok: true, valueRepr: "42", kernelState: "restarted" });
			expect(first.notice).toBe(restartNotice("py"));
			expect(second).toMatchObject({ ok: true, valueRepr: "41" });
			expect(second.kernelState).toBeUndefined();
			expect(second.notice).toBeUndefined();
			expect(order).toEqual(["dying", "first", "second"]);
		},
		60_000,
	);

	it.skipIf(!python.ok)(
		"py: two deaths back to back fail the queued cell with eval_kernel_unavailable",
		async () => {
			const manager = await sessionFor("py");
			const kernel = await manager.getKernel("py", () => undefined);
			const kill = "import os\nos.kill(os.getpid(), 9)";

			const [firstDeath, secondDeath, stranded] = await Promise.all([
				kernel.run({ cellId: "death-1", code: kill }),
				kernel.run({ cellId: "death-2", code: kill }),
				kernel.run({ cellId: "stranded", code: "1 + 1" }),
			]);

			expect(firstDeath).toMatchObject({ ok: false });
			expect(secondDeath).toMatchObject({ ok: false });
			expect(stranded).toMatchObject({
				ok: false,
				error: { message: expect.stringMatching(/^eval_kernel_unavailable: .*signal 9/) },
				kernelState: "not-run",
			});
			const recovered = await submit(manager, "py", "1 + 1");
			expect(recovered).toMatchObject({ ok: true, valueRepr: "2" });
			expect(recovered.notice).toBe(restartNotice("py"));
		},
		60_000,
	);
});
