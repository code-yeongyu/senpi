import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultCodemodeSettings } from "../src/config/settings.ts";
import { CodemodeSessionCwdUnavailableError } from "../src/extension/session-cwd.ts";
import { type CodemodeSessionManager, createCodemodeSessionManager } from "../src/extension/session-manager.ts";
import type { InterpreterAvailability } from "../src/interpreters/detect.ts";
import { FakeKernel } from "./eval/fakes.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, stat: vi.fn(actual.stat) };
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, statSync: vi.fn(actual.statSync) };
});

vi.mock("../src/kernels/py/kernel.ts", () => ({
	PythonKernel: {
		start: async () => new FakeKernel([{ type: "result", cellId: "cell", ok: true, durationMs: 0 }]),
	},
}));

const availability: InterpreterAvailability = {
	js: { enabled: false, detected: { ok: false } },
	py: { enabled: true, detected: { ok: true, path: "python", version: "3" } },
	rb: { enabled: false, detected: { ok: false } },
	jl: { enabled: false, detected: { ok: false } },
};

// senpi#3033: count actual filesystem work at the manager boundary, not elapsed time.
describe("warm cells validate the session cwd without async stat round trips", () => {
	let cwd = "";
	let manager: CodemodeSessionManager | undefined;

	afterEach(async () => {
		await manager?.dispose();
		manager = undefined;
		if (cwd) rmSync(cwd, { recursive: true, force: true });
		cwd = "";
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	async function open(): Promise<CodemodeSessionManager> {
		cwd = realpathSync(mkdtempSync(join(tmpdir(), "codemode-warm-cwd-")));
		manager = await createCodemodeSessionManager({
			sessionId: `warm-cwd-${crypto.randomUUID()}`,
			cwd,
			settings: defaultCodemodeSettings,
			availability,
			executeTool: async () => ({ content: [], details: {} }),
			complete: async () => ({ text: "ok", details: { model: "fake/model", structured: false } }),
		});
		return manager;
	}

	async function cell(session: CodemodeSessionManager): Promise<void> {
		const kernel = await session.getKernel("py", () => {});
		expect(await kernel.run({ cellId: "cell", code: "1 + 1" })).toMatchObject({ ok: true });
	}

	it("performs zero async stat round trips on each warm cell", async () => {
		// Given: a completed first cell has created the persistent kernel.
		const session = await open();
		await cell(session);
		vi.mocked(stat).mockClear();
		vi.mocked(statSync).mockClear();

		// When: three further cells reuse it.
		const roundTrips: number[] = [];
		for (let index = 0; index < 3; index++) {
			const before = vi.mocked(stat).mock.calls.length;
			await cell(session);
			roundTrips.push(vi.mocked(stat).mock.calls.length - before);
		}

		// Then: every cell still checks the directory, without scheduling async filesystem work.
		console.log(`WARM_CWD async_stat_round_trips_per_cell=${JSON.stringify(roundTrips)}`);
		expect(roundTrips).toEqual([0, 0, 0]);
		expect(vi.mocked(statSync).mock.calls.map(([target]) => target)).toEqual([cwd, cwd, cwd]);
	});

	it.each(["deleted", "replaced by a file"])("refuses the very next cell when the cwd is %s", async (change) => {
		// Given: a real cwd and one successfully completed cell.
		const session = await open();
		await cell(session);

		// When: the directory changes between cells.
		rmSync(cwd, { recursive: true, force: true });
		if (change === "replaced by a file") writeFileSync(cwd, "");
		const next = cell(session);

		// Then: the next cell is refused with exactly the existing error.
		const reason = change === "deleted" ? "ENOENT" : "not a directory";
		const expected = new CodemodeSessionCwdUnavailableError(cwd, reason);
		await expect(next).rejects.toMatchObject({ name: expected.name, cwd, message: expected.message });
	});

	it.each(["EACCES", "ELOOP", "EMFILE", "EIO"])("surfaces the original %s error on warm reuse", async (code) => {
		// Given: a warm kernel and a filesystem failure that reopening cannot repair.
		const session = await open();
		await cell(session);
		const error = Object.assign(new Error("filesystem failure"), { code });
		vi.mocked(statSync).mockImplementationOnce(() => {
			throw error;
		});

		// When / Then: real I/O failures are neither hidden nor relabelled as a missing cwd.
		await expect(cell(session)).rejects.toBe(error);
	});
});
