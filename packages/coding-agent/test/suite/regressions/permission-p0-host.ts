import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCall } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { parseArgs } from "../../../src/cli/args.ts";
import { CONFIG_DIR_NAME, getAgentDir } from "../../../src/config.ts";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { createCliRuntimeFactory } from "../../../src/main.ts";
import type { RpcCommand } from "../../../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";

const frameSchema = Type.Object({
	type: Type.String(),
	id: Type.Optional(Type.String()),
	sessionId: Type.Optional(Type.String()),
	title: Type.Optional(Type.String()),
	method: Type.Optional(Type.String()),
	toolCallId: Type.Optional(Type.String()),
	isError: Type.Optional(Type.Boolean()),
	result: Type.Optional(Type.Unknown()),
	data: Type.Optional(Type.Object({ sessionId: Type.Optional(Type.String()) })),
});

export interface PermissionTurn {
	readonly name: string;
	readonly args: ToolCall["arguments"];
}

export interface PermissionHostSetup {
	readonly globalSettings?: Record<string, unknown>;
	readonly projectSettings?: Record<string, unknown>;
	readonly presetFlag?: string;
}

export async function createPermissionP0Host(
	extensionFactories: ExtensionFactory[] = [],
	permissionFlag?: string,
	additionalBuiltins: readonly string[] = [],
	setup: PermissionHostSetup = {},
) {
	const scratch = await mkdtemp(join(tmpdir(), "senpi-perm-p0-"));
	const cwd = join(scratch, "project");
	const agentDir = join(scratch, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({
			enabledBuiltinExtensions: ["permission-system", "tool-search", ...additionalBuiltins],
		}),
	);
	// The permission extension reads global settings from the process agent dir, not the host's.
	const globalSettingsPath = join(getAgentDir(), "settings.json");
	const originalGlobalSettings = setup.globalSettings
		? await readFile(globalSettingsPath, "utf8").catch(() => undefined)
		: undefined;
	if (setup.globalSettings) {
		await mkdir(getAgentDir(), { recursive: true });
		await writeFile(globalSettingsPath, JSON.stringify(setup.globalSettings));
	}
	if (setup.projectSettings) {
		await mkdir(join(cwd, CONFIG_DIR_NAME), { recursive: true });
		await writeFile(join(cwd, CONFIG_DIR_NAME, "settings.json"), JSON.stringify(setup.projectSettings));
	}
	const outsidePath = join(scratch, "outside.txt");
	await writeFile(outsidePath, "private outside content\n");
	const faux = fauxProvider({ api: "permission-p0", provider: "permission-p0" });
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
		...(permissionFlag ? ["--permission", permissionFlag] : []),
		...(setup.presetFlag ? ["--permission-preset", setup.presetFlag] : []),
	]);
	const registry = new RpcSessionRegistry({
		agentDir,
		createRuntime: createCliRuntimeFactory(
			{ parsed, cwd, agentDir, appMode: "rpc" },
			{ extensionFactories: [(pi) => pi.registerProvider(faux.provider), ...extensionFactories] },
		),
		closeGraceMs: 1_000,
	});
	const records: Array<Static<typeof frameSchema>> = [];
	const listeners = new Set<(frame: Static<typeof frameSchema>) => void>();
	const observe = (line: string): void => {
		const frame: unknown = JSON.parse(line);
		if (!Value.Check(frameSchema, frame)) throw new Error("Invalid host event");
		records.push(frame);
		for (const listener of listeners) listener(frame);
	};
	const writer = new SessionEventWriter(observe);
	writer.registerConnection("client", { writeRaw: observe, waitForBackpressure: async () => {} });
	const router = new SessionCommandRouter(registry, writer, { cwd });
	let serial = 0;
	const send = async (command: RpcCommand) => {
		const id = `request-${++serial}`;
		const direct = await writer.withConnection("client", () => router.handle({ ...command, id }));
		if (direct) observe(JSON.stringify(direct));
		await writer.flush();
		return records.find((frame) => frame.id === id);
	};

	return {
		cwd,
		outsidePath,
		async run(preset: string | undefined, turn: PermissionTurn) {
			const opened = await send({
				type: "open_session",
				cwd,
				...(preset === undefined ? {} : { permissionPreset: preset }),
			});
			const sessionId = opened?.data?.sessionId;
			if (!sessionId) {
				throw new Error(`Session failed to open: ${JSON.stringify(opened)}`);
			}
			const runtime = registry.peek(sessionId)?.runtime;
			if (!runtime) throw new Error("Opened session has no runtime");
			if (!runtime.session.getActiveToolNames().includes(turn.name)) {
				throw new Error(`Fixture tool unavailable: ${turn.name}; ${JSON.stringify(runtime.diagnostics)}`);
			}
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall(turn.name, turn.args, { id: "permission-call" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("finished"),
			]);
			const first = records.length;
			const completed = Promise.withResolvers<void>();
			const watchdog = setTimeout(() => completed.reject(new Error("Host turn did not settle")), 30_000);
			const onFrame = (frame: Static<typeof frameSchema>): void => {
				if (frame.sessionId !== sessionId) return;
				if (frame.type === "agent_idle") completed.resolve();
				if (frame.type === "extension_ui_request" && frame.title?.startsWith("Permission required:")) {
					// Exercise the same JSON response envelope sent by an RPC client.
					const response: RpcCommand = JSON.parse(
						JSON.stringify({
							type: "extension_ui_response",
							id: frame.id,
							sessionId,
							value: "Deny",
						}),
					);
					void writer.withConnection("client", () => router.handle(response)).catch(completed.reject);
				}
			};
			listeners.add(onFrame);
			try {
				await send({ type: "prompt", sessionId, message: "perform the scripted action" });
				await completed.promise;
				await runtime.session.waitForSettledSessionWork();
				await writer.flush();
				const frames = records.slice(first).filter((frame) => frame.sessionId === sessionId);
				const approvals = frames.filter(
					(frame) => frame.type === "extension_ui_request" && frame.title?.startsWith("Permission required:"),
				);
				const ended = frames.find(
					(frame) => frame.type === "tool_execution_end" && frame.toolCallId === "permission-call",
				);
				return {
					approvals,
					result: ended?.result,
					isError: ended?.isError,
					activeTools: runtime.session.getActiveToolNames(),
				};
			} finally {
				clearTimeout(watchdog);
				listeners.delete(onFrame);
				await send({ type: "close_session", sessionId });
			}
		},
		async dispose() {
			await router.dispose();
			if (setup.globalSettings) {
				if (originalGlobalSettings === undefined) await rm(globalSettingsPath, { force: true });
				else await writeFile(globalSettingsPath, originalGlobalSettings);
			}
			await rm(scratch, { recursive: true, force: true });
		},
	};
}
