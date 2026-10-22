import { vi } from "vitest";
import { startWorkerHost } from "../rpc-worker-host-support.ts";

/** One extension with every command the omo-desktop-app#4042 suites drive. */
const FIXTURE = [
	"export default function (pi) {",
	'	pi.registerCommand("ask-question", { description: "question fixture", handler: async (_args, ctx) => {',
	'		const result = await ctx.ui.question({ requestId: "follow-connection-question", waitForAnswer: true, timeoutMs: 60000,',
	'			questions: [{ id: "q1", header: "q1", question: "q1", options: [{ label: "A" }, { label: "B" }], multiSelect: false }] });',
	'		ctx.ui.notify("QUESTION_STATUS=" + result.status);',
	"	} });",
	'	pi.registerCommand("emit-event", { description: "extension event fixture", handler: async (args, ctx) => {',
	'		pi.rpc?.emit("fixture.event", { tag: args });',
	'		ctx.ui.notify("EMITTED " + args);',
	"	} });",
	'	pi.registerCommand("custom-ui", { description: "custom component fixture", handler: async (args, ctx) => {',
	"		await ctx.ui.custom(() => ({ render: () => [], invalidate: () => {} }));",
	'		ctx.ui.notify("CUSTOM " + args);',
	"	} });",
	"}",
].join("\n");

export type Host = Awaited<ReturnType<typeof startWorkerHost>>;
export type Client = Awaited<ReturnType<Host["connect"]>>;
export type Runtime = "in-process" | "worker";
export const RUNTIMES = ["in-process", "worker"] as const;

const DIALOG_METHODS = new Set(["question", "select", "input", "confirm"]);

export async function withHost(sessionRuntime: Runtime, run: (host: Host) => Promise<void>): Promise<void> {
	vi.stubEnv("SENPI_RPC_TEST_BUN", process.execPath);
	const host = await startWorkerHost(FIXTURE, { socket: true, sessionRuntime });
	try {
		await run(host);
	} finally {
		await host.dispose();
	}
}

export function nextDialog(client: Client, sessionId: unknown) {
	return client.wait(
		(record) =>
			record.type === "extension_ui_request" &&
			record.sessionId === sessionId &&
			DIALOG_METHODS.has(String(record.method)),
	);
}

/** Runs a fixture command; a host disposed with a degraded dialog open never settles it, on purpose. */
export function run(client: Client, sessionId: unknown, command: string) {
	const prompt = client.request({ type: "prompt", sessionId, message: command });
	prompt.catch(() => undefined);
	return prompt;
}

export function recordsOf(client: Client, sessionId: unknown, type: string, method?: string) {
	return client.records.filter(
		(record) =>
			record.type === type && record.sessionId === sessionId && (method === undefined || record.method === method),
	);
}

/** Waits for the notify a fixture command sends after its own output, which the session orders behind it. */
export function notified(client: Client, sessionId: unknown, message: string) {
	return client.wait(
		(record) =>
			record.type === "extension_ui_request" &&
			record.method === "notify" &&
			record.sessionId === sessionId &&
			record.message === message,
	);
}

export async function openShared(host: Host, first: Client, second: Client) {
	const opened = await first.request({ type: "open_session", cwd: host.cwd, retain_on_disconnect: true });
	const sessionId = opened.data?.sessionId;
	const attached = await second.request({
		type: "open_session",
		cwd: host.cwd,
		sessionPath: opened.data?.state?.sessionFile,
	});
	if (opened.success !== true || attached.success !== true)
		throw new Error(`shared open failed: ${JSON.stringify([opened, attached])}`);
	return { sessionId };
}
