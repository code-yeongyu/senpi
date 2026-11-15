import { afterEach, describe, expect, test } from "vitest";
import { createBashTool, DeviceUnavailableError } from "../src/core/tools/bash.ts";
import type { ToolMachine } from "../src/core/tools/machine.ts";

// Slice 1a of the tools-via-daemon plan: an executor seam only, NOT yet via the daemon; the relay transport is slice 1b.
const fakeDevice = () => {
	const commands: string[] = [];
	const machine = {
		ops: {
			process: {
				exec: async (req: { command: string; onOutput?: (data: Buffer, stream: "stdout" | "stderr") => void }) => {
					commands.push(req.command);
					req.onOutput?.(Buffer.from("from-device\n"), "stdout");
					return { exitCode: 7, timedOut: false };
				},
			},
		},
		context: () => ({}),
	} as unknown as ToolMachine;
	return { machine, commands };
};
const text = (result: unknown): string => JSON.stringify(result);
const original = process.env.OMO_TOOLS_VIA_DAEMON;
afterEach(() => {
	if (original === undefined) delete process.env.OMO_TOOLS_VIA_DAEMON;
	else process.env.OMO_TOOLS_VIA_DAEMON = original;
});

describe("bash through the session's device (OMO_TOOLS_VIA_DAEMON, slice 1a seam)", () => {
	test("flag on: the command runs exactly once on the injected device machine, its exit code and output returned", async () => {
		process.env.OMO_TOOLS_VIA_DAEMON = "bash";
		const device = fakeDevice();
		const tool = createBashTool(process.cwd(), { deviceMachine: device.machine, exposeSessionEnvironment: false });
		const result = await tool.execute("t1", { command: "echo hi" }).catch((error: unknown) => error);
		expect(device.commands).toHaveLength(1);
		expect(device.commands[0]).toContain("echo hi");
		expect(text(result)).toContain("from-device");
		expect(text(result)).toContain("7");
	});

	test("flag off: the injected device machine is never used, the command runs locally", async () => {
		delete process.env.OMO_TOOLS_VIA_DAEMON;
		const device = fakeDevice();
		const tool = createBashTool(process.cwd(), { deviceMachine: device.machine, exposeSessionEnvironment: false });
		const result = await tool.execute("t2", { command: "echo local-run" });
		expect(device.commands).toHaveLength(0);
		expect(text(result)).toContain("local-run");
	});

	test("flag on with no device: a typed DeviceUnavailableError, never a local run", async () => {
		process.env.OMO_TOOLS_VIA_DAEMON = "bash";
		const tool = createBashTool(process.cwd(), { exposeSessionEnvironment: false });
		const error = await tool.execute("t3", { command: "echo must-not-run-locally" }).then(
			(r) => r,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(DeviceUnavailableError);
		expect((error as DeviceUnavailableError).code).toBe("device_unavailable");
		expect(text(error)).not.toContain("must-not-run-locally\\n");
	});
});
