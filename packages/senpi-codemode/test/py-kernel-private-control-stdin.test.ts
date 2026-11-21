import { afterEach, describe, expect, it } from "vitest";
import type { PythonKernel } from "../src/kernels/py/kernel.ts";
import { hasPython3, liveKernel, runCell } from "./py-kernel/fixtures.ts";

// code-yeongyu/senpi#2980: the kernel's control pipe is its own. A child started from a cell with default stdin must
// not inherit it: on Windows the child hung at startup while the control reader held the pipe, and anywhere a child
// that reads stdin waited on the host's frames (or took them). The child must see EOF at once, and the kernel must
// keep serving cells afterwards.

const python = await hasPython3();
const kernels: PythonKernel[] = [];

describe.skipIf(!python)("python kernel control stdin (#2980)", () => {
	afterEach(async () => {
		while (kernels.length > 0) await kernels.pop()?.close();
	});

	it("gives a cell's child process EOF on stdin instead of the control pipe", async () => {
		const kernel = await liveKernel();
		kernels.push(kernel);

		const child = await runCell(
			kernel,
			[
				"import subprocess, sys",
				"done = subprocess.run([sys.executable, '-c', 'import sys; print(repr(sys.stdin.read()))'],",
				"    capture_output=True, text=True, timeout=5)",
				"f'child:{done.returncode}:{done.stdout.strip()}'",
			].join("\n"),
		);
		expect(child).toMatchObject({ ok: true, valueRepr: expect.stringContaining("child:0:''") });

		const own = await runCell(kernel, "import sys\n'own:' + repr(sys.stdin.read())");
		expect(own).toMatchObject({ ok: true, valueRepr: expect.stringContaining("own:''") });

		const next = await runCell(kernel, "6 * 7");
		expect(next).toMatchObject({ ok: true, valueRepr: "42" });
	});
});
