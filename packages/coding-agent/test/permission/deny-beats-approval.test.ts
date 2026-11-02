/**
 * HIGH 2 (Opus #3301 review): a configured deny must outrank an approval.
 *
 * Approvals are last-match after static rules, so an approved `allow` used to beat a settings
 * deny (global/project/CLI). These are RED against the pre-fix `dispatchDecision` and prove, at
 * the one decision point, that the static deny wins under full-access AND ask, on the plain path
 * and the presetBound path.
 */
import { describe, expect, it } from "vitest";
import { createLocalEventEmitter } from "../../src/core/extensions/builtin/permission-system/events.ts";
import { PermissionService } from "../../src/core/extensions/builtin/permission-system/service.ts";
import type { Ruleset } from "../../src/core/extensions/builtin/permission-system/types.ts";

const DENY_BASH: Ruleset = [{ permission: "bash", pattern: "rm *", action: "deny" }];
const APPROVE_BASH: Ruleset = [{ permission: "bash", pattern: "rm *", action: "allow" }];

function service(staticRuleset: Ruleset, approved: Ruleset, preset?: "full-access" | "ask"): PermissionService {
	return new PermissionService(staticRuleset, approved, createLocalEventEmitter(), preset);
}

describe("HIGH 2: a settings deny beats an approved allow", () => {
	it("stays denied under full-access on the plain path", () => {
		// given a settings deny for rm under full-access, and an approved allow for the same pattern
		const svc = service(DENY_BASH, APPROVE_BASH, "full-access");

		// when the gated call is decided at the one decision point
		const decision = svc.dispatchDecision("bash", "rm -rf node_modules");

		// then the deny wins: the approval never overrides a configured deny
		expect(decision.action).toBe("deny");
	});

	it("stays denied under ask on the plain path", () => {
		// given a settings deny and an approved allow, under the ask preset
		const svc = service([{ permission: "*", pattern: "*", action: "ask" }, ...DENY_BASH], APPROVE_BASH, "ask");

		// when the call is decided
		const decision = svc.dispatchDecision("bash", "rm -rf node_modules");

		// then it stays denied
		expect(decision.action).toBe("deny");
	});

	it("stays denied on the presetBound path", () => {
		// given the same deny + approval, decided on the presetBound path
		const svc = service([{ permission: "*", pattern: "*", action: "ask" }, ...DENY_BASH], APPROVE_BASH, "ask");

		// when decided as the more restrictive of preset and user rules
		const decision = svc.dispatchDecision("bash", "rm -rf node_modules", { presetBound: true });

		// then the deny still wins
		expect(decision.action).toBe("deny");
	});
});
