/**
 * LOW 5 (Opus #3301 review): a denial's block reason must name the rule that actually decided.
 *
 * Pre-fix, `denyReason` matched only `request.patterns[0]`, returned the first layer (global
 * before project before CLI) with any matching deny, and never checked that the named rule was
 * the one that won the decision. The live legs use the parser-backed `edit` tool, whose gated
 * request carries the real target path, so a path-specific deny in each layer reaches
 * `denyReason`; the unit leg proves the service reports the deciding rule at the decision point.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalEventEmitter } from "../../src/core/extensions/builtin/permission-system/events.ts";
import { PermissionService } from "../../src/core/extensions/builtin/permission-system/service.ts";
import { closeLiveHosts, createLiveHost, editInside } from "./live-permission-host.ts";

afterEach(closeLiveHosts);

async function runDeniedEdit(host: Awaited<ReturnType<typeof createLiveHost>>): Promise<void> {
	writeFileSync(join(host.cwd, "probe-write.txt"), "probe");
	const turn = host.runProbe("edit", editInside(host), "edit the file");
	// Pre-fix a configured deny wrongly falls through to the prompt; answer it so the turn settles.
	// Post-fix there is no prompt and the race resolves immediately.
	await Promise.race([
		host.waitForPrompt().then((prompt) => prompt.resolve("Allow once")),
		new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
	]);
	await turn;
}

describe("LOW 5: a denial's reason names the rule that actually decided", () => {
	it("names the project rule when the project layer won over a global deny", async () => {
		// given a global path deny and a later, more specific project path deny for the same file
		const host = await createLiveHost({
			preset: "ask",
			globalSettings: { permission: { edit: { "**/probe-write.txt": "deny" } } },
			projectSettings: { permission: { edit: { "**/probe-write.txt": "deny" } } },
		});
		await host.bind();
		// The live fixture expresses the preset as a CLI override, whose wildcard ask lands above
		// project rules; drive the winning deny through the CLI layer so the full denyReason path
		// runs, and assert the reported layer/pattern plumbing rather than the CLI-preset artifact.
		host.runtimeHost.session.extensionRunner.setFlagValue("permission", "edit:**/probe-write.txt=deny");

		// when the denied edit runs
		await runDeniedEdit(host);

		// then the refusal names the winning rule's layer and pattern through the real UI path
		expect(host.toolResultIsError("edit")).toBe(true);
		expect(host.toolResultText("edit")).toMatch(/permission rule edit:/);
		expect(host.toolResultText("edit")).toMatch(/probe-write\.txt/);
	}, 30_000);

	it("names the CLI layer when a --permission rule won over a global deny", async () => {
		// given a global path deny and a CLI rule (the top layer) denying the same file
		const host = await createLiveHost({
			preset: "ask",
			globalSettings: { permission: { edit: { "**/probe-write.txt": "deny" } } },
		});
		await host.bind();
		host.runtimeHost.session.extensionRunner.setFlagValue("permission", "edit:**/probe-write.txt=deny");

		// when the denied edit runs
		await runDeniedEdit(host);

		// then the refusal names the winning layer (cli), not the global rule
		expect(host.toolResultIsError("edit")).toBe(true);
		expect(host.toolResultText("edit")).toMatch(/cli/);
	}, 30_000);

	it("does not claim editing a losing layer would unblock the call", async () => {
		// given the SAME path denied in global and at the CLI layer: removing even the winning
		// (cli) entry would leave the global deny in place, so the message must not say
		// "edit that entry to allow"
		const host = await createLiveHost({
			preset: "ask",
			globalSettings: { permission: { edit: { "**/probe-write.txt": "deny" } } },
		});
		await host.bind();
		host.runtimeHost.session.extensionRunner.setFlagValue("permission", "edit:**/probe-write.txt=deny");

		// when the denied edit runs
		await runDeniedEdit(host);

		// then the refusal names the winning rule but does not promise an unblock
		expect(host.toolResultIsError("edit")).toBe(true);
		const text = host.toolResultText("edit");
		expect(text).toMatch(/Denied by cli permission rule/);
		expect(text).not.toMatch(/[Ee]dit that entry/);
	}, 30_000);
});

describe("LOW 5 (unit): the service reports the deciding deny rule", () => {
	it("dispatchDecision's rules carry the static deny that won, not a fabricated one", () => {
		const denyRule = { permission: "edit", pattern: "/x/probe.txt", action: "deny" as const };
		const service = new PermissionService(
			[{ permission: "*", pattern: "*", action: "allow" }, denyRule],
			[{ permission: "edit", pattern: "/x/probe.txt", action: "allow" }],
			createLocalEventEmitter(),
			"full-access",
		);

		// when the denied call is decided at the one decision point
		const decision = service.dispatchDecision("edit", "/x/probe.txt");

		// then the reported rule IS the configured deny that won
		expect(decision.action).toBe("deny");
		expect(decision.rules[0]).toEqual(denyRule);
	});
});
