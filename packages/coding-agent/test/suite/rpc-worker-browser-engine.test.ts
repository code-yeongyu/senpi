import { expect, it } from "vitest";
import { startWorkerHost } from "./rpc-worker-host-support.ts";

// `open_session.browserEngine` on the production shape: a real host process whose sessions run in
// worker isolates. The extension reads what its own session was given and runs a real shell
// command through the session's bash tool, then reports both as that session's extension event.
const ENGINE_PROBE = `export default function (pi) {
	pi.registerCommand("engine", {
		description: "report this session's browser engine",
		handler: async (_args, ctx) => {
			const shell = await pi.executeTool("bash", { command: 'printf "%s" "\${OMO_BROWSER_ENGINE-unset}"' });
			const text = (shell.content ?? []).map((block) => block.text ?? "").join("");
			pi.rpc.emit("probe.engine", { context: ctx.browserEngine ?? null, shell: text });
		},
	});
}`;

type Wire = Awaited<ReturnType<Awaited<ReturnType<typeof startWorkerHost>>["connect"]>>;

async function engineOf(wire: Wire, sessionId: string): Promise<unknown> {
	const seen = wire.wait(
		(record) => record.type === "extension_event" && record.name === "probe.engine" && record.sessionId === sessionId,
	);
	const prompt = await wire.request({ type: "prompt", sessionId, message: "/engine" });
	expect(prompt.success).toBe(true);
	return (await seen).data;
}

it("serves two worker sessions on one host, each with only its own browser engine", async () => {
	const host = await startWorkerHost(ENGINE_PROBE, { socket: true });
	try {
		const wire = await host.connect();
		await wire.request({ type: "set_client_info", width: 80, capabilities: ["extension_events"] });
		const connected = await wire.request({ type: "open_session", cwd: host.cwd, browserEngine: "connected" });
		const builtin = await wire.request({ type: "open_session", cwd: host.cwd, browserEngine: "builtin" });
		const unchosen = await wire.request({ type: "open_session", cwd: host.cwd });
		expect([connected.success, builtin.success, unchosen.success]).toEqual([true, true, true]);

		expect(await engineOf(wire, String(connected.data?.sessionId))).toEqual({
			context: "connected",
			shell: "connected",
		});
		expect(await engineOf(wire, String(builtin.data?.sessionId))).toEqual({ context: "builtin", shell: "builtin" });
		expect(await engineOf(wire, String(unchosen.data?.sessionId))).toEqual({ context: null, shell: "unset" });
	} finally {
		await host.dispose();
	}
}, 90_000);

it("moves a live worker session to the engine a later attach names, and keeps it when the attach names none", async () => {
	const host = await startWorkerHost(ENGINE_PROBE, { socket: true });
	try {
		const first = await host.connect();
		await first.request({ type: "set_client_info", width: 80, capabilities: ["extension_events"] });
		const opened = await first.request({ type: "open_session", cwd: host.cwd, browserEngine: "connected" });
		const sessionId = String(opened.data?.sessionId);
		const sessionFile = opened.data?.state?.sessionFile;
		expect(await engineOf(first, sessionId)).toEqual({ context: "connected", shell: "connected" });

		const second = await host.connect();
		const attached = await second.request({
			type: "open_session",
			cwd: host.cwd,
			sessionPath: sessionFile,
			browserEngine: "none",
		});
		expect(attached.data?.attached).toBe(true);
		expect(await engineOf(first, sessionId)).toEqual({ context: "none", shell: "none" });

		const third = await host.connect();
		await third.request({ type: "open_session", cwd: host.cwd, sessionPath: sessionFile });
		expect(await engineOf(first, sessionId)).toEqual({ context: "none", shell: "none" });
	} finally {
		await host.dispose();
	}
}, 90_000);

it("refuses a browser engine it does not know without opening a session", async () => {
	const host = await startWorkerHost(undefined, { socket: true });
	try {
		const wire = await host.connect();
		const refused = await wire.request({ type: "open_session", cwd: host.cwd, browserEngine: "chrome" });
		expect(refused.success).toBe(false);
		expect(String(refused.error)).toContain("browserEngine");
		const listed = await wire.request({ type: "list_sessions" });
		expect(listed.data?.sessions).toEqual([]);
	} finally {
		await host.dispose();
	}
}, 60_000);
