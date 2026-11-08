import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { vi } from "vitest";
import { z } from "zod";
import type { RawClient, RawRecord } from "./rpc-raw-socket-client.ts";
import { startInProcessHost, startWorkerHost } from "./rpc-worker-host-support.ts";

export const PROBE_TEXT = "probe-content-6189";
const TURNS = 8;
const FAUX = pathToFileURL(fileURLToPath(new URL("../../../ai/dist/providers/faux.js", import.meta.url))).href;

// Every model turn reads `probe.txt` once: under `ask` that read raises "Permission required: read", under
// `full-access` it returns PROBE_TEXT.
/** The probe extension source; `callIdPrefix` names its tool calls. */
export function probeExtensionSource(callIdPrefix = "call-"): string {
	return `import { fauxAssistantMessage, fauxProvider, fauxToolCall } from ${JSON.stringify(FAUX)};
export default function (pi) {
	const faux = fauxProvider({ api: "fauxsock", provider: "fauxsock" });
	const turns = [];
	for (let turn = 0; turn < ${TURNS}; turn++) {
		turns.push(fauxAssistantMessage([fauxToolCall("read", { path: "probe.txt" }, { id: ${JSON.stringify(callIdPrefix)} + turn })], { stopReason: "toolUse" }));
		turns.push(fauxAssistantMessage("done"));
	}
	faux.setResponses(turns);
	pi.registerProvider(faux.provider);
	const changes = [];
	pi.events.on("permission_preset_changed", (mode) => changes.push(mode.permissionPreset));
	pi.registerCommand("mode-probe", {
		description: "reports the permission mode this extension sees",
		handler: async (_args, ctx) => {
			ctx.ui.notify("mode-probe:" + JSON.stringify({ getter: pi.getPermissionPreset(), changes }));
		},
	});
	pi.registerCommand("raise-session", {
		description: "raises one dialog addressed to the whole session",
		handler: async (_args, ctx) => {
			const choice = await pi.sessionDialog.select("session-raise", ["A", "B"]);
			ctx.ui.notify("raised:" + choice);
		},
	});
}`;
}
const EXTENSION = probeExtensionSource();

export type HostRuntime = "in-process" | "worker";

export async function permissionModeHost(runtime: HostRuntime = "in-process") {
	vi.stubEnv("SENPI_RPC_TEST_BUN", process.execPath);
	const host =
		runtime === "in-process"
			? await startInProcessHost(EXTENSION)
			: await startWorkerHost(EXTENSION, { socket: true });
	await writeFile(join(host.cwd, "probe.txt"), PROBE_TEXT);
	return host;
}

const replySchema = z.object({
	success: z.boolean(),
	error: z.string().optional(),
	data: z.record(z.string(), z.unknown()).optional(),
});

export function replyOf(record: RawRecord): z.infer<typeof replySchema> {
	return replySchema.parse(record);
}

export function dataOf(record: RawRecord): Record<string, unknown> {
	const reply = replyOf(record);
	if (!reply.success) throw new Error(`request failed: ${reply.error}`);
	return reply.data ?? {};
}

export async function openFauxSession(
	client: RawClient,
	cwd: string,
	extra: Record<string, unknown> = {},
): Promise<{ sessionId: string; data: Record<string, unknown> }> {
	const data = dataOf(
		await client.request({ type: "open_session", cwd, provider: "fauxsock", modelId: "faux-1", ...extra }),
	);
	return { sessionId: String(data.sessionId), data };
}

export async function stateOf(client: RawClient, sessionId: string): Promise<Record<string, unknown>> {
	return dataOf(await client.request({ type: "get_state", sessionId }));
}

export async function readTurn(client: RawClient, sessionId: string): Promise<{ asked: string[]; result: string }> {
	const asked: string[] = [];
	const answered = new Set<unknown>();
	const before = client.records.length;
	const idle = client.wait((record) => {
		if (record.sessionId !== sessionId || client.records.indexOf(record) < before) return false;
		if (record.type === "extension_ui_request" && record.method === "select" && !answered.has(record.id)) {
			answered.add(record.id);
			asked.push(String(record.title).split("\n")[0]);
			client.send({ type: "extension_ui_response", sessionId, id: record.id, value: "Deny" });
			return false;
		}
		return record.type === "agent_idle";
	}, 60_000);
	const ended = client.wait(
		(record) =>
			record.type === "tool_execution_end" &&
			record.sessionId === sessionId &&
			client.records.indexOf(record) >= before,
		60_000,
	);
	await client.request({ type: "prompt", sessionId, message: "go" });
	const end = await ended;
	await idle;
	return { asked, result: JSON.stringify(end) };
}

export async function notifiedAfter(
	client: RawClient,
	sessionId: string,
	prefix: string,
	before: number,
): Promise<string> {
	const record = await client.wait(
		(candidate) =>
			candidate.sessionId === sessionId &&
			candidate.type === "extension_ui_request" &&
			candidate.method === "notify" &&
			String(candidate.message).startsWith(prefix) &&
			client.records.indexOf(candidate) >= before,
	);
	return String(record.message).slice(prefix.length);
}
