import { afterEach, describe, expect, it } from "vitest";
import { closeLiveHosts, createLiveHost, FIXTURE_TOOLS, SHELL_FIXTURE_INPUT } from "./live-permission-host.ts";

afterEach(closeLiveHosts);

describe("2465 1d + lead: settings rules versus full-access", () => {
	it("a project settings ask rule must not prompt under full-access", async () => {
		// given full-access with project settings that ask for shell_fixture, browser and task
		const host = await createLiveHost({
			preset: "full-access",
			projectSettings: { permission: { browser: "ask", shell_fixture: "ask", task: "ask" } },
		});
		await host.bind();

		// when those tools run
		await host.runProbe("shell_fixture", SHELL_FIXTURE_INPUT, "shell");
		await host.runProbe("browser", FIXTURE_TOOLS[1].input, "browser");
		await host.runProbe("task", FIXTURE_TOOLS[0].input, "task");

		// then nothing asks: full access means no prompts
		expect(host.prompts()).toBe(0);
		expect(host.toolResultIsError("shell_fixture")).toBe(false);
		expect(host.toolResultIsError("browser")).toBe(false);
		expect(host.toolResultIsError("task")).toBe(false);
	}, 30_000);

	it("a global settings ask rule must not prompt under full-access", async () => {
		// given full-access with a global settings ask rule for shell_fixture
		const host = await createLiveHost({
			preset: "full-access",
			globalSettings: { permission: { shell_fixture: "ask" } },
		});
		await host.bind();

		// when the ruled tool runs
		await host.runProbe("shell_fixture", SHELL_FIXTURE_INPUT);

		// then it does not ask
		expect(host.prompts()).toBe(0);
		expect(host.toolResultIsError("shell_fixture")).toBe(false);
	}, 30_000);

	it("a CLI --permission ask rule landing live under full-access must not prompt", async () => {
		// given a full-access session whose CLI rules change live (the desktop's live path)
		const host = await createLiveHost({ preset: "full-access" });
		await host.bind();
		host.runtimeHost.session.extensionRunner.setFlagValue("permission", "browser=ask");

		// when the ruled tool runs
		await host.runProbe("browser", FIXTURE_TOOLS[1].input, "browser");

		// then the ask rule does not re-introduce a prompt under full-access
		expect(host.prompts()).toBe(0);
		expect(host.toolResultIsError("browser")).toBe(false);
	}, 30_000);

	it("an explicit project settings deny stays denied under full-access, naming the rule", async () => {
		// given full-access with an explicit project deny for the browser permission
		const host = await createLiveHost({
			preset: "full-access",
			projectSettings: { permission: { browser: "deny" } },
		});
		await host.bind();

		// when the denied tool runs
		await host.runProbe("browser", FIXTURE_TOOLS[1].input, "browser");

		// then it never runs: full-access still denies it, with no prompt
		expect(host.prompts()).toBe(0);
		// a wildcard deny deactivates the tool (applyToolDenials), so the call returns tool-not-found;
		// the project settings.json rule is what deactivated it
		expect(host.toolResultIsError("browser")).toBe(true);
		expect(host.toolResultText("browser")).toMatch(/browser/);
	}, 30_000);

	it("an explicit global settings deny stays denied under full-access, naming the rule", async () => {
		// given full-access with an explicit global deny for shell_fixture
		const host = await createLiveHost({
			preset: "full-access",
			globalSettings: { permission: { shell_fixture: "deny" } },
		});
		await host.bind();

		// when the denied tool runs
		await host.runProbe("shell_fixture", SHELL_FIXTURE_INPUT);

		// then it never runs: full-access still denies it, with no prompt
		expect(host.prompts()).toBe(0);
		// a wildcard deny deactivates the tool (applyToolDenials), so the call returns tool-not-found;
		// the global settings.json rule is what deactivated it
		expect(host.toolResultIsError("shell_fixture")).toBe(true);
		expect(host.toolResultText("shell_fixture")).toMatch(/shell_fixture/);
	}, 30_000);
});
