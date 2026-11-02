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

describe("Herdr restart launcher", () => {
	it.each(["omo", "senpi"])("resumes a %s session through its branded command, not pi", async (command) => {
		launcher.command = command;
		const f = await herdrReporterFixture();
		f.ctx.sessionManager.getSessionFile = () => "/sessions/project with spaces/root.jsonl";
		await f.start();
		expect(f.requests.findIndex((request) => request.method === "pane.report_agent")).toBeLessThan(
			f.requests.findIndex((request) => request.method === "pane.report_agent_session"),
		);
		expect(f.requests.find((request) => request.method === "pane.report_agent_session")?.params).toMatchObject({
			agent: "pi",
			agent_session_path: "/sessions/project with spaces/root.jsonl",
			resume_argv: [command, "--session", "/sessions/project with spaces/root.jsonl"],
			session_start_source: "startup",
		});
	});

	it("uses the same session ID fallback as the reported reference", async () => {
		launcher.command = "senpi";
		const f = await herdrReporterFixture();
		f.ctx.sessionManager.getSessionFile = () => undefined;
		await f.start();
		expect(f.requests.find((request) => request.method === "pane.report_agent_session")?.params).toMatchObject({
			agent: "pi",
			agent_session_id: "root-session",
			resume_argv: ["senpi", "--session", "root-session"],
		});
	});
});
