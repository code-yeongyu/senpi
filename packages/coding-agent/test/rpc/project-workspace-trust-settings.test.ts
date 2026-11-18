/**
 * senpi#6176: an RPC client trusts the session's workspace and reads/writes its project settings with the same storage
 * and semantics as the CLI. Records go through the multi-session host's own dispatch (`createHostCore(...).handle`) on
 * the in-process registry, with a faux provider and no network; the project folder carries a project skill and a
 * project settings file, both of which trust gates.
 */
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { CONFIG_DIR_NAME } from "../../src/config.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { ProjectTrustStore } from "../../src/core/trust-manager.ts";
import { createCliRuntimeFactory } from "../../src/main.ts";
import { classifyRpcMethod } from "../../src/modes/rpc/method-classes.ts";
import { createHostCore } from "../../src/modes/rpc/multi-session-host.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";

type WireRecord = Record<string, unknown>;

const LEAN_ARGS = ["--mode", "rpc", "--multi-session", "--no-extensions", "--no-context-files"];
const SKILL_COMMAND = "skill:wsp-skill";

const hosts: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of hosts.splice(0)) await dispose();
	vi.unstubAllEnvs();
});

async function startHost(
	extraArgs: string[] = [],
	extensionFactories: ExtensionFactory[] = [],
	globalSettings: Record<string, unknown> = {},
) {
	const scratch = realpathSync(mkdtempSync(join(tmpdir(), "senpi-6176-")));
	const cwd = join(scratch, "project");
	const agentDir = join(scratch, "agent");
	const configDir = join(cwd, CONFIG_DIR_NAME);
	mkdirSync(join(configDir, "skills", "wsp-skill"), { recursive: true });
	mkdirSync(agentDir);
	writeFileSync(
		join(configDir, "skills", "wsp-skill", "SKILL.md"),
		"---\nname: wsp-skill\ndescription: Workspace parity probe.\n---\nProbe.\n",
	);
	const projectSettingsPath = join(configDir, "settings.json");
	writeFileSync(projectSettingsPath, JSON.stringify({ steeringMode: "one-at-a-time" }));
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-1", ...globalSettings }),
	);
	for (const name of ["SENPI_CODING_AGENT_DIR", "OMO_CODING_AGENT_DIR"]) vi.stubEnv(name, agentDir);
	for (const name of ["OMO_RPC_SOCKET_PATH", "OMO_RPC_SOCKET", "SENPI_RPC_SOCKET", "PI_RPC_SOCKET"])
		vi.stubEnv(name, undefined);
	const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: false, contextWindow: 128_000 }] });
	const writer = new SessionEventWriter(() => {});
	const answers = new Map<string, (record: WireRecord) => void>();
	writer.registerConnection("client", {
		writeRaw: (line) => {
			const record = JSON.parse(line) as WireRecord;
			if (record.type === "response" && typeof record.id === "string") answers.get(record.id)?.(record);
		},
		waitForBackpressure: async () => {},
	});
	const core = createHostCore(
		{
			agentDir,
			cwd,
			createRuntime: createCliRuntimeFactory(
				{ parsed: parseArgs([...LEAN_ARGS, ...extraArgs]), cwd, agentDir, appMode: "rpc" },
				{ extensionFactories: [(pi) => pi.registerProvider(faux.provider), ...extensionFactories] },
			),
		},
		writer,
		[],
	);
	let serial = 0;
	const send = async (command: WireRecord): Promise<WireRecord> => {
		const id = `s6176-${++serial}`;
		const answer = Promise.withResolvers<WireRecord>();
		answers.set(id, answer.resolve);
		await writer.withConnection("client", () => core.handle(JSON.stringify({ ...command, id })));
		return answer.promise;
	};
	hosts.push(async () => {
		await core.router.dispose();
		writer.unregisterConnection("client");
		rmSync(scratch, { recursive: true, force: true });
	});
	const open = async () => ((await send({ type: "open_session" })).data as { sessionId: string }).sessionId;
	const commandNames = async (sessionId: string) =>
		((await send({ type: "get_commands", sessionId })).data as { commands: Array<{ name: string }> }).commands.map(
			(command) => command.name,
		);
	const steeringMode = async (sessionId: string) =>
		((await send({ type: "get_state", sessionId })).data as { steeringMode: string }).steeringMode;
	return {
		cwd,
		configDir,
		trustFile: join(agentDir, "trust.json"),
		send,
		open,
		commandNames,
		steeringMode,
		projectSettingsPath,
		savedTrust: () =>
			JSON.parse(readFileSync(join(agentDir, "trust.json"), "utf8")) as Record<string, boolean | null>,
		projectFile: () => JSON.parse(readFileSync(projectSettingsPath, "utf8")) as Record<string, unknown>,
	};
}

describe("senpi#6176: project trust over RPC", () => {
	it("classes the trust read as observe and every other workspace verb as device_admin", () => {
		expect(classifyRpcMethod({ type: "get_project_trust", sessionId: "a" })).toBe("observe");
		for (const record of [
			{ type: "set_project_trust", sessionId: "a", choice: "trust" },
			{ type: "get_project_settings", sessionId: "a" },
			{ type: "set_project_setting", sessionId: "a", key: "steeringMode", value: "all" },
		])
			expect(classifyRpcMethod(record)).toBe("device_admin");
	});

	it("opens an unanswered project untrusted: no project skill, no project settings, the /trust choices offered", async () => {
		const host = await startHost();
		const sessionId = await host.open();
		expect(await host.commandNames(sessionId)).not.toContain(SKILL_COMMAND);
		expect(await host.steeringMode(sessionId)).toBe("all");
		const trust = await host.send({ type: "get_project_trust", sessionId });
		expect(trust).toMatchObject({
			success: true,
			data: { cwd: host.cwd, projectTrusted: false, requiresTrust: true, saved: null, locked: false },
		});
		expect((trust.data as { choices: Array<{ choice: string }> }).choices.map((entry) => entry.choice)).toEqual([
			"trust",
			"trust_parent",
			"do_not_trust",
		]);
	});

	it("applies a trust choice to the session at once, keeps it across reload, saves it like /trust, and shares it with the next session", async () => {
		const host = await startHost();
		const sessionId = await host.open();
		await host.commandNames(sessionId);
		const answer = await host.send({ type: "set_project_trust", sessionId, choice: "trust" });
		expect(answer).toMatchObject({
			success: true,
			data: { projectTrusted: true, saved: { path: host.cwd, trusted: true } },
		});
		expect(host.savedTrust()).toEqual({ [host.cwd]: true });
		expect(await host.commandNames(sessionId)).toContain(SKILL_COMMAND);
		expect(await host.steeringMode(sessionId)).toBe("one-at-a-time");
		expect(await host.send({ type: "reload", sessionId })).toMatchObject({ success: true });
		expect(await host.commandNames(sessionId)).toContain(SKILL_COMMAND);
		const next = await host.open();
		expect(await host.commandNames(next)).toContain(SKILL_COMMAND);
	});

	it("unloads the project again on do_not_trust", async () => {
		const host = await startHost();
		const sessionId = await host.open();
		await host.send({ type: "set_project_trust", sessionId, choice: "trust" });
		const answer = await host.send({ type: "set_project_trust", sessionId, choice: "do_not_trust" });
		expect(answer).toMatchObject({ success: true, data: { projectTrusted: false, saved: { trusted: false } } });
		expect(host.savedTrust()).toEqual({ [host.cwd]: false });
		expect(await host.commandNames(sessionId)).not.toContain(SKILL_COMMAND);
		expect(await host.steeringMode(sessionId)).toBe("all");
	});

	// The desktop app's pull request worktrees: a client marks a folder that must inherit no decision, without saving "do not trust".
	it("saves no_inherit as an explicit no-decision entry: never listed, adds no trust, and a trusted folder above stops deciding", async () => {
		const host = await startHost();
		const sessionId = await host.open();
		await host.send({ type: "set_project_trust", sessionId, choice: "trust_parent" });
		expect(await host.commandNames(sessionId)).toContain(SKILL_COMMAND);
		const answer = await host.send({ type: "set_project_trust", sessionId, choice: "no_inherit" });
		expect(answer).toMatchObject({ success: true, data: { projectTrusted: false, saved: null } });
		expect(
			(answer.data as { choices: Array<{ choice: string }> }).choices.map((entry) => entry.choice),
		).not.toContain("no_inherit");
		expect(host.savedTrust()).toEqual({ [dirname(host.cwd)]: true, [host.cwd]: null });
		expect(await host.commandNames(sessionId)).not.toContain(SKILL_COMMAND);
		expect(await host.commandNames(await host.open())).not.toContain(SKILL_COMMAND);
	});

	it("under Full access, no_inherit drops a trust that came from a saved decision, keeps one from Full access alone, and the next session is trusted", async () => {
		const host = await startHost([], [], { permissionPreset: "full-access" });
		writeFileSync(host.trustFile, JSON.stringify({ [host.cwd]: true }));
		const savedTrusted = await host.open();
		expect(
			await host.send({ type: "set_project_trust", sessionId: savedTrusted, choice: "no_inherit" }),
		).toMatchObject({
			success: true,
			data: { projectTrusted: false, saved: null },
		});
		const fullAccess = await host.open();
		expect(await host.commandNames(fullAccess)).toContain(SKILL_COMMAND);
		expect(await host.send({ type: "set_project_trust", sessionId: fullAccess, choice: "no_inherit" })).toMatchObject(
			{
				success: true,
				data: { projectTrusted: true },
			},
		);
		expect(host.savedTrust()).toEqual({ [host.cwd]: null });
	});

	// #6823 review H1: the host process remembers an unsaved answer per folder; an explicit no_inherit entry is a saved
	// choice, so that memory must never stand in for it.
	it("opens a no_inherit folder undecided although this process earlier resolved it trusted without saving", async () => {
		let grant = true;
		const host = await startHost(
			[],
			[
				(pi) => {
					pi.on("project_trust", () => ({ trusted: grant ? "yes" : "undecided" }));
				},
			],
		);
		const first = await host.open();
		expect(await host.commandNames(first)).toContain(SKILL_COMMAND);
		grant = false;
		expect(await host.send({ type: "set_project_trust", sessionId: first, choice: "no_inherit" })).toMatchObject({
			success: true,
			data: { saved: null },
		});
		expect(host.savedTrust()).toEqual({ [host.cwd]: null });
		expect(await host.commandNames(await host.open())).not.toContain(SKILL_COMMAND);
	});

	// #6823 review L1: an answer given under the explicit no-decision entry (what "Trust (this session only)" leaves)
	// holds for this process's later sessions of that folder, as /new and /fork open them.
	it("keeps an unsaved answer given under a no_inherit entry for later sessions of that folder", async () => {
		let grant = true;
		const host = await startHost(
			[],
			[
				(pi) => {
					pi.on("project_trust", () => ({ trusted: grant ? "yes" : "undecided" }));
				},
			],
		);
		writeFileSync(host.trustFile, JSON.stringify({ [host.cwd]: null }));
		expect(await host.commandNames(await host.open())).toContain(SKILL_COMMAND);
		grant = false;
		expect(await host.commandNames(await host.open())).toContain(SKILL_COMMAND);
		expect(host.savedTrust()).toEqual({ [host.cwd]: null });
	});

	// #6823 review M1: a save ends a remembered answer, even when a later save restores the entry it was given under.
	it("drops an answer given under a no_inherit entry once the folder's trust is saved again, even back to no_inherit", async () => {
		let grant = true;
		const host = await startHost(
			[],
			[
				(pi) => {
					pi.on("project_trust", () => ({ trusted: grant ? "yes" : "undecided" }));
				},
			],
		);
		writeFileSync(host.trustFile, JSON.stringify({ [host.cwd]: null }));
		const first = await host.open();
		expect(await host.commandNames(first)).toContain(SKILL_COMMAND);
		grant = false;
		await host.send({ type: "set_project_trust", sessionId: first, choice: "do_not_trust" });
		await host.send({ type: "set_project_trust", sessionId: first, choice: "no_inherit" });
		expect(host.savedTrust()).toEqual({ [host.cwd]: null });
		expect(await host.commandNames(await host.open())).not.toContain(SKILL_COMMAND);
	});

	// #6823 review round 4 L1: an answer given with nothing saved keeps holding while nothing is saved for the folder,
	// whatever is saved for other folders (the behaviour before #6823, which a TUI /new or /fork relies on).
	it("keeps an unsaved answer given with nothing saved across a save for another folder", async () => {
		let grant = true;
		const host = await startHost(
			[],
			[
				(pi) => {
					pi.on("project_trust", () => ({ trusted: grant ? "yes" : "undecided" }));
				},
			],
		);
		expect(await host.commandNames(await host.open())).toContain(SKILL_COMMAND);
		grant = false;
		const elsewhere = join(dirname(host.cwd), "elsewhere");
		mkdirSync(elsewhere);
		new ProjectTrustStore(dirname(host.trustFile)).set(elsewhere, true);
		expect(host.savedTrust()).toEqual({ [elsewhere]: true });
		expect(await host.commandNames(await host.open())).toContain(SKILL_COMMAND);
	});

	it("refuses an unknown choice and saves nothing", async () => {
		const host = await startHost();
		const sessionId = await host.open();
		const answer = await host.send({ type: "set_project_trust", sessionId, choice: "always" });
		expect(answer).toMatchObject({ success: false, errorCode: "invalid_argument" });
		expect((await host.send({ type: "get_project_trust", sessionId })).data).toMatchObject({ saved: null });
	});

	it("refuses a trust choice a project_trust extension handler decides against: nothing saved, nothing applied", async () => {
		const host = await startHost(
			[],
			[
				(pi) => {
					pi.on("project_trust", () => ({ trusted: "no" }));
				},
			],
		);
		const sessionId = await host.open();
		const answer = await host.send({ type: "set_project_trust", sessionId, choice: "trust" });
		expect(answer).toMatchObject({ success: false, errorCode: "project_trust_extension_decided" });
		expect(existsSync(host.trustFile)).toBe(false);
		expect((await host.send({ type: "get_project_trust", sessionId })).data).toMatchObject({ projectTrusted: false });
		expect(await host.commandNames(sessionId)).not.toContain(SKILL_COMMAND);
		expect(await host.steeringMode(sessionId)).toBe("all");
	});

	it("refuses do_not_trust when a project_trust extension handler trusts the folder", async () => {
		const host = await startHost(
			[],
			[
				(pi) => {
					pi.on("project_trust", () => ({ trusted: "yes" }));
				},
			],
		);
		const sessionId = await host.open();
		expect(await host.commandNames(sessionId)).toContain(SKILL_COMMAND);
		const answer = await host.send({ type: "set_project_trust", sessionId, choice: "do_not_trust" });
		expect(answer).toMatchObject({ success: false, errorCode: "project_trust_extension_decided" });
		expect(existsSync(host.trustFile)).toBe(false);
		expect(await host.commandNames(sessionId)).toContain(SKILL_COMMAND);
	});

	it("applies the choice when the extension handler agrees or stays undecided", async () => {
		const host = await startHost(
			[],
			[
				(pi) => {
					pi.on("project_trust", () => ({ trusted: "undecided" }));
				},
			],
		);
		const sessionId = await host.open();
		const answer = await host.send({ type: "set_project_trust", sessionId, choice: "trust" });
		expect(answer).toMatchObject({ success: true, data: { projectTrusted: true } });
		expect(await host.commandNames(sessionId)).toContain(SKILL_COMMAND);
	});

	it("refuses when the launch named the trust, and saves nothing", async () => {
		const host = await startHost(["--no-approve"]);
		const sessionId = await host.open();
		expect((await host.send({ type: "get_project_trust", sessionId })).data).toMatchObject({ locked: true });
		const answer = await host.send({ type: "set_project_trust", sessionId, choice: "trust" });
		expect(answer).toMatchObject({ success: false, errorCode: "project_trust_locked" });
		expect(await host.commandNames(sessionId)).not.toContain(SKILL_COMMAND);
		expect((await host.send({ type: "get_project_trust", sessionId })).data).toMatchObject({ saved: null });
	});
});

describe("senpi#6176: project settings over RPC", () => {
	it("reads the project settings file even while the project is untrusted", async () => {
		const host = await startHost();
		const sessionId = await host.open();
		expect(await host.send({ type: "get_project_settings", sessionId })).toMatchObject({
			success: true,
			data: {
				cwd: host.cwd,
				path: host.projectSettingsPath,
				exists: true,
				projectTrusted: false,
				settings: { steeringMode: "one-at-a-time" },
				error: null,
			},
		});
	});

	it("refuses a write while the project is untrusted and leaves the file alone", async () => {
		const host = await startHost();
		const sessionId = await host.open();
		const answer = await host.send({
			type: "set_project_setting",
			sessionId,
			key: "defaultThinkingLevel",
			value: "high",
		});
		expect(answer).toMatchObject({ success: false, errorCode: "project_not_trusted" });
		expect(host.projectFile()).toEqual({ steeringMode: "one-at-a-time" });
	});

	it("writes, reads back and removes one key once trusted, and the session takes it on reload", async () => {
		const host = await startHost();
		const sessionId = await host.open();
		await host.send({ type: "set_project_trust", sessionId, choice: "trust" });
		expect(await host.steeringMode(sessionId)).toBe("one-at-a-time");
		const written = await host.send({ type: "set_project_setting", sessionId, key: "steeringMode", value: "all" });
		expect(written).toMatchObject({ success: true, data: { settings: { steeringMode: "all" } } });
		expect(host.projectFile()).toEqual({ steeringMode: "all" });
		expect(await host.send({ type: "reload", sessionId })).toMatchObject({ success: true });
		expect(await host.steeringMode(sessionId)).toBe("all");
		await host.send({ type: "set_project_setting", sessionId, key: "defaultThinkingLevel", value: "high" });
		expect(host.projectFile()).toEqual({ steeringMode: "all", defaultThinkingLevel: "high" });
		const removed = await host.send({ type: "set_project_setting", sessionId, key: "steeringMode", value: null });
		expect(removed).toMatchObject({ success: true, data: { settings: { defaultThinkingLevel: "high" } } });
		expect(host.projectFile()).toEqual({ defaultThinkingLevel: "high" });
	});

	it("refuses a key that is not an identifier", async () => {
		const host = await startHost();
		const sessionId = await host.open();
		await host.send({ type: "set_project_trust", sessionId, choice: "trust" });
		for (const key of ["__proto__x.y", "1st", "a/b"]) {
			const answer = await host.send({ type: "set_project_setting", sessionId, key, value: true });
			expect(answer).toMatchObject({ success: false, errorCode: "invalid_argument" });
		}
		expect(host.projectFile()).toEqual({ steeringMode: "one-at-a-time" });
	});

	// Root ignores directory permissions, so the failing write cannot be staged for it.
	it.skipIf(process.getuid?.() === 0)("reports a write that fails instead of answering success", async () => {
		const host = await startHost();
		const sessionId = await host.open();
		await host.send({ type: "set_project_trust", sessionId, choice: "trust" });
		chmodSync(host.configDir, 0o555);
		chmodSync(host.projectSettingsPath, 0o444);
		try {
			const answer = await host.send({ type: "set_project_setting", sessionId, key: "steeringMode", value: "all" });
			expect(answer).toMatchObject({ success: false, errorCode: "project_settings_write_failed" });
		} finally {
			chmodSync(host.projectSettingsPath, 0o644);
			chmodSync(host.configDir, 0o755);
		}
		expect(host.projectFile()).toEqual({ steeringMode: "one-at-a-time" });
	});

	it("refuses a write over a project settings file that does not parse", async () => {
		const host = await startHost();
		const sessionId = await host.open();
		await host.send({ type: "set_project_trust", sessionId, choice: "trust" });
		writeFileSync(host.projectSettingsPath, "{ not json");
		const read = await host.send({ type: "get_project_settings", sessionId });
		expect(read).toMatchObject({ success: true, data: { exists: true, settings: null } });
		expect((read.data as { error: string | null }).error).not.toBeNull();
		const answer = await host.send({ type: "set_project_setting", sessionId, key: "steeringMode", value: "all" });
		expect(answer).toMatchObject({ success: false, errorCode: "project_settings_unreadable" });
		expect(readFileSync(host.projectSettingsPath, "utf8")).toBe("{ not json");
	});
});
