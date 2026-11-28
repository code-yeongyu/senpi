import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupHerdrReporterFixtures, type HerdrRequest, herdrReporterFixture } from "./herdr-reporter-harness.ts";

const launcher = vi.hoisted(() => ({ command: "senpi" }));
vi.mock("../../src/config.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/config.ts")>()),
	get APP_COMMAND() {
		return launcher.command;
	},
}));

afterEach(async () => {
	await cleanupHerdrReporterFixtures();
	vi.useRealTimers();
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

	// herdr drops a reported resume command while its process probe names another agent in the pane (a provider's
	// `claude` child), and nothing else re-reports it, so a herdr restart reopened the pane as a plain shell.
	it("re-reports the resume command every five seconds until shutdown", async () => {
		launcher.command = "omo";
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const f = await herdrReporterFixture();
		await f.start();
		const sent = f.requests.length;
		const next = once(f.received, "request", { signal: AbortSignal.timeout(5000) });
		await vi.advanceTimersByTimeAsync(5000);
		const [request] = (await next) as [HerdrRequest];
		expect(f.requests).toHaveLength(sent + 1);
		expect(request.method).toBe("pane.report_agent_session");
		expect(request.params).toMatchObject({
			agent: "pi",
			agent_session_path: "/sessions/root.jsonl",
			resume_argv: ["omo", "--session", "/sessions/root.jsonl"],
		});
		// Only the first report is a session start; a re-report must not look like a new session to herdr.
		expect(request.params).not.toHaveProperty("session_start_source");
		await f.emit("session_shutdown", { reason: "quit" });
		expect(vi.getTimerCount()).toBe(0);
	});
});
