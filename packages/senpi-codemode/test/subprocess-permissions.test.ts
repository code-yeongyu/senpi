import { describe, expect, it } from "vitest";
import { createInterpreterDetector } from "../src/interpreters/detect.ts";
import { JuliaKernel } from "../src/kernels/jl/kernel.ts";
import { RubyKernel } from "../src/kernels/rb/kernel.ts";

// #4309: unsupported interpreters cannot silently bypass a user's deny.
for (const [language, Kernel] of [
	["rb", RubyKernel],
	["jl", JuliaKernel],
] as const) {
	const interpreter = await createInterpreterDetector().detect(language);
	describe.skipIf(!interpreter.ok)(`${language} permission admission`, () => {
		it.each([false, true])("enforcing=%s is checked before any cell statement", async (active) => {
			if (!interpreter.ok) throw new Error("Interpreter unavailable");
			const rule = { permission: "edit", pattern: "*", layer: "user" };
			const kernel = Kernel.start({
				command: interpreter.path,
				cwd: process.cwd(),
				sessionId: crypto.randomUUID(),
				connection: { port: 1, token: "unused" },
				permissions: { state: () => ({ epoch: 1, active, rules: active ? [rule] : [] }) },
			});
			try {
				const result = await kernel.run({ cellId: "probe", code: "40 + 2", timeoutMs: 60_000 });
				expect(result).toMatchObject(
					active
						? { ok: false, error: { code: "cell_permission_denied", permissionRule: rule } }
						: { ok: true, valueRepr: "42" },
				);
			} finally {
				await kernel.close();
			}
		});
	});
}
