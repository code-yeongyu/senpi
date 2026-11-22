import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";
import type { CellAuthorityToken } from "../src/kernels/js/kernel-contract.ts";

// #4309: an interrupt kills the active run token at once, not only when the result frame settles it.
describe.each(["worker", "inline"] as const)("permission interrupt window (%s)", (mode) => {
	it("kills active authority before the result and refuses work held in that window", async () => {
		const root = await mkdtemp(join(tmpdir(), "eval-interrupt-window-"));
		const marker = join(root, "after-interrupt");
		const decided = Promise.withResolvers<CellAuthorityToken>();
		const held = Promise.withResolvers<{ action: "pass" }>();
		const kernel = new JavaScriptKernel({
			sessionId: crypto.randomUUID(),
			cwd: root,
			parallelPoolWidth: 2,
			...(mode === "inline" ? { workerEntryUrl: pathToFileURL(join(root, "missing.js")) } : {}),
			permissions: {
				state: () => ({ epoch: 1, active: true, rules: [{ permission: "bash", pattern: "uname", layer: "user" }] }),
				decide: (token) => {
					decided.resolve(token);
					return held.promise;
				},
			},
		});
		try {
			const running = kernel.run({
				cellId: "held",
				timeoutMs: 8_000,
				code: `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "late");`,
			});
			const token = await decided.promise;
			const word = () => Atomics.load(new Int32Array(token.authority), 0);
			expect(word() & 3).toBe(3);
			const interrupting = kernel.interrupt("permission interrupt window");
			// The interrupt frame is posted synchronously; no result frame can have been handled before this line.
			expect(word() & 2).toBe(0);
			held.resolve({ action: "pass" });
			await interrupting;
			expect(await running).toMatchObject({ ok: false });
			expect(existsSync(marker)).toBe(false);
		} finally {
			held.resolve({ action: "pass" });
			await kernel.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
