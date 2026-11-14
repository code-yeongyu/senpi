import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupHerdrReporterFixtures, herdrReporterFixture } from "./herdr-reporter-harness.ts";

const launcher = vi.hoisted(() => ({ command: "senpi" }));
vi.mock("../../src/config.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/config.ts")>()),
	get APP_COMMAND() {
		return launcher.command;
	},
}));

afterEach(async () => {
	await cleanupHerdrReporterFixtures();
	vi.unstubAllEnvs();
});

describe("Herdr sidebar agent label (oh-my-openagent#11397)", () => {
	it.each(["omo", "senpi"])("labels a %s pane with its branded command, not the session name", async (command) => {
		launcher.command = command;
		const f = await herdrReporterFixture();
		await f.start();
		f.setTitle("Renamed");
		await f.emit("session_info_changed", { name: "Renamed" });
		expect(f.requests.filter((r) => r.method === "pane.report_metadata").map((r) => r.params)).toMatchObject([
			{ title: "Reporter QA", display_agent: command },
			{ title: "Renamed", display_agent: command },
		]);
	});
});
