import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveJsWorkerEntryUrl } from "../src/kernels/js/context-manager.ts";
import { resolveInlineWorkerEntryUrl } from "../src/kernels/js/inline-worker.ts";
import { renderEvalResult } from "../src/tool/render.ts";
import { evalResult, resultContext } from "./eval-render-fixtures.ts";

let tempDir: string | undefined;
afterEach(() => {
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

function sidecar(file: string): { executablePath: string; sidecarPath: string } {
	tempDir = mkdtempSync(join(tmpdir(), "codemode-parity-"));
	const executablePath = join(tempDir, "pi", "pi.exe");
	const sidecarPath = join(
		tempDir,
		"pi",
		"node_modules",
		"@code-yeongyu",
		"senpi-codemode",
		"src",
		"kernels",
		"js",
		file,
	);
	mkdirSync(join(sidecarPath, ".."), { recursive: true });
	writeFileSync(sidecarPath, "worker");
	return { executablePath, sidecarPath };
}

describe("Windows Bun binary worker path", () => {
	it("worker entry under a Windows B:\\~BUN virtual path resolves to the on-disk sidecar", () => {
		const fx = sidecar("worker-entry.js");
		const url = resolveJsWorkerEntryUrl({
			bunVersion: "1.3.14",
			executablePath: fx.executablePath,
			localPath: "B:\\~BUN\\root\\kernels\\js\\worker-entry.js",
		});
		expect(url.pathname).toBe(fx.sidecarPath);
	});
	it("inline worker entry under a Windows B:\\~BUN virtual path resolves to the on-disk sidecar", () => {
		const fx = sidecar("inline-worker-entry.js");
		const url = resolveInlineWorkerEntryUrl({
			bunVersion: "1.3.14",
			executablePath: fx.executablePath,
			localPath: "B:\\~BUN\\root\\kernels\\js\\inline-worker-entry.js",
		});
		expect(url.pathname).toBe(fx.sidecarPath);
	});
});

describe("collapsed preview counts wrapped lines", () => {
	it("one long JSON line does not fill the screen when collapsed", () => {
		const line = JSON.stringify({ rows: Array.from({ length: 400 }, (_, i) => ({ id: i, name: `row-${i}` })) });
		const result = evalResult({ language: "js", durationMs: 1, toolCalls: [], truncated: false }, line);
		const collapsed = renderEvalResult(
			result,
			{ expanded: false, isPartial: false },
			undefined,
			resultContext(),
		).render(80);
		const expanded = renderEvalResult(
			result,
			{ expanded: true, isPartial: false },
			undefined,
			resultContext({ expanded: true }),
		).render(80);
		expect(expanded.length).toBeGreaterThan(100);
		expect(collapsed.length).toBeLessThanOrEqual(14);
	});
});
