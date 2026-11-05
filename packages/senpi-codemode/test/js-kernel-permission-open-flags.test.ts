import { constants } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";

const cases = [
	{ name: "readonly", flags: constants.O_RDONLY, denied: "write", passes: true },
	{ name: "write-only", flags: constants.O_WRONLY, denied: "read", passes: true },
	{ name: "read-write", flags: constants.O_RDWR, denied: "write", passes: false },
	{ name: "readonly with truncation", flags: constants.O_RDONLY | constants.O_TRUNC, denied: "write", passes: false },
] as const;

describe.each(["worker", "inline"] as const)("open flag grants (%s)", (mode) => {
	it.each(cases)("decides $name without widening or narrowing the mode", async ({ flags, denied, passes }) => {
		const root = await mkdtemp(join(tmpdir(), "permission-flags-"));
		const file = join(root, "target");
		await writeFile(file, "unchanged");
		const kernel = new JavaScriptKernel({
			sessionId: crypto.randomUUID(),
			cwd: root,
			parallelPoolWidth: 2,
			...(mode === "inline" ? { workerEntryUrl: pathToFileURL(join(root, "absent.js")) } : {}),
			permissions: {
				state: () => ({
					active: true,
					epoch: 1,
					rules: [{ permission: denied, pattern: "target", layer: "user" }],
				}),
				decide: (_token, call) =>
					call.tool === denied && call.input.path === "target"
						? { action: "deny", rule: { permission: denied, pattern: "target", layer: "user" } }
						: { action: "pass" },
			},
		});
		try {
			const result = await kernel.run({
				cellId: crypto.randomUUID(),
				code: `const fs=require('node:fs');const fd=fs.openSync('target',${flags});fs.closeSync(fd);return true;`,
				timeoutMs: 8000,
			});
			expect(result.ok).toBe(passes);
			if (!passes) expect(result).toMatchObject({ error: { code: "cell_permission_denied" } });
			expect(await readFile(file, "utf8")).toBe("unchanged");
		} finally {
			await kernel.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
