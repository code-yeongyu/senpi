/**
 * C9.a (S25): a caller granted the `drive` class switches one session's model with
 * `set_model { scope: "session" }`. The switch goes through the session-only path: the routed session runs its next
 * turn on the new model, keeps it across a reopen, and extensions see the usual `model_select`, while other sessions
 * and the device default model stay where they were. `set_model` without a scope keeps today's device-wide answer.
 * Records go through the multi-session host's own dispatch (`createHostCore(...).handle`) on the in-process registry,
 * with a faux provider and no network.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { createCliRuntimeFactory } from "../../src/main.ts";
import { classifyRpcMethod, type RpcMethodClass, rpcMethodPermitted } from "../../src/modes/rpc/method-classes.ts";
import { createHostCore } from "../../src/modes/rpc/multi-session-host.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";

type WireRecord = Record<string, unknown>;
type Opened = { sessionId: string; state: { sessionFile: string; model: { id: string } } };
type ModelSelect = { model: string; previous: string | undefined; source: string };

const LEAN_ARGS = ["--mode", "rpc", "--multi-session", "--no-extensions", "--no-skills", "--no-context-files"];
const DRIVE_TO_FAUX_2 = { type: "set_model", provider: "faux", modelId: "faux-2", scope: "session" };

const hosts: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of hosts.splice(0)) await dispose();
	vi.unstubAllEnvs();
});

async function startHost() {
	const scratch = mkdtempSync(join(tmpdir(), "senpi-c9a-"));
	const cwd = join(scratch, "cwd");
	const agentDir = join(scratch, "agent");
	for (const dir of [cwd, agentDir]) mkdirSync(dir);
	const settingsPath = join(agentDir, "settings.json");
	writeFileSync(settingsPath, JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-1" }));
	for (const name of ["SENPI_CODING_AGENT_DIR", "OMO_CODING_AGENT_DIR"]) vi.stubEnv(name, agentDir);
	for (const name of ["OMO_RPC_SOCKET_PATH", "OMO_RPC_SOCKET", "SENPI_RPC_SOCKET", "PI_RPC_SOCKET"])
		vi.stubEnv(name, undefined);
	const faux = fauxProvider({
		models: [
			{ id: "faux-1", reasoning: false, contextWindow: 128_000 },
			{ id: "faux-2", reasoning: false, contextWindow: 128_000 },
		],
	});
	const modelSelects: ModelSelect[] = [];
	const writer = new SessionEventWriter(() => {});
	const answers = new Map<string, (record: WireRecord) => void>();
	const turnEnds = new Map<string, () => void>();
	writer.registerConnection("client", {
		writeRaw: (line) => {
			const record = JSON.parse(line) as WireRecord;
			if (record.type === "response" && typeof record.id === "string") answers.get(record.id)?.(record);
			if (record.type === "agent_end" && typeof record.sessionId === "string") turnEnds.get(record.sessionId)?.();
		},
		waitForBackpressure: async () => {},
	});
	const core = createHostCore(
		{
			agentDir,
			cwd,
			permissionPreset: "full-access",
			createRuntime: createCliRuntimeFactory(
				{ parsed: parseArgs(LEAN_ARGS), cwd, agentDir, appMode: "rpc" },
				{
					extensionFactories: [
						(pi) => {
							pi.registerProvider(faux.provider);
							pi.on("model_select", (event) => {
								modelSelects.push({
									model: event.model.id,
									previous: event.previousModel?.id,
									source: event.source,
								});
							});
						},
					],
				},
			),
		},
		writer,
		[],
	);
	let serial = 0;
	const send = async (command: WireRecord): Promise<WireRecord> => {
		const id = `c9a-${++serial}`;
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
	const completeTurn = async (sessionId: string): Promise<void> => {
		const ended = Promise.withResolvers<void>();
		turnEnds.set(sessionId, ended.resolve);
		faux.setResponses([fauxAssistantMessage("ok")]);
		await send({ type: "prompt", sessionId, message: "Hello." });
		await ended.promise;
		turnEnds.delete(sessionId);
	};
	return {
		faux,
		modelSelects,
		send,
		completeTurn,
		open: async (fields: WireRecord = {}) => (await send({ type: "open_session", ...fields })).data as Opened,
		modelOf: async (sessionId: string) =>
			((await send({ type: "get_state", sessionId })).data as Opened["state"]).model.id,
		savedDefaultModel: () =>
			(JSON.parse(readFileSync(settingsPath, "utf8")) as { defaultModel?: string }).defaultModel,
	};
}

describe("C9.a: drive a session's model over RPC", () => {
	it("classes the session-scoped switch as drive and keeps the device-wide switch device_admin", () => {
		const driven = { ...DRIVE_TO_FAUX_2, sessionId: "a" };
		const deviceWide = { type: "set_model", sessionId: "a", provider: "faux", modelId: "faux-2" };
		const only = (methodClass: RpcMethodClass) => new Set<RpcMethodClass>([methodClass]);
		expect(classifyRpcMethod(driven)).toBe("drive");
		expect(classifyRpcMethod(deviceWide)).toBe("device_admin");
		expect(rpcMethodPermitted(driven, only("drive"))).toBe(true);
		for (const other of ["observe", "answer", "thread"] as const)
			expect(rpcMethodPermitted(driven, only(other))).toBe(false);
		expect(rpcMethodPermitted(deviceWide, only("drive"))).toBe(false);
		expect(rpcMethodPermitted(deviceWide, only("device_admin"))).toBe(true);
	});

	it("runs the driven session's next turn on the new model and leaves other sessions and the default alone", async () => {
		const host = await startHost();
		const driven = await host.open();
		const bystander = await host.open();
		const answer = await host.send({ ...DRIVE_TO_FAUX_2, sessionId: driven.sessionId });
		expect(answer).toMatchObject({ success: true, command: "set_model", data: { provider: "faux", id: "faux-2" } });
		const requested = Promise.withResolvers<string>();
		host.faux.setResponses([
			(_context, _options, _state, model) => {
				requested.resolve(model.id);
				return fauxAssistantMessage("ok");
			},
		]);
		expect(await host.send({ type: "prompt", sessionId: driven.sessionId, message: "Hello." })).toMatchObject({
			success: true,
		});
		expect(await requested.promise).toBe("faux-2");
		expect(await host.modelOf(bystander.sessionId)).toBe("faux-1");
		expect(host.savedDefaultModel()).toBe("faux-1");
		expect((await host.open()).state.model.id).toBe("faux-1");
	});

	it("keeps the driven model when the session is reopened", async () => {
		const host = await startHost();
		const driven = await host.open();
		await host.completeTurn(driven.sessionId);
		await host.send({ ...DRIVE_TO_FAUX_2, sessionId: driven.sessionId });
		await host.send({ type: "close_session", sessionId: driven.sessionId });
		const reopened = await host.open({ sessionPath: driven.state.sessionFile });
		expect(reopened.state.model.id).toBe("faux-2");
		expect(host.savedDefaultModel()).toBe("faux-1");
	});

	it("shows extensions the same model_select a device-wide switch fires", async () => {
		const host = await startHost();
		const driven = await host.open();
		const deviceWide = await host.open();
		host.modelSelects.length = 0;
		await host.send({ ...DRIVE_TO_FAUX_2, sessionId: driven.sessionId });
		const fromDrive = host.modelSelects.splice(0);
		await host.send({ type: "set_model", sessionId: deviceWide.sessionId, provider: "faux", modelId: "faux-2" });
		expect(fromDrive).toEqual([{ model: "faux-2", previous: "faux-1", source: "set" }]);
		expect(host.modelSelects).toEqual(fromDrive);
	});

	it("settles an effect receipt for a session-scoped switch the way set_model does", async () => {
		const host = await startHost();
		const driven = await host.open();
		const command = { ...DRIVE_TO_FAUX_2, sessionId: driven.sessionId, effectId: "c9a-effect" };
		const first = await host.send(command);
		expect(first).toMatchObject({ success: true, data: { id: "faux-2", effectId: "c9a-effect", state: "done" } });
		expect(await host.send(command)).toMatchObject({
			success: true,
			data: { effectId: "c9a-effect", state: "done", replayed: true },
		});
		expect(host.savedDefaultModel()).toBe("faux-1");
	});

	it("answers set_model without a scope as today: the device default follows", async () => {
		const host = await startHost();
		const session = await host.open();
		const answer = await host.send({
			type: "set_model",
			sessionId: session.sessionId,
			provider: "faux",
			modelId: "faux-2",
		});
		expect(Object.keys(answer.data as WireRecord).sort()).toEqual([
			"api",
			"baseUrl",
			"contextWindow",
			"cost",
			"id",
			"input",
			"maxTokens",
			"name",
			"provider",
			"reasoning",
		]);
		expect(host.savedDefaultModel()).toBe("faux-2");
		expect((await host.open()).state.model.id).toBe("faux-2");
	});
});
