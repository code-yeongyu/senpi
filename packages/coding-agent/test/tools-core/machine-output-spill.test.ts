import { describe, expect, it } from "vitest";
import { createMachineOutputSpill } from "../../src/core/tools/machine-output-spill.ts";
import { OutputAccumulator } from "../../src/core/tools/output-accumulator-core.ts";
import { createToolMachine } from "../../src/tools-core.ts";
import { createFakeMachine } from "./support/fake-machine.ts";

// Public API contract of createMachineOutputSpill: a spill that never reached the machine reports its own write
// failure, not a cleanup failure layered on top of it.
describe("createMachineOutputSpill", () => {
	it("closes with the write error alone when no chunk reached the machine", async () => {
		const fake = createFakeMachine({ scripts: {}, errorCodes: "fs" });
		const writeError = Object.assign(new Error("read-only file system"), { code: "EROFS" });
		const machine = createToolMachine({
			ops: { ...fake, files: { ...fake.files, write: () => Promise.reject(writeError) } },
		});
		const output = new OutputAccumulator({
			maxBytes: 1,
			spill: createMachineOutputSpill(machine, { tempDir: "/nowhere" }),
		});
		output.append(new TextEncoder().encode("too large"));
		output.finish();

		await expect(output.closeTempFile()).rejects.toBe(writeError);
	});
});
