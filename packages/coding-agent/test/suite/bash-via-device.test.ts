import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createBashTool, DeviceUnavailableError } from "../../src/core/tools/bash.ts";
import type { ToolMachine } from "../../src/core/tools/machine.ts";
import { createHarness, getMessageText } from "./harness.ts";

// Slice 1a of the tools-via-daemon plan: an executor seam only, NOT yet via the daemon; the relay transport is slice 1b.
const original = process.env.OMO_TOOLS_VIA_DAEMON;
afterEach(() => {
	if (original === undefined) delete process.env.OMO_TOOLS_VIA_DAEMON;
	else process.env.OMO_TOOLS_VIA_DAEMON = original;
});

const sessionBash = async (command: string): Promise<string> => {
	const harness = await createHarness({ toolRuntime: "in-process" });
	try {
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Run the probe.");
		const result = harness.session.messages.find((message) => message.role === "toolResult");
		return result === undefined ? "" : getMessageText(result);
	} finally {
		await harness.cleanup?.();
	}
};

describe.skipIf(process.platform === "win32")(
	"bash through the session's device in a REAL session (bootstrap injects the dispatcher's operations)",
	() => {
		it("flag on, no device: the session's bash does not run locally and reports the unavailable device", async () => {
			process.env.OMO_TOOLS_VIA_DAEMON = "bash";
			const text = await sessionBash("echo RAN-LOCALLY-$$");
			expect(text).not.toMatch(/RAN-LOCALLY-\d+/);
			expect(text).toContain("device is unavailable");
		});

		it("flag off: the session's bash runs locally as today", async () => {
			delete process.env.OMO_TOOLS_VIA_DAEMON;
			expect(await sessionBash("echo RAN-LOCALLY-$$")).toMatch(/RAN-LOCALLY-\d+/);
		});
	},
);

const fakeDevice = () => {
	const commands: string[] = [];
	const machine = {
		ops: {
			process: {
				exec: async (req: { command: string; onOutput?: (data: Buffer, stream: "stdout" | "stderr") => void }) => {
					commands.push(req.command);
					req.onOutput?.(Buffer.from("from-device\n"), "stdout");
					return { exitCode: 0, timedOut: false };
				},
			},
		},
		context: () => ({}),
	} as unknown as ToolMachine;
	return { machine, commands };
};

describe("bash tool with an injected device machine (slice 1a seam)", () => {
	it("flag on: the command runs exactly once on the device machine and its output comes back", async () => {
		process.env.OMO_TOOLS_VIA_DAEMON = "bash";
		const device = fakeDevice();
		const tool = createBashTool(process.cwd(), { deviceMachine: device.machine, exposeSessionEnvironment: false });
		const result = await tool.execute("t1", { command: "echo hi" });
		expect(device.commands).toHaveLength(1);
		expect(device.commands[0]).toContain("echo hi");
		expect(JSON.stringify(result)).toContain("from-device");
	});

	it("flag on with injected operations and no device: still DeviceUnavailableError, never the injected local path", async () => {
		process.env.OMO_TOOLS_VIA_DAEMON = "bash";
		let localRuns = 0;
		const tool = createBashTool(process.cwd(), {
			exposeSessionEnvironment: false,
			operations: {
				exec: async () => {
					localRuns++;
					return { exitCode: 0 };
				},
			},
		});
		const error = await tool.execute("t2", { command: "echo x" }).then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(DeviceUnavailableError);
		expect((error as DeviceUnavailableError).message).toContain("device is unavailable");
		expect(localRuns).toBe(0);
	});
});
