/**
 * oh-my-openagent#13057: `open_session.persona` gives a host session its opener's instructions and tool policy, as
 * `--append-system-prompt` / `--tools` / `--exclude-tools` give them to a process, and never more than the host's own.
 *
 * Runs the real multi-session host core (registry, router, writer) over the real `createCliRuntimeFactory`, so each
 * session's tools are resolved exactly as in a daemon-opened session. Only the model is faked: it records the tools
 * each request offered and calls the tool the case names, which writes a marker file when it runs.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { createCliRuntimeFactory } from "../../../src/main.ts";
import { isHandoverParkedEntry } from "../../../src/modes/rpc/host-handover-parked.ts";
import { parkedEntryFromProfile, parkedOpenCommand } from "../../../src/modes/rpc/host-handover-parked-open.ts";
import type { RpcCommand } from "../../../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";

type WireRecord = Record<string, unknown> & { id?: string; type?: string; sessionId?: string };

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0).reverse()) await dispose();
});

async function personaHost(hostFlags: readonly string[] = []) {
	const scratch = await mkdtemp(join(tmpdir(), "senpi-omo13057-"));
	const cwd = join(scratch, "project");
	const agentDir = join(scratch, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	const faux = fauxProvider({ api: "fauxpersona", provider: "fauxpersona" });
	const model = faux.getModel();
	const parsed = parseArgs([
		"--mode",
		"rpc",
		"--multi-session",
		"--no-skills",
		"--no-context-files",
		"--provider",
		model.provider,
		"--model",
		model.id,
		"--api-key",
		"faux-key",
		...hostFlags,
	]);
	const registry = new RpcSessionRegistry({
		agentDir,
		createRuntime: createCliRuntimeFactory(
			{ parsed, cwd, agentDir, appMode: "rpc" },
			{ extensionFactories: [(pi) => pi.registerProvider(faux.provider)] },
		),
		closeGraceMs: 1_000,
	});
	const records: WireRecord[] = [];
	const idleWaiters = new Map<string, () => void>();
	const observe = (line: string): void => {
		const record = JSON.parse(line) as WireRecord;
		records.push(record);
		if (record.type === "agent_idle" && record.sessionId !== undefined) idleWaiters.get(record.sessionId)?.();
	};
	const writer = new SessionEventWriter(observe);
	writer.registerConnection("client", { writeRaw: observe, waitForBackpressure: async () => {} });
	const router = new SessionCommandRouter(registry, writer, { cwd });
	let serial = 0;
	const send = async (command: Record<string, unknown>): Promise<WireRecord | undefined> => {
		const id = `req-${++serial}`;
		const direct = await writer.withConnection("client", () => router.handle({ ...command, id } as RpcCommand));
		await writer.flush();
		return (direct as WireRecord | undefined) ?? records.find((record) => record.id === id);
	};
	disposers.push(async () => {
		await router.dispose();
		await rm(scratch, { recursive: true, force: true });
	});
	return {
		cwd,
		send,
		async open(fields: Record<string, unknown> = {}): Promise<string> {
			const opened = await send({ type: "open_session", cwd, ...fields });
			const sessionId = (opened?.data as { sessionId?: string } | undefined)?.sessionId;
			if (!sessionId) throw new Error(`open_session failed: ${JSON.stringify(opened)}`);
			return sessionId;
		},
		session(sessionId: string) {
			const session = registry.peek(sessionId)?.runtime?.session;
			if (!session) throw new Error(`no live session ${sessionId}`);
			return session;
		},
		/** One turn whose model calls `tool` with `args`; resolves with the tool names that request offered. */
		async turn(sessionId: string, tool: string, args: Record<string, string>): Promise<readonly string[]> {
			const firstCall = faux.getCallLog().length;
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall(tool, args, { id: "call-1" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			const idle = new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`no agent_idle for ${sessionId} within 30s`)), 30_000);
				idleWaiters.set(sessionId, () => {
					clearTimeout(timer);
					resolve();
				});
			});
			const prompted = await send({ type: "prompt", sessionId, message: "go" });
			if (prompted?.success === false) throw new Error(`prompt failed: ${String(prompted.error)}`);
			await idle;
			idleWaiters.delete(sessionId);
			// The tools the model was offered on the turn's first request, as the provider received them.
			const request = faux.getCallLog()[firstCall]?.context;
			if (request === undefined) throw new Error("the turn sent no request");
			return (request.tools ?? []).map((offeredTool) => offeredTool.name);
		},
	};
}

const marker = (cwd: string, name: string) => ({ path: join(cwd, name), content: "ran" });

describe("open_session.persona (oh-my-openagent#13057)", () => {
	it("a denied tool is absent from the session's tool list and a call to it never runs; the same session without a persona has it (control)", async () => {
		const host = await personaHost();
		const denied = await host.open({ persona: { excludeTools: ["write"] } });
		const control = await host.open();

		const offeredDenied = await host.turn(denied, "write", marker(host.cwd, "denied.txt"));
		const offeredControl = await host.turn(control, "write", marker(host.cwd, "control.txt"));

		expect(offeredDenied).not.toContain("write");
		expect(offeredDenied).toContain("read");
		await expect(readFile(join(host.cwd, "denied.txt"), "utf8")).rejects.toThrow();
		expect(offeredControl).toContain("write");
		expect(await readFile(join(host.cwd, "control.txt"), "utf8")).toBe("ran");
	});

	it("an allow list leaves only those tools; an absent one leaves the host's", async () => {
		const host = await personaHost();
		const allowed = await host.open({ persona: { tools: ["read", "grep"] } });
		const absent = await host.open({ persona: { appendSystemPrompt: "SYNTHETIC-PERSONA" } });

		expect([...host.session(allowed).getActiveToolNames()].sort()).toEqual(["grep", "read"]);
		expect(host.session(absent).getActiveToolNames()).toEqual(host.session(await host.open()).getActiveToolNames());
	});

	it("an empty allow list leaves no tools at all", async () => {
		const host = await personaHost();
		const none = await host.open({ persona: { tools: [] } });

		expect(host.session(none).getActiveToolNames()).toEqual([]);
	});

	it("a persona never widens the host: an allow list naming a tool the host excludes does not enable it", async () => {
		const host = await personaHost(["--exclude-tools", "write"]);
		const asking = await host.open({ persona: { tools: ["read", "write"] } });

		const offered = await host.turn(asking, "write", marker(host.cwd, "widened.txt"));

		expect([...offered].sort()).toEqual(["read"]);
		await expect(readFile(join(host.cwd, "widened.txt"), "utf8")).rejects.toThrow();
	});

	it("the instructions reach the system prompt as literal text, even when they name an existing file", async () => {
		const host = await personaHost();
		const path = join(host.cwd, "persona.md");
		await writeFile(path, "FILE-CONTENT-MUST-NOT-APPEAR");
		const literal = await host.open({ persona: { appendSystemPrompt: "SYNTHETIC-PERSONA: answer only in haiku." } });
		const pathLike = await host.open({ persona: { appendSystemPrompt: path } });

		expect(host.session(literal).systemPrompt).toContain("SYNTHETIC-PERSONA: answer only in haiku.");
		expect(host.session(pathLike).systemPrompt).toContain(path);
		expect(host.session(pathLike).systemPrompt).not.toContain("FILE-CONTENT-MUST-NOT-APPEAR");
	});

	it("an attach naming another persona is refused; the same persona attaches", async () => {
		const host = await personaHost();
		const sessionPath = join(host.cwd, "child.jsonl");
		const persona = { excludeTools: ["write"] };
		await host.open({ sessionPath, persona, retain_on_disconnect: true });

		const wider = await host.send({
			type: "open_session",
			cwd: host.cwd,
			sessionPath,
			persona: { excludeTools: [] },
		});
		const unrestricted = await host.send({ type: "open_session", cwd: host.cwd, sessionPath, persona: {} });
		const same = await host.send({ type: "open_session", cwd: host.cwd, sessionPath, persona });

		for (const refused of [wider, unrestricted]) {
			expect(refused?.success).toBe(false);
			expect(refused?.errorData).toMatchObject({ reason: "persona_mismatch" });
		}
		expect(same?.success).toBe(true);
		expect((same?.data as { attached?: boolean } | undefined)?.attached).toBe(true);
	});

	it("a session replaced in place (new_session, switch_session) keeps its persona", async () => {
		const host = await personaHost();
		const other = join(host.cwd, "other.jsonl");
		const persona = { appendSystemPrompt: "SYNTHETIC-PERSONA", excludeTools: ["write"] };
		const sessionId = await host.open({ persona });

		expect(await host.send({ type: "new_session", sessionId })).toMatchObject({ success: true });
		const afterNew = host.session(sessionId);
		expect(afterNew.getActiveToolNames()).not.toContain("write");
		expect(afterNew.systemPrompt).toContain("SYNTHETIC-PERSONA");

		expect(await host.send({ type: "switch_session", sessionId, sessionPath: other })).toMatchObject({
			success: true,
		});
		const afterSwitch = host.session(sessionId);
		expect(afterSwitch.getActiveToolNames()).not.toContain("write");
		expect(afterSwitch.systemPrompt).toContain("SYNTHETIC-PERSONA");
	});

	it("a persona allowlist on a host that restricts its built-in tools by default is refused, never widened", async () => {
		const host = await personaHost(["--no-builtin-tools"]);

		const refused = await host.send({ type: "open_session", cwd: host.cwd, persona: { tools: ["read", "write"] } });
		const denyOnly = await host.send({ type: "open_session", cwd: host.cwd, persona: { excludeTools: ["write"] } });

		expect(refused?.success).toBe(false);
		expect(String(refused?.error)).toContain("persona_tools_unsupported");
		expect(denyOnly?.success).toBe(true);
	});

	it("a claim that names a persona never takes a session parked without it; the same claim without one does (control)", async () => {
		const host = await personaHost();
		expect(await host.send({ type: "park_session", cwd: host.cwd })).toMatchObject({ success: true });

		const withPersona = await host.send({
			type: "claim_session",
			cwd: host.cwd,
			persona: { excludeTools: ["write"] },
		});
		const without = await host.send({ type: "claim_session", cwd: host.cwd });

		expect(withPersona?.data).toMatchObject({ claimed: false });
		expect(without?.data).toHaveProperty("sessionId");
	});

	it.each([
		["a non-object", "deny"],
		["an unknown key", { excludeTools: ["write"], allowEverything: true }],
		["a non-string tool", { tools: [7] }],
		["a padded tool name, which would deny nothing", { excludeTools: [" write"] }],
		["instructions over the byte budget", { appendSystemPrompt: "\u{AC00}".repeat(40_000) }],
	])("a malformed persona (%s) is refused before any session opens", async (_case, persona) => {
		const host = await personaHost();

		const refused = await host.send({ type: "open_session", cwd: host.cwd, persona });

		expect(refused?.success).toBe(false);
		expect(String(refused?.error)).toMatch(/invalid_launch_profile|does not match its schema/);
	});
});

describe("a successor generation reopens a parked session with its persona (oh-my-openagent#13057)", () => {
	const persona = { appendSystemPrompt: "SYNTHETIC-PERSONA", tools: ["read"], excludeTools: ["write"] };

	it("the park records the persona and the reopen replays it", () => {
		const entry = parkedEntryFromProfile({ sessionPath: "/tmp/s.jsonl" }, { cwd: "/tmp", persona }, []);

		expect(isHandoverParkedEntry(JSON.parse(JSON.stringify(entry)))).toBe(true);
		expect(parkedOpenCommand(entry).persona).toEqual(persona);
	});

	it("a park whose persona is malformed is not a reopenable entry, so the session is never reopened without it", () => {
		const entry = { sessionPath: "/tmp/s.jsonl", retainOnDisconnect: true, persona: { tools: "read" } };

		expect(isHandoverParkedEntry(entry)).toBe(false);
	});
});
