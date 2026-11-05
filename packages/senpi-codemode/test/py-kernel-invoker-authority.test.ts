import { describe, expect, it } from "vitest";
import { createInterpreterDetector } from "../src/interpreters/detect.ts";
import { PythonKernel } from "../src/kernels/py/kernel.ts";

const python = await createInterpreterDetector().detect("py");

// #4309: a Python closure must not share retained resources across enforcing sessions either.
describe.skipIf(!python.ok)("Python invoker authority", () => {
	it.each([
		{ ownerActive: true, invokerActive: false, same: true, denied: false },
		{ ownerActive: true, invokerActive: false, same: false, denied: true },
		{ ownerActive: false, invokerActive: true, same: false, denied: true },
		{ ownerActive: false, invokerActive: false, same: false, denied: false },
	])("refuses before the closure executes: %j", async ({ ownerActive, invokerActive, same, denied }) => {
		if (!python.ok) throw new Error("Python unavailable");
		const ownerId = crypto.randomUUID();
		const invokerId = same ? ownerId : crypto.randomUUID();
		const rule = { permission: "read", pattern: "secret.txt", layer: "user" };
		const kernel = await PythonKernel.start({
			interpreterPath: python.path,
			sessionId: ownerId,
			cwd: process.cwd(),
			connection: { port: 1, token: "unused" },
			permissions: {
				state: () => ({ epoch: 1, active: ownerActive, rules: ownerActive ? [rule] : [] }),
				// The invoking session has no kernel: integration supplies its live permission snapshot.
				resolveSession: () => ({
					cwd: process.cwd(),
					state: { epoch: 2, active: invokerActive, rules: invokerActive ? [rule] : [] },
				}),
			},
		});
		const run = (code: string) => kernel.run({ cellId: crypto.randomUUID(), code, timeoutMs: 8_000 });
		try {
			expect(
				await run("calls = 0\n@tool\ndef probe(invoker):\n    global calls\n    calls += 1\n    return invoker"),
			).toMatchObject({ ok: true });
			const entry = (await kernel.describeKernelTools(["probe"])).results[0];
			if (!entry?.ok) throw new Error("missing Python probe");
			const invoked = kernel.invokeKernelTool(
				{
					...entry.descriptor,
					args: { invoker: { sessionId: ownerId } },
					call_id: crypto.randomUUID(),
				},
				{ invoker: { sessionId: invokerId } },
			);
			if (denied) await expect(invoked).rejects.toMatchObject({ code: "cell_permission_denied", rule });
			else expect(await invoked).toEqual({ sessionId: ownerId });
			expect(await run("calls")).toMatchObject({ ok: true, valueRepr: denied ? "0" : "1" });
		} finally {
			await kernel.close();
		}
	});
});
