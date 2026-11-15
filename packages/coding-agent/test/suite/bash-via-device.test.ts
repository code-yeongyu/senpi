import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createBashTool, DeviceUnavailableError } from "../../src/core/tools/bash.ts";
import { createPowerShellTool } from "../../src/core/tools/powershell.ts";
import type { ToolMachine } from "../../src/core/tools/machine.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { DeviceMachineConflictError } from "../../src/core/extensions/types.ts";
import { createEventBus } from "../../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../src/core/extensions/loader.ts";
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

	it("flag on: the powershell tool, which shares the shell definition, keeps running its own operations", async () => {
		process.env.OMO_TOOLS_VIA_DAEMON = "bash";
		let psRuns = 0;
		const tool = createPowerShellTool(process.cwd(), {
			exposeSessionEnvironment: false,
			operations: {
				exec: async (_command, _cwd, { onData }) => {
					psRuns++;
					onData(Buffer.from("from-powershell\n"));
					return { exitCode: 0 };
				},
			},
		});
		const result = await tool.execute("t3", { command: "Write-Output x" });
		expect(psRuns).toBe(1);
		expect(JSON.stringify(result)).toContain("from-powershell");
	});
});

const sessionBashWith = async (factories: Array<(pi: ExtensionAPI) => void>, command: string): Promise<string> => {
	const harness = await createHarness({ toolRuntime: "in-process", extensionFactories: factories });
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
	"registerDeviceMachine (an extension supplies the session's device)",
	() => {
		it("flag on: a registered device machine runs the session's bash exactly once", async () => {
			process.env.OMO_TOOLS_VIA_DAEMON = "bash";
			const device = fakeDevice();
			const text = await sessionBashWith([(pi) => pi.registerDeviceMachine(device.machine)], "echo RAN-LOCALLY-$$");
			expect(device.commands).toHaveLength(1);
			expect(device.commands[0]).toContain("RAN-LOCALLY");
			expect(text).toContain("from-device");
			expect(text).not.toMatch(/RAN-LOCALLY-\d+/);
		});

		it("flag off: the registered device machine is ignored and bash runs locally", async () => {
			delete process.env.OMO_TOOLS_VIA_DAEMON;
			const device = fakeDevice();
			const text = await sessionBashWith([(pi) => pi.registerDeviceMachine(device.machine)], "echo RAN-LOCALLY-$$");
			expect(device.commands).toHaveLength(0);
			expect(text).toMatch(/RAN-LOCALLY-\d+/);
		});

		it("a second registration is a typed error naming the extension that registered first, and the first stays", async () => {
			process.env.OMO_TOOLS_VIA_DAEMON = "bash";
			const first = fakeDevice();
			const second = fakeDevice();
			let conflict: unknown;
			const text = await sessionBashWith(
				[
					(pi) => pi.registerDeviceMachine(first.machine),
					(pi) => {
						try {
							pi.registerDeviceMachine(second.machine);
						} catch (error) {
							conflict = error;
						}
					},
				],
				"echo probe",
			);
			expect(conflict).toBeInstanceOf(DeviceMachineConflictError);
			expect((conflict as DeviceMachineConflictError).code).toBe("device_machine_conflict");
			expect((conflict as DeviceMachineConflictError).registeredBy).toBe("<inline:1>");
			expect((conflict as DeviceMachineConflictError).attemptedBy).toBe("<inline:2>");
			expect(first.commands).toHaveLength(1);
			expect(second.commands).toHaveLength(0);
			expect(text).toContain("from-device");
		});

		it("an extension that fails to load after registering leaves no device behind; the next one registers cleanly", async () => {
			const runtime = createExtensionRuntime();
			const eventBus = createEventBus();
			const failing = fakeDevice();
			const healthy = fakeDevice();
			await expect(
				loadExtensionFromFactory(
					(pi) => {
						pi.registerDeviceMachine(failing.machine);
						throw new Error("factory fails after registering");
					},
					process.cwd(),
					eventBus,
					runtime,
					"<inline:failing>",
				),
			).rejects.toThrow("factory fails after registering");
			expect(runtime.deviceMachine).toBeUndefined();
			await loadExtensionFromFactory(
				(pi) => pi.registerDeviceMachine(healthy.machine),
				process.cwd(),
				eventBus,
				runtime,
				"<inline:healthy>",
			);
			expect(runtime.deviceMachine?.machine).toBe(healthy.machine);
			expect(runtime.deviceMachine?.extensionPath).toBe("<inline:healthy>");
		});

		it("a second registration within one load is a typed error naming that extension, and the first stays", async () => {
			const runtime = createExtensionRuntime();
			const first = fakeDevice();
			const second = fakeDevice();
			let conflict: unknown;
			await loadExtensionFromFactory(
				(pi) => {
					pi.registerDeviceMachine(first.machine);
					try {
						pi.registerDeviceMachine(second.machine);
					} catch (error) {
						conflict = error;
					}
				},
				process.cwd(),
				createEventBus(),
				runtime,
				"<inline:twice>",
			);
			expect(conflict).toBeInstanceOf(DeviceMachineConflictError);
			expect((conflict as DeviceMachineConflictError).registeredBy).toBe("<inline:twice>");
			expect((conflict as DeviceMachineConflictError).attemptedBy).toBe("<inline:twice>");
			expect(runtime.deviceMachine?.machine).toBe(first.machine);
		});

		it("a registration that lands while another load's is staged fails that load whole, typed, and keeps the first", async () => {
			const runtime = createExtensionRuntime();
			const eventBus = createEventBus();
			const early = fakeDevice();
			const staged = fakeDevice();
			await loadExtensionFromFactory(
				(pi) => {
					pi.events.on("register-now", () => pi.registerDeviceMachine(early.machine));
				},
				process.cwd(),
				eventBus,
				runtime,
				"<inline:early>",
			);
			const error = await loadExtensionFromFactory(
				(pi) => {
					pi.registerDeviceMachine(staged.machine);
					pi.events.emit("register-now", undefined);
				},
				process.cwd(),
				eventBus,
				runtime,
				"<inline:staged>",
			).then(
				() => undefined,
				(caught: unknown) => caught,
			);
			expect(error).toBeInstanceOf(DeviceMachineConflictError);
			expect((error as DeviceMachineConflictError).registeredBy).toBe("<inline:early>");
			expect((error as DeviceMachineConflictError).attemptedBy).toBe("<inline:staged>");
			expect(runtime.deviceMachine?.machine).toBe(early.machine);
		});
	},
);
