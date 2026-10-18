import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createPythonDisplay,
	formatPythonCell,
	type PythonFormatOptions,
	type PythonInvocation,
} from "../src/tool/display-python.ts";
import { renderEvalCall } from "../src/tool/render.ts";
import { callContext, renderLines } from "./eval-render-fixtures.ts";

const probe = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" });
const pythonPath = probe.status === 0 ? probe.stdout.trim() : "";
const python: PythonInvocation = { command: pythonPath, args: [] };
const AST_ONLY = { strategies: ["ast"], timeoutMs: 10_000 } as const;
const FORMAT_DEADLINE_MS = 15_000;
const FAKE_RUFF_BUDGET_MS = 25_000;

const DENSE_PY_CELL = `import os;x=[0xff,1_000_000,'it\\'s',"a\\nb"];print({"a":1,"b":[i*2 for i in x if isinstance(i,int)]}, f"{os.getcwd()!r:>10}", "con" "cat");y=x if x else None`;

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A freshly written executable can take seconds to first run while the OS scans it, so the fake
// ruff gets the whole formatter budget, and it leaves a marker proving it ran rather than timed out.
function fakeRuff(body: string): { readonly options: PythonFormatOptions; readonly ranMarker: string } {
	const dir = mkdtempSync(join(tmpdir(), "senpi-fake-ruff-"));
	tempDirs.push(dir);
	const ranMarker = join(dir, "ran");
	const ruff = join(dir, "ruff");
	writeFileSync(ruff, ["#!/bin/sh", "cat > /dev/null", `: > ${JSON.stringify(ranMarker)}`, body].join("\n"));
	chmodSync(ruff, 0o755);
	const env = { ...process.env, PATH: `${dir}${delimiter}${dirname(pythonPath)}` };
	return { options: { strategies: ["ruff"], timeoutMs: FAKE_RUFF_BUDGET_MS, env }, ranMarker };
}

function formattedWithin<T>(promise: Promise<T>): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error("python formatter did not settle")), FORMAT_DEADLINE_MS).unref();
		}),
	]);
}

describe.skipIf(pythonPath === "")("Python cell preview through the user's interpreter", () => {
	it("lays out a dense cell with ast.unparse while keeping every literal's source text", async () => {
		await expect(formatPythonCell(DENSE_PY_CELL, python, AST_ONLY)).resolves.toBe(
			[
				"import os",
				`x = [0xff, 1_000_000, 'it\\'s', "a\\nb"]`,
				`print({"a": 1, "b": [i * 2 for i in x if isinstance(i, int)]}, f"{os.getcwd()!r:>10}", "con" "cat")`,
				"y = x if x else None",
			].join("\n"),
		);
	});

	it("keeps top-level await and nested blocks", async () => {
		const code = `for i in range(10):\n    if i%2==0: print(i, "even"); await tick(i)`;
		await expect(formatPythonCell(code, python, AST_ONLY)).resolves.toBe(
			["for i in range(10):", "    if i % 2 == 0:", '        print(i, "even")', "        await tick(i)"].join("\n"),
		);
	});

	it("shows commented, IPython-magic, and invalid cells as sent", async () => {
		const cells = [
			"import os;print(os.getcwd()) # where the kernel runs",
			"%time x=[1,2,3];print(sum(x))",
			"def f(:\n  pass;print(1)",
		];
		for (const cell of cells) await expect(formatPythonCell(cell, python, AST_ONLY)).resolves.toBe(cell);
	});

	it.skipIf(process.platform === "win32")(
		"uses the user's ruff with preserved quotes when it is on PATH",
		async () => {
			const ruff = fakeRuff(
				`case "$*" in *"format --quiet --no-cache --config format.quote-style = 'preserve' --stdin-filename cell.py -"*) printf "import os\\nprint(1)\\n" ;; *) printf "unexpected arguments" ;; esac`,
			);
			await expect(formatPythonCell("import os;print(1)", python, ruff.options)).resolves.toBe(
				"import os\nprint(1)",
			);
			expect(existsSync(ruff.ranMarker)).toBe(true);
		},
	);

	it.skipIf(process.platform === "win32")("rejects a formatter result that rewrites a docstring's text", async () => {
		const ruff = fakeRuff(`printf '"""padded doc"""\\nx = 1\\n'`);
		const cell = '"""   padded doc   """;x=1';
		await expect(formatPythonCell(cell, python, ruff.options)).resolves.toBe(cell);
		expect(existsSync(ruff.ranMarker)).toBe(true);
	});

	it("shows a cell as sent when ast.unparse would print invalid Python", async () => {
		const cell = "x = 1 .real;print(x)";
		await expect(formatPythonCell(cell, python, AST_ONLY)).resolves.toBe(cell);
	});

	it("starts no formatter without a repaint callback, and repaints once the cell is formatted", async () => {
		let interpreterCalls = 0;
		const display = createPythonDisplay({
			...AST_ONLY,
			interpreter: async () => {
				interpreterCalls += 1;
				return python;
			},
		});
		expect(display.display(DENSE_PY_CELL)).toBe(DENSE_PY_CELL);
		expect(interpreterCalls).toBe(0);
		const repainted = new Promise<void>((resolve) => {
			expect(display.display(DENSE_PY_CELL, resolve)).toBe(DENSE_PY_CELL);
		});
		await formattedWithin(repainted);
		expect(interpreterCalls).toBe(1);
		expect(display.display(DENSE_PY_CELL).split("\n")[0]).toBe("import os");
	});

	it("re-renders the eval call frame with the formatted cell after invalidate", async () => {
		let repaint = () => {};
		const invalidated = new Promise<void>((resolve) => {
			repaint = resolve;
		});
		const component = renderEvalCall(
			{ language: "py", code: DENSE_PY_CELL, summary: "Formatting the Python preview" },
			undefined,
			callContext({ spinnerFrame: 0, expanded: true, invalidate: () => repaint() }),
		);
		expect(renderLines(component).some((line) => line.startsWith("\u2502 import os;x=[0xff"))).toBe(true);
		await formattedWithin(invalidated);
		const lines = renderLines(component);
		expect(lines).toContain("\u2502 import os");
		expect(lines.some((line) => line.startsWith("\u2502 import os;x="))).toBe(false);
	});
});
