import { afterEach, describe, expect, it } from "vitest";
import {
	closeLiveHosts,
	createLiveHost,
	FIXTURE_TOOLS,
	SHELL_FIXTURE_INPUT,
	titlePermission,
} from "./live-permission-host.ts";

afterEach(closeLiveHosts);

describe("2465 1a/1b: attach switching a live session to full-access", () => {
	it("1a: ask prompts for shell/browser, and an attach to full-access silences the next calls", async () => {
		// given a session opened with the ask preset
		const host = await createLiveHost({ preset: "ask" });
		await host.bind();

		// when a shell-style call and a browser-tool call run, each raises a permission prompt
		const shellTurn = host.runProbe("shell_fixture", SHELL_FIXTURE_INPUT, "run shell");
		const shellPrompt = await host.waitForPrompt();
		expect(titlePermission(shellPrompt.title)).toBe("shell_fixture");
		shellPrompt.resolve("Allow once");
		await shellTurn;

		const browserTurn = host.runProbe("browser", FIXTURE_TOOLS[1].input, "browse");
		const browserPrompt = await host.waitForPrompt();
		expect(titlePermission(browserPrompt.title)).toBe("browser");
		browserPrompt.resolve("Allow once");
		await browserTurn;
		expect(host.prompts()).toBe(2);

		// and when the desktop's mode change ATTACH moves the session to full-access
		host.setPreset("full-access");

		// then the next shell, browser and task/subagent calls raise no permission request
		await host.runProbe("shell_fixture", SHELL_FIXTURE_INPUT, "run shell again");
		await host.runProbe("browser", FIXTURE_TOOLS[1].input, "browse again");
		await host.runProbe("task", FIXTURE_TOOLS[0].input, "spawn a subagent");
		expect(host.prompts()).toBe(2);
		expect(host.toolResultIsError("shell_fixture")).toBe(false);
		expect(host.toolResultIsError("browser")).toBe(false);
		expect(host.toolResultIsError("task")).toBe(false);
	}, 30_000);

	it("1b-idle: an attach to full-access while the session is idle silences the very next call", async () => {
		// given an idle session (no turn has ever run) opened with ask
		const host = await createLiveHost({ preset: "ask" });
		await host.bind();

		// when the attach lands while idle
		host.setPreset("full-access");

		// then the next call does not ask
		await host.runProbe("shell_fixture", SHELL_FIXTURE_INPUT);
		expect(host.prompts()).toBe(0);
		expect(host.toolResultIsError("shell_fixture")).toBe(false);
	}, 30_000);

	it("1b-mid-turn: a call already waiting keeps its preset; the next call follows the attach", async () => {
		// given a shell-style call already waiting on its ask prompt
		const host = await createLiveHost({ preset: "ask" });
		await host.bind();
		const turn = host.runProbe("shell_fixture", SHELL_FIXTURE_INPUT, "run shell");
		const waitingPrompt = await host.waitForPrompt();
		expect(titlePermission(waitingPrompt.title)).toBe("shell_fixture");

		// when the mode change lands while that call is waiting
		host.setPreset("full-access");

		// then the waiting call still answers its old preset's prompt
		waitingPrompt.resolve("Allow once");
		await turn;

		// and the next call runs under full-access without asking
		await host.runProbe("shell_fixture", SHELL_FIXTURE_INPUT, "run shell again");
		expect(host.prompts()).toBe(1);
		expect(host.toolResultIsError("shell_fixture")).toBe(false);
	}, 30_000);

	it("senpi#2461: a host session opened with permissionPreset ask really asks", async () => {
		// given a host session opened with permissionPreset "ask"
		const host = await createLiveHost({ preset: "ask" });
		await host.bind();

		// when a gated tool call runs, the open_session preset is not ignored (never fails open)
		const turn = host.runProbe("shell_fixture", SHELL_FIXTURE_INPUT);
		const prompt = await host.waitForPrompt();

		// then it asks
		expect(titlePermission(prompt.title)).toBe("shell_fixture");
		prompt.resolve("Allow once");
		await turn;
		expect(host.toolResultIsError("shell_fixture")).toBe(false);
	}, 30_000);
});
