/**
 * The in-process host core the attach-permission-preset regressions (#2823, #2842) drive: the real
 * registry, router and writer over the real `createCliRuntimeFactory`, so the builtin permission
 * extension loads as in a host session. Only the model is faked: every turn calls `bash` once. A
 * permission ask reaches the clients as an `extension_ui_request` select titled
 * "Permission required: ...", which `runBash` denies.
 *
 * Two hold points pause a rebuild at an await the production code already makes, so a test can
 * land an attach inside it: `reloadHold` inside the `session_shutdown` a reload emits, and
 * `replacementHold` inside the runtime factory a replacement (new, switch, fork, import) awaits,
 * after the replacement's launch profile was read. `lastTurnSettings` reports the prompt surface and
 * browser engine the last turn ran with.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { parseArgs } from "../../../src/cli/args.ts";
import type { CreateAgentSessionRuntimeFactory } from "../../../src/core/agent-session-runtime.ts";
import { createCliRuntimeFactory } from "../../../src/main.ts";
import type { RpcCommand } from "../../../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";

export type WireRecord = Record<string, unknown> & { id?: string; type?: string; sessionId?: string };

/** One armed pause: `reached` resolves when the code under test is parked in it, `release` lets it go. */
export interface Hold {
	readonly reached: Promise<void>;
	release(): void;
}

const disposers: Array<() => Promise<void>> = [];

/** Tears down every host `attachHost` built; a test file registers it with `afterEach`. */
export async function disposeAttachHosts(): Promise<void> {
	for (const dispose of disposers.splice(0).reverse()) await dispose();
}

const isPermissionAsk = (record: WireRecord): boolean =>
	record.type === "extension_ui_request" &&
	record.method === "select" &&
	String(record.title ?? "").startsWith("Permission required:");

/** A point that parks the first caller after `arm()` until the test releases it; unarmed, it passes. */
function holdPoint() {
	let armed: { hit: () => void; released: Promise<void> } | undefined;
	return {
		arm(label: string): Hold {
			let hit!: () => void;
			let release!: () => void;
			const reached = new Promise<void>((resolve, reject) => {
				const deadline = setTimeout(
					() => reject(new Error(`waited 30s for ${label}; it was never reached`)),
					30_000,
				);
				hit = () => {
					clearTimeout(deadline);
					resolve();
				};
			});
			const released = new Promise<void>((resolve) => {
				release = resolve;
			});
			armed = { hit, released };
			return { reached, release };
		},
		async pass(): Promise<void> {
			const current = armed;
			if (!current) return;
			armed = undefined;
			current.hit();
			await current.released;
		},
	};
}

export async function attachHost() {
	const scratch = await mkdtemp(join(tmpdir(), "senpi-attach-preset-"));
	const cwd = join(scratch, "project");
	const agentDir = join(scratch, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	// The session's commands run through the `bash` tool, not an eval cell.
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ disabledBuiltinExtensions: ["codemode"] }));
	const faux = fauxProvider({ api: "fauxattach", provider: "fauxattach" });
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
	]);
	const reloadPoint = holdPoint();
	const replacementPoint = holdPoint();
	// What the session's last turn ran with: the surface its prompt was built for and its browser engine.
	let lastTurn: { promptSurface?: string; browserEngine?: string } | undefined;
	const realFactory = createCliRuntimeFactory(
		{ parsed, cwd, agentDir, appMode: "rpc" },
		{
			extensionFactories: [
				(pi) => {
					pi.registerProvider(faux.provider);
					pi.on("session_shutdown", async (event) => {
						if (event.reason === "reload") await reloadPoint.pass();
					});
					pi.on("before_agent_start", (event, ctx) => {
						lastTurn = { promptSurface: event.systemPromptOptions.surface, browserEngine: ctx.browserEngine };
					});
				},
			],
		},
	);
	const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
		await replacementPoint.pass();
		return realFactory(options);
	};
	const registry = new RpcSessionRegistry({ agentDir, createRuntime, closeGraceMs: 1_000 });
	const records: WireRecord[] = [];
	const listeners = new Set<(record: WireRecord) => void>();
	const observe = (line: string): void => {
		const record = JSON.parse(line) as WireRecord;
		records.push(record);
		for (const listener of [...listeners]) listener(record);
	};
	const writer = new SessionEventWriter(observe);
	for (const connection of ["first", "second"])
		writer.registerConnection(connection, { writeRaw: observe, waitForBackpressure: async () => {} });
	const router = new SessionCommandRouter(registry, writer, { cwd });
	let serial = 0;
	const send = async (connection: string, frame: Record<string, unknown>): Promise<WireRecord | undefined> => {
		const id = `req-${++serial}`;
		const command = JSON.parse(JSON.stringify({ ...frame, id })) as RpcCommand;
		const direct = await writer.withConnection(connection, () => router.handle(command));
		await writer.flush();
		return (direct as WireRecord | undefined) ?? records.find((record) => record.id === id);
	};
	disposers.push(async () => {
		await router.dispose();
		await rm(scratch, { recursive: true, force: true });
	});
	const threadPath = join(scratch, "thread.jsonl");
	return {
		registry,
		send,
		cwd,
		threadPath,
		otherPath: join(scratch, "other.jsonl"),
		/** The prompt surface and browser engine the last turn of any session ran with. */
		lastTurnSettings: () => lastTurn,
		/** Arms a pause inside the next reload's `session_shutdown`. */
		holdNextReload: (): Hold => reloadPoint.arm("the reload's session_shutdown"),
		/** Arms a pause inside the next runtime the factory builds, after its launch profile was read. */
		holdNextReplacement: (): Hold => replacementPoint.arm("the replacement's runtime factory"),
		/** Opens (or attaches to) the thread file from `connection`; `preset` absent sends none. */
		async open(connection: string, preset?: string, sessionPath = threadPath): Promise<WireRecord | undefined> {
			return send(connection, {
				type: "open_session",
				cwd,
				sessionPath,
				retain_on_disconnect: true,
				...(preset === undefined ? {} : { permissionPreset: preset }),
			});
		},
		/** One turn whose model calls `bash`: the permission asks it raised, whether the command ran, and its result. */
		async runBash(sessionId: string): Promise<{ asked: number; ran: boolean; result: string }> {
			const start = records.length;
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command: "printf permission-proof" }, { id: "call-1" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			const denier = (record: WireRecord): void => {
				if (record.sessionId !== sessionId || !isPermissionAsk(record)) return;
				void send("first", {
					type: "extension_ui_response",
					uiRequestId: String(record.id),
					sessionId,
					value: "Deny",
				});
			};
			listeners.add(denier);
			const idle = new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("Deadline waiting for agent_idle")), 60_000);
				const onIdle = (record: WireRecord): void => {
					if (record.type !== "agent_idle" || record.sessionId !== sessionId) return;
					clearTimeout(timer);
					listeners.delete(onIdle);
					resolve();
				};
				listeners.add(onIdle);
			});
			const prompted = await send("first", { type: "prompt", sessionId, message: "go" });
			if (prompted?.success === false) throw new Error(`prompt failed: ${String(prompted.error)}`);
			await idle;
			await registry.peek(sessionId)?.runtime?.session.waitForSettledSessionWork();
			listeners.delete(denier);
			const turn = records.slice(start).filter((record) => record.sessionId === sessionId);
			const end = turn.find((record) => record.type === "tool_execution_end");
			return {
				asked: turn.filter(isPermissionAsk).length,
				ran: ranText(end),
				result: JSON.stringify(end?.result ?? null),
			};
		},
	};
}

/** The bash result text is exactly the command's output when it ran. */
function ranText(end: WireRecord | undefined): boolean {
	const result = end?.result as { content?: Array<{ type: string; text?: string }> } | undefined;
	return (result?.content ?? []).some((block) => block.type === "text" && block.text === "permission-proof");
}

export function sessionIdOf(record: WireRecord | undefined): string {
	const sessionId = (record?.data as { sessionId?: string } | undefined)?.sessionId;
	if (!sessionId) throw new Error(`open_session failed: ${JSON.stringify(record)}`);
	return sessionId;
}
