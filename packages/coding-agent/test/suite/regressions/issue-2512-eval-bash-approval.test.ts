import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import permissionSystemExtension from "../../../src/core/extensions/builtin/permission-system/index.ts";
import { createBashTool } from "../../../src/core/tools/bash.ts";
import { createHarness, createTestUiContext, getMessageText, getToolResult } from "../harness.ts";
import { createEvalApprovalHost } from "./eval-approval-host.ts";

const hosts: Awaited<ReturnType<typeof createEvalApprovalHost>>[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.dispose();
});

describe("eval bash approval delivery (#2512)", () => {
	it("returns command output to the cell when the host client approves", async () => {
		// Given a real host session that asks for shell commands.
		const host = await createEvalApprovalHost();
		hosts.push(host);
		// When the model calls bash from the persistent JS worker and the client approves.
		const { approval, result } = await host.run("Allow once");
		// Then the client receives the command's approval and the cell receives stdout.
		expect(approval.title).toContain("echo APPROVED-2512");
		expect(getMessageText(result)).toContain("APPROVED-2512");
	});

	it("returns denial to the cell and continues the turn when the host client denies", async () => {
		// Given the same ask-for-commands host.
		const host = await createEvalApprovalHost();
		hosts.push(host);
		// When the attached client denies the kernel-originated approval.
		const { result } = await host.run("Deny");
		// Then the cell observes denial and the provider continues to its final response.
		expect(getMessageText(result)).toContain("DENIED");
		expect(getMessageText(result)).toMatch(/rejected|denied/i);
		expect(JSON.stringify(host.client)).toContain("continued");
	});

	it.each(["Allow once", "Deny"] as const)(
		"delivers a detached cell approval after turn completion: %s",
		async (choice) => {
			// Given a cell blocked at an event-controlled gate until its original turn ends.
			const host = await createEvalApprovalHost();
			hosts.push(host);
			// When the detached cell asks for bash after the gate is released.
			const { result } = await host.run(choice, "detached");
			// Then the attached client can settle the cell through the ordinary approval channel.
			expect(getMessageText(result)).toContain(choice === "Allow once" ? "APPROVED-2512" : "DENIED");
		},
	);

	it("returns a clear denial inside a headless cell with no approver", async () => {
		// Given a real session runtime bound without a UI.
		const host = await createEvalApprovalHost();
		hosts.push(host);
		// When the cell asks for a shell command.
		const result = await host.headless();
		// Then it settles with a visible permission error instead of waiting for a dialog.
		expect(getMessageText(result)).toContain("DENIED");
		expect(getMessageText(result)).toContain("Permission required for bash");
	});

	it("keeps top-level bash approvals unchanged", async () => {
		// Given a real direct-bash session and the normal permission extension.
		const prompts: string[] = [];
		const harness = await createHarness({
			tools: [createBashTool(process.cwd())],
			extensionFactories: [permissionSystemExtension],
			extensionFlagValues: new Map([["permission-preset", "ask"]]),
		});
		try {
			await harness.session.bindExtensions({
				uiContext: createTestUiContext({
					select: async (title) => {
						prompts.push(title);
						return "Allow once";
					},
				}),
			});
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "echo APPROVED-2512" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("continued"),
			]);
			// When the model makes a direct bash call and the UI approves.
			await harness.session.prompt("run which bun");
			// Then the ordinary approval still returns the real shell output.
			expect(prompts).toHaveLength(1);
			expect(prompts[0]).toContain("echo APPROVED-2512");
			expect(getMessageText(getToolResult(harness, "bash"))).toContain("APPROVED-2512");
		} finally {
			harness.cleanup();
		}
	});
});
