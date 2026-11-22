import { afterEach, describe, expect, it } from "vitest";
import type { PythonKernel } from "../src/kernels/py/kernel.ts";
import { hasPython3, liveKernel, runCell } from "./py-kernel/fixtures.ts";

const python = await hasPython3();
const kernels: PythonKernel[] = [];

afterEach(async () => {
	await Promise.allSettled(kernels.splice(0).map((kernel) => kernel.close()));
});

describe.skipIf(!python)("a Python result names the user globals defined so far (senpi#3612)", () => {
	it("lists what cells defined, never the prelude's own helpers", async () => {
		const kernel = await liveKernel();
		kernels.push(kernel);

		await runCell(kernel, "def helper():\n    return 1\nimport json as js_mod");
		const result = await runCell(kernel, "rows = [1, 2]\n_scratch = 3");

		expect(result.globalNames).toEqual(["_scratch", "helper", "js_mod", "rows"]);
		expect(result.globalCount).toBe(4);
	}, 30_000);

	it("caps the names it lists but still counts every global", async () => {
		const kernel = await liveKernel();
		kernels.push(kernel);

		const result = await runCell(kernel, "for i in range(70):\n    globals()[f'g{i:02d}'] = i");

		expect(result.globalNames).toHaveLength(64);
		expect(result.globalCount).toBe(71);
	}, 30_000);
});
