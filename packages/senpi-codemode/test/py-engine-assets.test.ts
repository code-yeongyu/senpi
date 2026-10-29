import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startBridgeServer } from "../src/bridge/http-server.ts";
import { createInterpreterDetector } from "../src/interpreters/detect.ts";
import type { CellDecider } from "../src/kernels/js/kernel-contract.ts";
import { PythonKernel } from "../src/kernels/py/kernel.ts";

const python = await createInterpreterDetector().detect("py");
const assetRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "kernels", "py");
const rule = { permission: "read", pattern: "subject", layer: "user" };
const decide: CellDecider = () => ({ action: "pass" });

// #4392: engine assets are source-only. Loading them through a loader caches bytecode
// beside the sources, leaving untracked files in the user's checkout.
describe.skipIf(!python.ok)("Python engine assets", () => {
	it("loads the permission bridge without writing a bytecode cache into the checkout", async () => {
		if (!python.ok) throw new Error("Python is required for engine asset tests");
		const cache = join(assetRoot, "__pycache__");
		await rm(cache, { recursive: true, force: true });
		const cwd = await mkdtemp(join(tmpdir(), "py-engine-assets-"));
		const server = await startBridgeServer({
			onCall: async () => null,
			onEmit: async () => {},
			onCompletion: async () => null,
		});
		const kernel = await PythonKernel.start({
			interpreterPath: python.path,
			sessionId: crypto.randomUUID(),
			cwd,
			connection: { port: server.port, token: server.token },
			permissions: { state: () => ({ epoch: 1, active: true, rules: [rule] }), decide },
		});
		try {
			expect(await kernel.run({ cellId: crypto.randomUUID(), code: "40 + 2", timeoutMs: 8_000 })).toMatchObject({
				ok: true,
				valueRepr: "42",
			});
			expect(existsSync(cache)).toBe(false);
		} finally {
			await kernel.close();
			await server.close();
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
