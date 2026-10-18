import { afterEach, describe, expect, it } from "vitest";
import { closeLiveHosts, createLiveHost, SHELL_FIXTURE_INPUT } from "./live-permission-host.ts";

afterEach(closeLiveHosts);

describe("2465 3: Always allow answers reaching other open sessions", () => {
	it("an Always allow in one open session reaches another OPEN session before shutdown", async () => {
		// given two open sessions on the same host and project, both under ask
		const first = await createLiveHost({ preset: "ask" });
		await first.bind();
		const second = await createLiveHost({ preset: "ask", shareHostWith: first });
		await second.bind();

		// when the first session answers Allow always for this shell pattern
		const turn = first.runProbe("shell_fixture", SHELL_FIXTURE_INPUT, "run shell");
		const prompt = await first.waitForPrompt();
		prompt.resolve("Allow always");
		await turn;
		expect(first.toolResultIsError("shell_fixture")).toBe(false);

		// then the second session — still open, before any shutdown — does not re-ask
		await second.runProbe("shell_fixture", SHELL_FIXTURE_INPUT, "run shell elsewhere");
		expect(second.prompts()).toBe(0);
		expect(second.toolResultIsError("shell_fixture")).toBe(false);
	}, 30_000);
});
