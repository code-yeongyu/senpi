import { describe, expect, it, vi } from "vitest";
import { rulesForPreset } from "../../src/core/extensions/builtin/permission-system/config.ts";
import permissionSystemExtension from "../../src/core/extensions/builtin/permission-system/index.ts";
import { ApprovalModeCycle } from "../../src/core/extensions/builtin/permission-system/mode-cycle.ts";
import { PermissionService } from "../../src/core/extensions/builtin/permission-system/service.ts";
import {
	DeniedError,
	RejectedError,
	type Request,
	type Ruleset,
} from "../../src/core/extensions/builtin/permission-system/types.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";

function request(id: string, permission: string, pattern: string): Request {
	return {
		id,
		sessionID: "session-1",
		permission,
		patterns: [pattern],
		always: [pattern],
		metadata: {},
	};
}

describe("approval mode cycle", () => {
	it("is exposed as an internal command for the configurable app action", () => {
		const registerCommand = vi.fn();
		const on = vi.fn();
		permissionSystemExtension({
			registerFlag: vi.fn(),
			registerCommand,
			on,
		} as unknown as ExtensionAPI);

		expect(registerCommand).toHaveBeenCalledWith(
			"approval-mode-cycle",
			expect.objectContaining({ description: "Cycle approval mode", handler: expect.any(Function) }),
		);
	});

	it.each([
		[undefined, "auto"],
		["full-access", "auto"],
		["auto", "workspace"],
		["workspace", "read-only"],
		["read-only", "ask"],
		["ask", "auto"],
	] as const)("cycles %s to %s for this session", (initialPreset, expectedPreset) => {
		const service = new PermissionService(rulesForPreset("full-access"), []);
		const setStatus = vi.fn();
		const notify = vi.fn();
		const cycle = new ApprovalModeCycle(service, initialPreset, { setStatus, notify });

		expect(cycle.next()).toBe(expectedPreset);
		expect(setStatus).toHaveBeenLastCalledWith("approval-mode", `approval: ${expectedPreset}`);
		expect(notify).toHaveBeenLastCalledWith(`Approval mode: ${expectedPreset}`, "info");
	});

	it("preserves Allow-always approvals while changing presets", async () => {
		const service = new PermissionService(rulesForPreset("full-access"), []);
		const cycle = new ApprovalModeCycle(service, "read-only", { setStatus: vi.fn(), notify: vi.fn() });

		cycle.next(); // ask
		const firstAsk = service.ask(request("approve", "bash", "git status"));
		service.reply({ requestID: "approve", reply: "always" });
		await firstAsk;

		cycle.next(); // workspace
		cycle.next(); // read-only
		await expect(service.ask(request("approved", "bash", "git status"))).resolves.toBeUndefined();
		expect(service.getApproved()).toEqual([{ permission: "bash", pattern: "git status", action: "allow" }]);
	});

	it("keeps explicit CLI permission rules at highest precedence", async () => {
		const cliRules: Ruleset = [
			{ permission: "bash", pattern: "git status", action: "deny" },
			{ permission: "edit", pattern: "README.md", action: "allow" },
		];
		const approved: Ruleset = [{ permission: "bash", pattern: "git status", action: "allow" }];
		const service = new PermissionService(rulesForPreset("full-access"), approved, undefined, cliRules);
		const cycle = new ApprovalModeCycle(service, "workspace", { setStatus: vi.fn(), notify: vi.fn() });

		cycle.next(); // read-only: bash asks, but CLI deny wins over the approval
		await expect(service.ask(request("denied", "bash", "git status"))).rejects.toBeInstanceOf(DeniedError);

		cycle.next(); // ask: edit asks, but CLI allow wins
		await expect(service.ask(request("allowed", "edit", "README.md"))).resolves.toBeUndefined();
	});

	it("keeps configured denies above the session preset while CLI rules remain final", async () => {
		const configuredRules: Ruleset = [{ permission: "bash", pattern: "*", action: "deny" }];
		const staticRules = [...rulesForPreset("full-access"), ...configuredRules];
		const service = new PermissionService(staticRules, [], undefined, [], configuredRules);
		const cycle = new ApprovalModeCycle(service, "full-access", { setStatus: vi.fn(), notify: vi.fn() });

		cycle.next(); // workspace broadly allows bash
		await expect(service.ask(request("configured-deny", "bash", "rm -rf /tmp/example"))).rejects.toBeInstanceOf(
			DeniedError,
		);

		const cliAllow: Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }];
		const overridden = new PermissionService(staticRules, [], undefined, cliAllow, configuredRules);
		const overriddenCycle = new ApprovalModeCycle(overridden, "full-access", {
			setStatus: vi.fn(),
			notify: vi.fn(),
		});
		overriddenCycle.next();
		await expect(overridden.ask(request("cli-allow", "bash", "rm -rf /tmp/example"))).resolves.toBeUndefined();
	});

	it("keeps unrelated configured asks pending when an always approval resolves siblings", async () => {
		const configuredRules: Ruleset = [
			{ permission: "edit", pattern: "*", action: "ask" },
			{ permission: "bash", pattern: "*", action: "ask" },
		];
		const service = new PermissionService(
			[...rulesForPreset("full-access"), ...configuredRules],
			[],
			undefined,
			[],
			configuredRules,
		);
		const cycle = new ApprovalModeCycle(service, "full-access", { setStatus: vi.fn(), notify: vi.fn() });
		cycle.next(); // workspace allows both unless configured asks are reapplied

		const editPending = service.ask(request("edit-ask", "edit", "README.md"));
		const bashPending = service.ask(request("bash-ask", "bash", "git status"));
		expect(service.list().map(({ id }) => id)).toEqual(["edit-ask", "bash-ask"]);

		service.reply({ requestID: "bash-ask", reply: "always" });
		await expect(bashPending).resolves.toBeUndefined();
		expect(service.list().map(({ id }) => id)).toEqual(["edit-ask"]);

		service.reply({ requestID: "edit-ask", reply: "reject" });
		await expect(editPending).rejects.toBeInstanceOf(RejectedError);
	});
});

describe("automatic approval mode", () => {
	it("uses ask rules until the classifier allows a tool proposal", async () => {
		const service = new PermissionService(rulesForPreset("full-access"), []);
		const setStatus = vi.fn();
		const cycle = new ApprovalModeCycle(service, "full-access", { setStatus, notify: vi.fn() });

		expect(cycle.next()).toBe("auto");
		expect(cycle.isAuto()).toBe(true);
		const pending = service.ask(request("auto-edit", "edit", "src/parser.ts"));
		expect(service.list().map(({ id }) => id)).toEqual(["auto-edit"]);
		service.reply({ requestID: "auto-edit", reply: "reject" });
		await expect(pending).rejects.toBeInstanceOf(RejectedError);
	});

	it("keeps explicit settings and CLI asks above auto classification", () => {
		const requestInfo = request("auto-edit", "edit", "src/parser.ts");
		const defaultService = new PermissionService(rulesForPreset("full-access"), []);
		const settingsAsk = new PermissionService(
			rulesForPreset("full-access"),
			[],
			undefined,
			[],
			[{ permission: "edit", pattern: "*", action: "ask" }],
		);
		const cliAsk = new PermissionService(rulesForPreset("full-access"), [], undefined, [
			{ permission: "edit", pattern: "*", action: "ask" },
		]);

		expect(defaultService.isAutoApprovalEligible(requestInfo)).toBe(true);
		expect(settingsAsk.isAutoApprovalEligible(requestInfo)).toBe(false);
		expect(cliAsk.isAutoApprovalEligible(requestInfo)).toBe(false);
	});
});
