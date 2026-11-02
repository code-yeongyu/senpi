import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveJuliaRunnerPath } from "../src/kernels/jl/kernel.ts";
import { resolveJsWorkerEntryUrl } from "../src/kernels/js/context-manager.ts";
import { resolveInlineWorkerEntryUrl } from "../src/kernels/js/inline-worker.ts";
import { resolvePythonPreludePath } from "../src/kernels/py/transport.ts";
import { resolveRubyRunnerPath } from "../src/kernels/rb/kernel.ts";

let tempDir: string | undefined;

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function setupRunner(relativePath: string): {
	executablePath: string;
	localPath: string;
	sidecarPath: string;
} {
	tempDir = mkdtempSync(join(tmpdir(), "senpi-codemode-runner-"));
	const executablePath = join(tempDir, "pi", "pi");
	const sidecarPath = join(tempDir, "pi", "node_modules", "@code-yeongyu", "senpi-codemode", "src", relativePath);
	mkdirSync(join(sidecarPath, ".."), { recursive: true });
	writeFileSync(sidecarPath, "runner");
	return {
		executablePath,
		localPath: join(tempDir, "$bunfs", relativePath.split("/").at(-1) ?? "runner"),
		sidecarPath,
	};
}

describe("compiled codemode runner paths", () => {
	it("resolves the Ruby runner from the executable sidecar", () => {
		const fixture = setupRunner(join("kernels", "rb", "runner.rb"));

		expect(
			resolveRubyRunnerPath({
				bunVersion: "1.3.14",
				executablePath: fixture.executablePath,
				localPath: fixture.localPath,
			}),
		).toBe(fixture.sidecarPath);
	});

	it("resolves the Julia runner from the executable sidecar", () => {
		const fixture = setupRunner(join("kernels", "jl", "runner.jl"));

		expect(
			resolveJuliaRunnerPath({
				bunVersion: "1.3.14",
				executablePath: fixture.executablePath,
				localPath: fixture.localPath,
			}),
		).toBe(fixture.sidecarPath);
	});

	it("resolves the Python prelude from the executable sidecar", () => {
		const fixture = setupRunner(join("kernels", "py", "prelude.py"));

		expect(
			resolvePythonPreludePath({
				bunVersion: "1.3.14",
				executablePath: fixture.executablePath,
				localPath: fixture.localPath,
			}),
		).toBe(fixture.sidecarPath);
	});

	it("resolves the JavaScript worker entry from the executable sidecar", () => {
		const fixture = setupRunner(join("kernels", "js", "worker-entry.js"));

		expect(
			resolveJsWorkerEntryUrl({
				bunVersion: "1.3.14",
				executablePath: fixture.executablePath,
				localPath: fixture.localPath,
			}).pathname,
		).toBe(fixture.sidecarPath);
	});

	it("resolves the inline JavaScript worker entry from the executable sidecar", () => {
		const fixture = setupRunner(join("kernels", "js", "inline-worker-entry.js"));

		expect(
			resolveInlineWorkerEntryUrl({
				bunVersion: "1.3.14",
				executablePath: fixture.executablePath,
				localPath: fixture.localPath,
			}).pathname,
		).toBe(fixture.sidecarPath);
	});

	it("preserves the local runner path outside compiled binaries", () => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-codemode-runner-"));
		const localPath = join(tempDir, "runner.rb");
		writeFileSync(localPath, "runner");

		expect(
			resolveRubyRunnerPath({
				bunVersion: undefined,
				executablePath: join(tempDir, "pi"),
				localPath,
			}),
		).toBe(localPath);
	});
});
