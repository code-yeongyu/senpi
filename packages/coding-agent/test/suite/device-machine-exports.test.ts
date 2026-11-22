import { describe, expect, it } from "vitest";
import * as senpi from "../../src/index.ts";

// The public entry carries what an extension needs to supply a device machine (senpi#6720).
describe("device machine exports", () => {
	it("exports the machine factory and both typed errors", () => {
		expect(typeof senpi.createToolMachine).toBe("function");
		expect(new senpi.DeviceUnavailableError("bash").code).toBe("device_unavailable");
		expect(new senpi.DeviceMachineConflictError("a", "b").code).toBe("device_machine_conflict");
	});

	it("a machine built from the public factory carries the ops it was given", () => {
		const ops = { process: {} } as unknown as senpi.MachineOps;
		expect(senpi.createToolMachine({ ops }).ops).toBe(ops);
	});
});
