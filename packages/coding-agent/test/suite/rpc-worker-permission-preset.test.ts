import { createServer, type Socket } from "node:net";
import { expect, it, vi } from "vitest";
import type { WorkerHostRecord } from "./rpc-host-endpoint.ts";
import { startWorkerHost } from "./rpc-worker-host-support.ts";

// `open_session.permissionPreset` on an attach, on the production shape of a worker host: the
// session runs in a worker isolate, and its extension runs a real shell command through the
// session's bash tool, which passes the permission system like any tool call (#2823). "/hold-reload"
// parks the next reload inside its session_shutdown on a dialog the test answers, so an attach can
// land while the worker rebuilds the session (#2842). "/hold-next-load <port>" parks the next load of
// this extension, inside the runtime a replacement builds after it read its launch profile, until
// the test's server on <port> answers.
const BASH_PROBE = `import { connect } from "node:net";
export default async function (pi) {
	const loadHoldPort = globalThis.__permissionPresetTestLoadHold;
	if (loadHoldPort !== undefined) {
		globalThis.__permissionPresetTestLoadHold = undefined;
		await new Promise((resolve, reject) => {
			const socket = connect(loadHoldPort, "127.0.0.1");
			socket.once("data", () => resolve(socket.destroy()));
			socket.once("error", reject);
		});
	}
	pi.registerCommand("hold-next-load", {
		description: "park the next load of this extension until the test's server answers",
		handler: async (args, ctx) => {
			globalThis.__permissionPresetTestLoadHold = Number(args);
			ctx.ui.notify("load-hold:armed");
		},
	});
	let holdReload = false;
	pi.registerCommand("hold-reload", {
		description: "park the next reload until the reload-hold dialog is answered",
		handler: async (_args, ctx) => {
			holdReload = true;
			ctx.ui.notify("reload-hold:armed");
		},
	});
	pi.on("session_shutdown", async (event, ctx) => {
		if (event.reason !== "reload" || !holdReload) return;
		holdReload = false;
		await ctx.ui.select("reload-hold", ["release"]);
	});
	pi.registerCommand("run-bash", {
		description: "run one shell command through the bash tool",
		handler: async (_args, ctx) => {
			try {
				const shell = await pi.executeTool("bash", { command: "printf permission-proof" });
				ctx.ui.notify("bash:" + (shell.content ?? []).map((block) => block.text ?? "").join(""));
			} catch (error) {
				ctx.ui.notify("bash:refused:" + (error instanceof Error ? error.message : String(error)));
			}
		},
	});
}`;

const WAIT_MS = 30_000;

type Wire = Awaited<ReturnType<Awaited<ReturnType<typeof startWorkerHost>>["connect"]>>;

/** The server "/hold-next-load" parks on: `reached` yields the held load's socket; writing to it releases the load. */
async function loadHoldServer() {
	const server = createServer();
	let deadline: ReturnType<typeof setTimeout> | undefined;
	const reached = new Promise<Socket>((resolve, reject) => {
		deadline = setTimeout(
			() => reject(new Error(`waited ${WAIT_MS}ms for the replacement's extension load; it was never reached`)),
			WAIT_MS,
		);
		server.once("connection", (socket) => {
			clearTimeout(deadline);
			resolve(socket);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("load-hold server has no TCP port");
	const close = () => {
		clearTimeout(deadline);
		server.close();
	};
	return { port: address.port, reached, close };
}

/** Runs the command once, denying every permission ask; returns how many asks it raised and what bash printed. */
async function runBash(wire: Wire, sessionId: string): Promise<{ asked: number; output: string }> {
	let asked = 0;
	const prompt = wire.request({ type: "prompt", sessionId, message: "/run-bash" });
	for (;;) {
		const record: WorkerHostRecord = await wire.wait(
			(candidate) =>
				candidate.type === "extension_ui_request" &&
				((candidate.method === "select" && String(candidate.title).startsWith("Permission required:")) ||
					(candidate.method === "notify" && String(candidate.message).startsWith("bash:"))),
			WAIT_MS,
		);
		if (record.method === "notify") {
			expect((await prompt).success).toBe(true);
			return { asked, output: String(record.message) };
		}
		asked++;
		wire.send({ type: "extension_ui_response", sessionId, id: record.id, value: "Deny" });
	}
}

it("moves a live worker session to the permission preset a later attach names, keeps it when the attach names none, and treats an unknown one as open does", async () => {
	vi.stubEnv("SENPI_RPC_TEST_BUN", process.execPath);
	const host = await startWorkerHost(BASH_PROBE, { socket: true });
	try {
		const first = await host.connect();
		const opened = await first.request({ type: "open_session", cwd: host.cwd, permissionPreset: "full-access" });
		const sessionId = String(opened.data?.sessionId);
		const sessionPath = opened.data?.state?.sessionFile;
		expect(await runBash(first, sessionId)).toEqual({ asked: 0, output: "bash:permission-proof" });

		const second = await host.connect();
		const attach = (preset?: string) =>
			second.request({
				type: "open_session",
				cwd: host.cwd,
				sessionPath,
				...(preset === undefined ? {} : { permissionPreset: preset }),
			});
		expect((await attach("ask")).data).toMatchObject({ sessionId, attached: true });
		const strict = await runBash(first, sessionId);
		expect(strict.asked).toBe(1);
		expect(strict.output).not.toContain("permission-proof");

		expect((await attach()).data).toMatchObject({ sessionId, attached: true });
		expect((await runBash(first, sessionId)).asked).toBe(1);

		// An unknown preset: the same outcome as a session opened with it.
		const misspelled = await first.request({ type: "open_session", cwd: host.cwd, permissionPreset: "full-acess" });
		const openOutcome = await runBash(first, String(misspelled.data?.sessionId));
		expect(openOutcome.asked).toBe(0);
		expect(openOutcome.output).toContain('Permission setup failed: Invalid --permission-preset "full-acess"');
		expect((await attach("full-acess")).data).toMatchObject({ sessionId, attached: true });
		expect(await runBash(first, sessionId)).toEqual(openOutcome);

		expect((await attach("full-access")).data).toMatchObject({ sessionId, attached: true });
		expect(await runBash(first, sessionId)).toEqual({ asked: 0, output: "bash:permission-proof" });
	} finally {
		await host.dispose();
	}
}, 120_000);

it("enforces the preset an attach names while a reload rebuilds the worker session (#2842)", async () => {
	vi.stubEnv("SENPI_RPC_TEST_BUN", process.execPath);
	const host = await startWorkerHost(BASH_PROBE, { socket: true });
	try {
		const first = await host.connect();
		const opened = await first.request({ type: "open_session", cwd: host.cwd, permissionPreset: "full-access" });
		const sessionId = String(opened.data?.sessionId);
		const sessionPath = opened.data?.state?.sessionFile;
		expect(await runBash(first, sessionId)).toEqual({ asked: 0, output: "bash:permission-proof" });

		const armed = first.wait(
			(record) => record.type === "extension_ui_request" && record.message === "reload-hold:armed",
			WAIT_MS,
		);
		expect((await first.request({ type: "prompt", sessionId, message: "/hold-reload" })).success).toBe(true);
		await armed;
		const held = first.wait(
			(record) =>
				record.type === "extension_ui_request" && record.method === "select" && record.title === "reload-hold",
			WAIT_MS,
		);
		const reloading = first.request({ type: "reload", sessionId });
		const hold = await held;
		const second = await host.connect();
		const attach = await second.request({
			type: "open_session",
			cwd: host.cwd,
			sessionPath,
			permissionPreset: "ask",
		});
		first.send({ type: "extension_ui_response", sessionId, id: hold.id, value: "release" });
		expect(attach.data).toMatchObject({ sessionId, attached: true });
		expect(await reloading).toMatchObject({ success: true, data: { cancelled: false } });

		const strict = await runBash(first, sessionId);
		expect(strict.asked).toBe(1);
		expect(strict.output).not.toContain("permission-proof");
	} finally {
		await host.dispose();
	}
}, 120_000);

it("enforces the preset an attach names while a new_session replacement is built in the worker (#2842)", async () => {
	vi.stubEnv("SENPI_RPC_TEST_BUN", process.execPath);
	const host = await startWorkerHost(BASH_PROBE, { socket: true });
	const loadHold = await loadHoldServer();
	try {
		const first = await host.connect();
		const opened = await first.request({ type: "open_session", cwd: host.cwd, permissionPreset: "full-access" });
		const sessionId = String(opened.data?.sessionId);
		const sessionPath = opened.data?.state?.sessionFile;
		expect(await runBash(first, sessionId)).toEqual({ asked: 0, output: "bash:permission-proof" });

		const armed = first.wait(
			(record) => record.type === "extension_ui_request" && record.message === "load-hold:armed",
			WAIT_MS,
		);
		const arming = await first.request({ type: "prompt", sessionId, message: `/hold-next-load ${loadHold.port}` });
		expect(arming.success).toBe(true);
		await armed;
		const replacing = first.request({ type: "new_session", sessionId });
		const held = await loadHold.reached;
		const second = await host.connect();
		const attach = await second.request({
			type: "open_session",
			cwd: host.cwd,
			sessionPath,
			permissionPreset: "ask",
		});
		held.end("release");
		expect(attach.data).toMatchObject({ sessionId, attached: true });
		expect(await replacing).toMatchObject({ success: true, data: { cancelled: false } });

		const strict = await runBash(first, sessionId);
		expect(strict.asked).toBe(1);
		expect(strict.output).not.toContain("permission-proof");
	} finally {
		loadHold.close();
		await host.dispose();
	}
}, 120_000);
