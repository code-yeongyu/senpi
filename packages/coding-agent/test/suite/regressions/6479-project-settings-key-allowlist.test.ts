import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attach, type DelegatedHost, declare, type Peer } from "../rpc-delegated-host-support.ts";
import { DEVICE, FrameLog, open, permissionHost, probeCalls, remotePeer } from "../rpc-delegated-permission-support.ts";

// senpi#6479: project settings writes over RPC use a key allowlist. A listed preference key is checked against its
// declared type and written; any other key (a later one included, and its removal) is decided like an edit of the
// project settings file plus a shell command, by the session's own permission rules for that record's origin.

type WireRecord = Record<string, unknown>;

const DECIDED_KEYS: Array<[string, unknown]> = [
	["packages", ["npm:example-package"]],
	["shellPath", "/bin/sh"],
	["permissionPreset", "full-access"],
	["permission", { bash: "allow" }],
	["providers", {}],
	["defaultModel", "faux-1"],
	["recommendedModels", ["faux/faux-1"]],
	["modelServiceTiers", { "faux/faux-1": "priority" }],
	["constructor", true],
	["theme", "../x"],
	["aSettingAddedLater", true],
];
const NEEDS_PERMISSION = { success: false, errorCode: "project_setting_needs_permission" };
const DENIED = { success: false, errorCode: "project_setting_denied" };

let host: DelegatedHost | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
}, 60_000);

interface StartOptions {
	readonly agentSettings?: WireRecord;
	readonly hostArgs?: readonly string[];
	/** The host opens sessions on its own default (settings and launch flags) instead of a host full-access preset. */
	readonly settingsDefault?: boolean;
}

async function start(options: StartOptions = {}) {
	await host?.dispose();
	host = await permissionHost([], {
		embedderPreset: options.settingsDefault !== true,
		...(options.hostArgs ? { hostArgs: options.hostArgs } : {}),
	});
	if (options.agentSettings !== undefined)
		writeFileSync(join(host.scratch, "agent", "settings.json"), JSON.stringify(options.agentSettings));
	return { target: host, local: await host.proven() };
}

async function trustedSession(local: Peer, extra: WireRecord = {}) {
	const session = await open(local, extra);
	const trusted = await local.send({ type: "set_project_trust", sessionId: session.sessionId, choice: "trust" });
	expect(trusted).toMatchObject({ success: true });
	const read = await local.send({ type: "get_project_settings", sessionId: session.sessionId });
	return { ...session, path: (read.data as { path: string }).path };
}

async function attachedPeer(session: { sessionId: string; durableSessionId: string }, peer: Peer) {
	expect(await peer.send(attach(session))).toMatchObject({ success: true });
	return peer;
}

async function sameAccountPeer(target: DelegatedHost): Promise<Peer> {
	const peer = await target.proven();
	const grant = ["observe", "drive", "thread", "answer", "device_admin"];
	expect(await declare(peer, grant, { ...DEVICE, sameAccount: true })).toMatchObject({ success: true });
	return peer;
}

const projectFile = (path: string): unknown => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined);

const write = (peer: Peer, sessionId: string, key: string, value: unknown) =>
	peer.send({ type: "set_project_setting", sessionId, key, value });

describe("a project setting outside the allowlist is decided like a local edit plus a shell command", () => {
	it("refuses every such key on an ask session, its removal included, and leaves the file alone", async () => {
		const { local } = await start();
		const session = await trustedSession(local, { permissionPreset: "ask" });
		for (const [key, value] of DECIDED_KEYS)
			expect(await write(local, session.sessionId, key, value)).toMatchObject(NEEDS_PERMISSION);
		expect(projectFile(session.path)).toBeUndefined();
		mkdirSync(dirname(session.path), { recursive: true });
		writeFileSync(session.path, JSON.stringify({ shellPath: "/bin/sh" }));
		expect(await write(local, session.sessionId, "shellPath", null)).toMatchObject(NEEDS_PERMISSION);
		expect(projectFile(session.path)).toEqual({ shellPath: "/bin/sh" });
	}, 60_000);

	it("refuses on an accept-edits session whose only shell grant names one command", async () => {
		const { local } = await start({ hostArgs: ["--permission", "bash:git status=allow"] });
		const session = await trustedSession(local, { permissionPreset: "accept-edits" });
		expect(await write(local, session.sessionId, "shellPath", "/bin/sh")).toMatchObject(NEEDS_PERMISSION);
		expect(projectFile(session.path)).toBeUndefined();
	}, 60_000);

	it("applies on a full-access session, and refuses where a rule denies the edit", async () => {
		const full = await start();
		const session = await trustedSession(full.local, { permissionPreset: "full-access" });
		expect(await write(full.local, session.sessionId, "shellPath", "/bin/sh")).toMatchObject({ success: true });
		expect(projectFile(session.path)).toEqual({ shellPath: "/bin/sh" });
		const denied = await start({ agentSettings: { permission: { edit: { "*": "deny" } } } });
		const deniedSession = await trustedSession(denied.local, { permissionPreset: "full-access" });
		expect(await write(denied.local, deniedSession.sessionId, "shellPath", "/bin/sh")).toMatchObject(DENIED);
		expect(projectFile(deniedSession.path)).toBeUndefined();
	}, 60_000);

	it("refuses it wherever a local gated call is refused: no permission system, or an invalid preset", async () => {
		const cases: Array<[string, StartOptions]> = [
			["no permission system", { agentSettings: { disabledBuiltinExtensions: ["permission-system"] } }],
			["invalid settings preset", { agentSettings: { permissionPreset: "bogus" } }],
			["invalid launch preset", { hostArgs: ["--permission-preset", "bogus"], settingsDefault: true }],
		];
		const outcomes: Array<[string, unknown, unknown, unknown]> = [];
		for (const [label, options] of cases) {
			const { local } = await start(options);
			const session = await trustedSession(local);
			const decided = await write(local, session.sessionId, "shellPath", "/bin/sh");
			const listed = await write(local, session.sessionId, "steeringMode", "all");
			outcomes.push([label, decided.errorCode ?? "written", listed.success, projectFile(session.path)]);
		}
		expect(outcomes).toEqual(
			cases.map(([label]) => [label, "project_setting_denied", true, { steeringMode: "all" }]),
		);
	}, 120_000);
});

describe("a listed preference key", () => {
	it("still writes on an ask session, checked against its declared type", async () => {
		const { local } = await start();
		const session = await trustedSession(local, { permissionPreset: "ask" });
		expect(await write(local, session.sessionId, "steeringMode", "all")).toMatchObject({ success: true });
		expect(await write(local, session.sessionId, "defaultThinkingLevel", "high")).toMatchObject({ success: true });
		expect(
			await write(local, session.sessionId, "markdown", { codeBlockIndent: "\t", mermaid: "off" }),
		).toMatchObject({
			success: true,
		});
		const invalid: Array<[string, unknown]> = [
			["steeringMode", "sometimes"],
			["hideThinkingBlock", "yes"],
			["modelThinkingLevels", { "faux/faux-1": "loud" }],
			["modelThinkingLevels", JSON.parse('{"__proto__": "high"}')],
			["fullscreenWheelScrollLines", 1000],
			["markdown", { codeBlockIndent: "\u001b]0;x\u0007" }],
			["markdown", { mermaid: "final", extra: true }],
		];
		for (const [key, value] of invalid)
			expect(await write(local, session.sessionId, key, value)).toMatchObject({
				success: false,
				errorCode: "invalid_argument",
			});
		expect(projectFile(session.path)).toEqual({
			steeringMode: "all",
			defaultThinkingLevel: "high",
			markdown: { codeBlockIndent: "\t", mermaid: "off" },
		});
	}, 60_000);
});

describe("a write from another device follows the engine's existing origin rule", () => {
	it("refuses a cross-account device on a host-default session with no turn yet, while the local write applies", async () => {
		const { target, local } = await start();
		const session = await trustedSession(local);
		const remote = await attachedPeer(session, await remotePeer(target));
		expect(await write(remote, session.sessionId, "shellPath", "/bin/sh")).toMatchObject(NEEDS_PERMISSION);
		expect(projectFile(session.path)).toBeUndefined();
		expect(await write(remote, session.sessionId, "steeringMode", "all")).toMatchObject({ success: true });
		expect(await write(local, session.sessionId, "shellPath", "/bin/sh")).toMatchObject({ success: true });
		expect(projectFile(session.path)).toEqual({ steeringMode: "all", shellPath: "/bin/sh" });
	}, 60_000);

	it("refuses a cross-account device after a local turn ran on the host default", async () => {
		const { target, local } = await start();
		const session = await trustedSession(local);
		const log = new FrameLog(local);
		const [localCall] = await probeCalls(log, { log, peer: local }, session.sessionId, {
			count: 1,
			answer: "Deny",
			start: () => local.send({ type: "prompt", sessionId: session.sessionId, message: "go" }),
		});
		expect(localCall).toEqual({ asked: [], ran: true });
		const remote = await attachedPeer(session, await remotePeer(target));
		expect(await write(remote, session.sessionId, "shellPath", "/bin/sh")).toMatchObject(NEEDS_PERMISSION);
		expect(projectFile(session.path)).toBeUndefined();
	}, 60_000);

	it("decides a same-account device as local", async () => {
		const { target, local } = await start();
		const session = await trustedSession(local);
		const sameAccount = await attachedPeer(session, await sameAccountPeer(target));
		expect(await write(sameAccount, session.sessionId, "shellPath", "/bin/sh")).toMatchObject({ success: true });
		expect(projectFile(session.path)).toEqual({ shellPath: "/bin/sh" });
	}, 60_000);
});
