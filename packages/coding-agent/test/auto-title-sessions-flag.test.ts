import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, test } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { resolveAutoTitleSessions } from "../src/main.ts";
import { AUTO_TITLE_SESSIONS_CAPABILITY, MEDIA_PLACEHOLDERS_CAPABILITY } from "../src/modes/rpc/custom-capability.ts";
import { SessionCommandRouter } from "../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../src/modes/rpc/session-event-writer.ts";
import { waitForSessionName } from "./agent-session-auto-title-helpers.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

/**
 * `--auto-title-sessions` opts non-interactive app modes (notably `--mode rpc`,
 * with or without `--multi-session`) into engine-side session auto-titling.
 * Interactive launches keep auto-titling on by default, and a resumed session
 * that already carries context messages must never be retitled.
 */
describe("resolveAutoTitleSessions", () => {
	test("keeps auto-titling on for interactive launches without the flag", () => {
		const parsed = parseArgs([]);
		expect(resolveAutoTitleSessions("interactive", parsed, false)).toBe(true);
	});

	test("leaves non-interactive modes off without the flag", () => {
		const parsed = parseArgs(["--mode", "rpc", "--multi-session"]);
		expect(resolveAutoTitleSessions("rpc", parsed, false)).toBe(false);
	});

	test("opts RPC sessions into auto-titling when the client advertises the capability", () => {
		const parsed = parseArgs(["--mode", "rpc", "--multi-session"]);
		expect(resolveAutoTitleSessions("rpc", parsed, false, [AUTO_TITLE_SESSIONS_CAPABILITY])).toBe(true);
	});

	test.each(["rpc", "print", "json", "app-server"] as const)("honors the flag in %s mode", (appMode) => {
		const parsed = parseArgs(["--mode", "rpc", "--multi-session", "--auto-title-sessions"]);
		expect(resolveAutoTitleSessions(appMode, parsed, false)).toBe(true);
	});

	test("still suppresses auto-titling when the session has context messages", () => {
		const parsed = parseArgs(["--mode", "rpc", "--multi-session", "--auto-title-sessions"]);
		expect(resolveAutoTitleSessions("rpc", parsed, true)).toBe(false);
	});

	test("keeps the capability opt-in behind the context guard", () => {
		const parsed = parseArgs(["--mode", "rpc", "--multi-session"]);
		expect(resolveAutoTitleSessions("rpc", parsed, true, [AUTO_TITLE_SESSIONS_CAPABILITY])).toBe(false);
	});

	test("suppresses auto-titling for interactive resumes with context messages", () => {
		const parsed = parseArgs([]);
		expect(resolveAutoTitleSessions("interactive", parsed, true)).toBe(false);
	});
});

describe("RPC client capability auto-titling", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	test("titles a fresh RPC session and emits session_info_changed", async () => {
		const parsed = parseArgs(["--mode", "rpc", "--multi-session"]);
		const harness = await createHarness({
			persistSession: true,
			autoTitleSessions: resolveAutoTitleSessions("rpc", parsed, false, [AUTO_TITLE_SESSIONS_CAPABILITY]),
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("turn complete"),
			fauxAssistantMessage("<title>Capability Titled Session</title>"),
		]);

		const sessionName = waitForSessionName(harness);
		await harness.session.prompt("fix the RPC session title pipeline");

		expect(await sessionName).toBe("Capability Titled Session");
		expect(harness.eventsOfType("session_info_changed")).toHaveLength(1);
	});

	test("does not emit an auto-title event without the capability", async () => {
		const parsed = parseArgs(["--mode", "rpc", "--multi-session"]);
		const harness = await createHarness({
			persistSession: true,
			autoTitleSessions: resolveAutoTitleSessions("rpc", parsed, false),
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("turn complete")]);

		await harness.session.prompt("leave the default RPC title behavior unchanged");
		await harness.session.waitForSettledSessionWork();

		expect(harness.eventsOfType("session_info_changed")).toHaveLength(0);
		expect(harness.faux.getCallLog()).toHaveLength(1);
	});
});

describe("RPC protocol capabilities", () => {
	test("advertises auto_title_sessions", async () => {
		const registry = { list: () => [] } as never;
		const router = new SessionCommandRouter(registry, new SessionEventWriter(() => {}), { cwd: "/tmp" });
		const response = await router.handle({ id: "probe", type: "get_protocol_info" });
		expect(response).toMatchObject({
			data: { capabilities: ["multi_session", AUTO_TITLE_SESSIONS_CAPABILITY, MEDIA_PLACEHOLDERS_CAPABILITY] },
		});
	});
});

describe("rpc sessions launched with --auto-title-sessions", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	test("titles a fresh rpc session", async () => {
		const parsed = parseArgs(["--mode", "rpc", "--multi-session", "--auto-title-sessions"]);
		const harness = await createHarness({
			persistSession: true,
			autoTitleSessions: resolveAutoTitleSessions("rpc", parsed, false),
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("turn complete"),
			fauxAssistantMessage("<title>RPC Titled Session</title>"),
		]);

		const sessionName = waitForSessionName(harness);
		await harness.session.prompt("fix the OAuth login button on mobile");

		await expect(sessionName).resolves.toBe("RPC Titled Session");
	});

	test("leaves a resumed rpc session with context messages untitled", async () => {
		const parsed = parseArgs(["--mode", "rpc", "--multi-session", "--auto-title-sessions"]);
		const harness = await createHarness({
			persistSession: true,
			autoTitleSessions: resolveAutoTitleSessions("rpc", parsed, true),
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("turn complete")]);

		await harness.session.prompt("fix the OAuth login button on mobile");
		await harness.session.waitForSettledSessionWork();

		expect(harness.faux.getCallLog()).toHaveLength(1);
		expect(harness.sessionManager.getSessionName()).toBeUndefined();
	});
});
