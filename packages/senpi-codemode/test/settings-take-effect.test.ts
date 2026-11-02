import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CodemodeSettings,
	defaultCodemodeSettings,
	type ResolvedCodemodeSettings,
} from "../src/config/settings.ts";
import { type CodemodeSessionManager, createCodemodeSessionManager } from "../src/extension/session-manager.ts";
import {
	createInterpreterDetector,
	getInterpreterAvailability,
	type InterpreterAvailability,
} from "../src/interpreters/detect.ts";
import { ADVERTISED_HELPERS_LINE } from "../src/prompt/eval-prompt.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { FakeManager } from "./eval/fakes.ts";
import { hasPython3 } from "./py-kernel/fixtures.ts";

const managers: CodemodeSessionManager[] = [];
const dirs: string[] = [];

afterEach(async () => {
	await Promise.allSettled(managers.splice(0).map((manager) => manager.dispose()));
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function session(settings: CodemodeSettings): Promise<CodemodeSessionManager> {
	const dir = mkdtempSync(join(tmpdir(), "codemode-settings-effect-"));
	dirs.push(dir);
	const py = await createInterpreterDetector().detect("py");
	const availability: InterpreterAvailability = {
		js: { enabled: true, detected: { ok: true, path: "node", version: process.versions.node } },
		py: { enabled: py.ok, detected: py },
		rb: { enabled: false, detected: { ok: false } },
		jl: { enabled: false, detected: { ok: false } },
	};
	const manager = await createCodemodeSessionManager({
		sessionId: `settings-effect-${crypto.randomUUID()}`,
		cwd: dir,
		settings,
		availability,
		executeTool: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
		complete: async () => {
			throw new Error("completion is not exercised here");
		},
	});
	managers.push(manager);
	return manager;
}

async function runCell(manager: CodemodeSessionManager, language: "js" | "py", code: string) {
	const kernel = await manager.getKernel(language, () => undefined);
	return await kernel.run({ cellId: `cell-${crypto.randomUUID()}`, code, timeoutMs: 20_000 });
}

const disabled: CodemodeSettings = { ...defaultCodemodeSettings, kernelTools: { enabled: false } };
const jsDefinition = "tool(function add(a, b) { return a + b }); return tool.defined()";
const pyDefinition = "@tool\ndef add(a: int, b: int) -> int:\n    return a + b\n\ntool.defined()";

describe("Given kernelTools.enabled", () => {
	it("When it is false, then a JavaScript cell that defines a kernel tool is refused with tools_unavailable naming the setting", async () => {
		const result = await runCell(await session(disabled), "js", jsDefinition);

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toContain("kernelTools.enabled is false");
	});

	it("When it is left at its default, then a JavaScript cell defines the kernel tool", async () => {
		const result = await runCell(await session(defaultCodemodeSettings), "js", jsDefinition);

		expect(result).toMatchObject({ ok: true });
		if (result.ok) expect(result.valueRepr).toContain("add");
	});

	it.skipIf(!hasPython3)(
		"When it is false, then a Python cell that defines an @tool is refused with tools_unavailable naming the setting",
		async () => {
			const result = await runCell(await session(disabled), "py", pyDefinition);

			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.message).toContain("kernelTools.enabled is false");
		},
		30_000,
	);

	it.skipIf(!hasPython3)(
		"When it is false and a Python cell rewrites the environment, then @tool is still refused and the cell never sees the switch",
		async () => {
			const result = await runCell(
				await session(disabled),
				"py",
				[
					"import os, subprocess, sys",
					"seen = 'SENPI_CODEMODE_KERNEL_TOOLS' in os.environ",
					"child = subprocess.run([sys.executable, '-c', \"import os; print('SENPI_CODEMODE_KERNEL_TOOLS' in os.environ)\"], capture_output=True, text=True).stdout.strip()",
					"os.environ['SENPI_CODEMODE_KERNEL_TOOLS'] = '1'",
					"try:",
					"    @tool",
					"    def add(a: int, b: int) -> int:",
					"        return a + b",
					"    outcome = 'defined'",
					"except Exception as error:",
					"    outcome = str(error)",
					"(seen, child, outcome)",
				].join("\n"),
			);

			expect(result).toMatchObject({ ok: true });
			if (result.ok) {
				expect(result.valueRepr).toContain("(False, 'False', ");
				expect(result.valueRepr).toContain("kernelTools.enabled is false");
			}
		},
		30_000,
	);

	it.skipIf(!hasPython3)(
		"When it is left at its default, then a Python cell defines the @tool",
		async () => {
			const result = await runCell(await session(defaultCodemodeSettings), "py", pyDefinition);

			expect(result).toMatchObject({ ok: true });
			if (result.ok) expect(result.valueRepr).toContain("add");
		},
		30_000,
	);
});

describe.skipIf(process.platform === "win32" || !hasPython3)("Given languages.pyInterpreter", () => {
	function wrapperInterpreter(): { readonly path: string; readonly log: string } {
		const dir = mkdtempSync(join(tmpdir(), "codemode-py interp-"));
		dirs.push(dir);
		const bin = join(dir, "with space");
		mkdirSync(bin);
		const log = join(dir, "runs.log");
		const path = join(bin, "python-wrapper");
		writeFileSync(path, `#!/bin/sh\necho run >> "${log}"\nexec python3 "$@"\n`);
		chmodSync(path, 0o755);
		return { path, log };
	}

	it("When it names an executable, then the Python kernel runs through exactly that executable, even with a space in its path", async () => {
		const wrapper = wrapperInterpreter();
		const settings: CodemodeSettings = {
			...defaultCodemodeSettings,
			languages: { ...defaultCodemodeSettings.languages, py: true, pyInterpreter: wrapper.path },
		};
		const availability = await getInterpreterAvailability(settings, createInterpreterDetector());
		const manager = await createCodemodeSessionManager({
			sessionId: `py-interpreter-${crypto.randomUUID()}`,
			cwd: dirs[0] ?? tmpdir(),
			settings,
			availability,
			executeTool: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
			complete: async () => {
				throw new Error("completion is not exercised here");
			},
		});
		managers.push(manager);

		const kernel = await manager.getKernel("py", () => undefined);
		const result = await kernel.run({ cellId: "via-wrapper", code: "6 * 7", timeoutMs: 20_000 });

		expect(availability.py.detected).toMatchObject({ ok: true, path: wrapper.path });
		expect(result).toMatchObject({ ok: true, valueRepr: "42" });
		// The --version probe and the kernel itself both ran through the wrapper.
		expect(readFileSync(wrapper.log, "utf8").trim().split("\n").length).toBeGreaterThanOrEqual(2);
	}, 30_000);

	it("When it names a missing executable, then Python is unavailable with a reason naming the setting", async () => {
		const settings: CodemodeSettings = {
			...defaultCodemodeSettings,
			languages: { ...defaultCodemodeSettings.languages, py: true, pyInterpreter: "/nonexistent/senpi/python3" },
		};

		const availability = await getInterpreterAvailability(settings, createInterpreterDetector());

		expect(availability.py.detected.ok).toBe(false);
		if (!availability.py.detected.ok)
			expect(availability.py.detected.reason).toContain('languages.pyInterpreter "/nonexistent/senpi/python3"');
	});
});

describe("Given prompt.advertiseHelpers", () => {
	const enabledLanguages = { py: true, js: true, rb: false, jl: false };
	const evalTool = (settings: ResolvedCodemodeSettings) =>
		createEvalTool({
			enabledLanguages,
			kernelManager: new FakeManager([]),
			cellTimeoutSeconds: 30,
			executeTool: vi.fn(),
			settings,
		});
	const advertisingSettings: ResolvedCodemodeSettings = {
		...defaultCodemodeSettings,
		prompt: { advertiseHelpers: true },
	};

	it("When it is true, then the eval description ends with the one helper pointer line", () => {
		const tool = evalTool(advertisingSettings);

		expect(tool.description.endsWith(`\n\n${ADVERTISED_HELPERS_LINE}`)).toBe(true);
	});

	it("When it is left at its default, then the eval description is unchanged and carries no pointer", () => {
		const plain = evalTool(defaultCodemodeSettings);
		const advertised = evalTool(advertisingSettings);

		expect(plain.description).not.toContain("tool_schema('eval:helpers')");
		expect(advertised.description).toBe(`${plain.description}\n\n${ADVERTISED_HELPERS_LINE}`);
	});
});
