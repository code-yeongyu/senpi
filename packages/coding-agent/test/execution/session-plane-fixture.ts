// Shared fixture for the S32 session-plane tests: scratch dirs, the session the shipped CLI builds with every built-in
// extension, and ToolHosts that record which side ran each call.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolCall, ToolHost } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import type { ToolDefinition } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { builtInExtensions } from "../../src/extensions/index.ts";
import { createCliRuntimeFactory } from "../../src/main.ts";
import { cleanupHands } from "../hand/remote-hand-fixture.ts";

export const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	await cleanupHands();
});

export async function scratch(
	settings?: Record<string, unknown>,
): Promise<{ readonly cwd: string; readonly agentDir: string }> {
	const root = await mkdtemp(join(tmpdir(), "senpi-s32-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	await mkdir(cwd, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	if (settings) await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings));
	return { cwd, agentDir };
}

export async function shippedSession() {
	const { cwd, agentDir } = await scratch();
	const parsed = parseArgs(["--mode", "rpc", "--no-skills", "--no-context-files", "--no-prompt-templates"]);
	const runtime = await createCliRuntimeFactory(
		{ parsed, cwd, agentDir, appMode: "rpc" },
		{ extensionFactories: [...builtInExtensions] },
	)({ cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
	cleanups.push(async () => {
		runtime.session.dispose();
		await runtime.session.whenToolChildClosed();
	});
	const session = runtime.session;
	const definitions = session.getAllTools().flatMap((tool): ToolDefinition[] => {
		const definition = session.getToolDefinition(tool.name);
		return definition ? [definition] : [];
	});
	return { session, definitions };
}

export function resultOf(call: AgentToolCall, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text }],
		details: {},
		isError: false,
		timestamp: 0,
	};
}

export function recordingHost(side: string, ran: string[]): ToolHost {
	return {
		async execute(call) {
			const messages: ToolResultMessage[] = [];
			for (const raw of call.calls) {
				ran.push(`${side}:${raw.name}`);
				messages.push(resultOf(raw, `${side}:${raw.name}`));
			}
			return { messages, terminate: false };
		},
	};
}

export const call = (id: string, name: string): AgentToolCall => ({ type: "toolCall", id, name, arguments: {} });
export const texts = (messages: readonly ToolResultMessage[]): string[] =>
	messages.map((message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join(""));
