import { afterEach, describe, expect, it } from "vitest";
import {
	closeLiveHosts,
	createLiveHost,
	type LivePermissionHost,
	SHELL_FIXTURE_INPUT,
} from "./live-permission-host.ts";

afterEach(closeLiveHosts);

async function reseed(host: LivePermissionHost): Promise<string> {
	// Give the replacement a real persisted session file to resume: one answered turn.
	const turn = host.runProbe("shell_fixture", SHELL_FIXTURE_INPUT, "seed");
	const prompt = await Promise.race([host.waitForPrompt().catch(() => undefined)]);
	prompt?.resolve("Allow once");
	await turn;
	const file = host.runtimeHost.session.sessionManager.getSessionFile();
	if (file === undefined) throw new Error("expected a persisted session file after seeding");
	return file;
}

describe("senpi#2842: a live preset switch survives session replacement", () => {
	it("a switch to full-access holds across new, switch and fork", async () => {
		// given a persisted session switched live from ask to full-access
		const host = await createLiveHost({ preset: "ask", persist: true });
		await host.bind();
		host.setPreset("full-access");

		// when the session is replaced by /new, then seeded with a real turn
		await host.runtimeHost.newSession();
		await host.bind();
		await host.runProbe("shell_fixture", SHELL_FIXTURE_INPUT, "after new");
		expect(host.prompts()).toBe(0);

		// and then replaced by a switch back to the seeded file
		const seeded = await reseed(host);
		await host.runtimeHost.switchSession(seeded);
		await host.bind();
		await host.runProbe("shell_fixture", SHELL_FIXTURE_INPUT, "after switch");

		// and then replaced by a fork of the seeded user message
		await host.forkLastUserMessage();
		await host.bind();
		await host.runProbe("shell_fixture", SHELL_FIXTURE_INPUT, "after fork");

		// then full-access held across every replacement: nothing ever asked
		expect(host.prompts()).toBe(0);
		expect(host.toolResultIsError("shell_fixture")).toBe(false);
	}, 90_000);

	it("a switch to ask holds across new, switch and fork", async () => {
		// given a persisted session switched live from full-access to ask
		const host = await createLiveHost({ preset: "full-access", persist: true });
		await host.bind();
		host.setPreset("ask");

		// when the session is replaced by /new, a gated call asks again
		await host.runtimeHost.newSession();
		await host.bind();
		const afterNew = host.runProbe("shell_fixture", SHELL_FIXTURE_INPUT, "after new");
		const newPrompt = await host.waitForPrompt();
		newPrompt.resolve("Allow once");
		await afterNew;

		// and after a switch back to the seeded file it still asks
		const seeded = await reseed(host);
		await host.runtimeHost.switchSession(seeded);
		await host.bind();
		const afterSwitch = host.runProbe("shell_fixture", SHELL_FIXTURE_INPUT, "after switch");
		const switchPrompt = await host.waitForPrompt();
		switchPrompt.resolve("Allow once");
		await afterSwitch;

		// and after a fork it still asks
		await host.forkLastUserMessage();
		await host.bind();
		const afterFork = host.runProbe("shell_fixture", SHELL_FIXTURE_INPUT, "after fork");
		const forkPrompt = await host.waitForPrompt();
		forkPrompt.resolve("Allow once");
		await afterFork;

		// then the ask preset survived every replacement (3 probes + 1 reseed prompt)
		expect(host.prompts()).toBe(4);
	}, 90_000);
});
