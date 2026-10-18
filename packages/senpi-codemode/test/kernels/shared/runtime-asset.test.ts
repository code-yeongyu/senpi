import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInlineWorkerEntryUrl } from "../../../src/kernels/js/inline-worker.ts";
import { resolvePythonPreludePath } from "../../../src/kernels/py/transport.ts";
import {
	CodemodeRuntimeAssetMissingError,
	isBunVirtualPath,
	requireCodemodeRuntimeAsset,
} from "../../../src/kernels/shared/runtime-asset.ts";

const rel = "kernels/js/inline-worker-entry.js";
function env() {
	const root = mkdtempSync(join(tmpdir(), "codemode-"));
	return { root, executablePath: join(root, "senpi") };
}
function sidecar(root: string, path = rel) {
	const file = join(root, "node_modules/@code-yeongyu/senpi-codemode/src", path);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, "asset");
	return file;
}

describe("codemode runtime assets", () => {
	it("uses local assets", () => {
		const e = env();
		const local = join(e.root, "asset");
		writeFileSync(local, "x");
		expect(requireCodemodeRuntimeAsset(local, rel, e)).toBe(local);
	});
	it("uses the sidecar", () => {
		const e = env();
		const expected = sidecar(e.root);
		expect(requireCodemodeRuntimeAsset(join(e.root, "missing"), rel, e)).toBe(expected);
	});
	it("replaces Bun virtual paths", () => {
		const e = env();
		const expected = sidecar(e.root);
		expect(requireCodemodeRuntimeAsset("/$bunfs/root/inline-worker-entry.js", rel, e)).toBe(expected);
	});
	it("throws an actionable error", () => {
		const e = env();
		const missing = join(e.root, "node_modules/@code-yeongyu/senpi-codemode/src", rel);
		expect(() => requireCodemodeRuntimeAsset("/$bunfs/root/inline-worker-entry.js", rel, e)).toThrow(
			CodemodeRuntimeAssetMissingError,
		);
		expect(() => requireCodemodeRuntimeAsset("/$bunfs/root/inline-worker-entry.js", rel, e)).toThrow(
			`${e.executablePath} (expected ${missing})`,
		);
	});
	it("throws for missing local assets", () => {
		const e = env();
		expect(() => requireCodemodeRuntimeAsset(join(e.root, "missing"), rel, e)).toThrow(
			CodemodeRuntimeAssetMissingError,
		);
	});
	it.each([
		["/$bunfs/x", true],
		["~BUN/x", true],
		["%7EBUN/x", true],
		["/tmp/x", false],
	])("detects virtual path %s", (path, result) => expect(isBunVirtualPath(path)).toBe(result));
	it("propagates through JS resolver", () => {
		const e = env();
		expect(() => resolveInlineWorkerEntryUrl({ ...e, localPath: "/$bunfs/root/inline-worker-entry.js" })).toThrow(
			/codemode runtime asset/,
		);
	});
	it("propagates through Python resolver", () => {
		const e = env();
		expect(() => resolvePythonPreludePath({ ...e, localPath: "/$bunfs/root/prelude.py", bunVersion: "1" })).toThrow(
			/codemode runtime asset/,
		);
	});
});
