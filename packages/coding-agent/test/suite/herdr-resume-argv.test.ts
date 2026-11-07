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

	// herdr keys prompt delivery and resume on the agents it knows, so the protocol agent stays pi
	// and the brand travels in a display-only pane token that herdr's pane and agent APIs expose.
	it.each(["omo", "pi"])("names the %s brand in the app pane token and clears it on quit", async (command) => {
		launcher.command = command;
		const f = await herdrReporterFixture();
		await f.start();
		expect(f.requests.find((request) => request.method === "pane.report_metadata")?.params).toMatchObject({
			tokens: { app: command },
		});
		await f.emit("session_shutdown", { reason: "quit" });
		expect(f.requests.slice(-2).map((request) => [request.method, request.params.tokens])).toEqual([
			["pane.report_metadata", { app: null }],
			["pane.release_agent", undefined],
		]);
		const agents = f.requests.filter((request) => "agent" in request.params).map((request) => request.params.agent);
		expect(agents.length).toBeGreaterThan(0);
		expect(new Set(agents)).toEqual(new Set(["pi"]));
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
