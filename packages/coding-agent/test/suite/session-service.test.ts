// senpi#4230: the real registered tool uses session ownership in both tool runtimes.
import { once } from "node:events";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { registerTerminalExtension } from "../../src/core/extensions/builtin/terminal/extension.ts";
import { createHarness } from "./harness.ts";

function pidOf(result: { readonly details?: unknown }): number {
	const pid =
		typeof result.details === "object" && result.details !== null ? Reflect.get(result.details, "pid") : undefined;
	if (typeof pid !== "number") throw new Error(`No service pid in ${JSON.stringify(result)}`);
	return pid;
}

describe.skipIf(process.platform === "win32")("session_service tool", () => {
	it.each(["in-process", "child"] as const)(
		"survives a %s tool call and reload, then stops on session shutdown",
		async (toolRuntime) => {
			const harness = await createHarness({ toolRuntime, extensionFactories: [registerTerminalExtension] });
			await harness.session.bindExtensions({ mode: "rpc" });
			const readyServer = createServer((socket) => socket.end());
			const listening = once(readyServer, "listening");
			readyServer.listen(0, "127.0.0.1");
			await listening;
			const address = readyServer.address();
			if (address === null || typeof address === "string") throw new Error("missing readiness address");
			const ready = once(readyServer, "connection");
			try {
				expect(harness.session.getActiveToolNames()).toContain("session_service");
				const result = await harness.session.executeTool("session_service", {
					action: "ensure",
					key: `foreground-${harness.sessionManager.getSessionId()}`,
					command: process.execPath,
					args: [
						"-e",
						`const net=require("node:net");net.createServer().listen(0,()=>{net.connect(${address.port},"127.0.0.1").end()})`,
					],
				});
				const pid = pidOf(result);
				expect(Reflect.get(result.details ?? {}, "client_env")).toEqual({});
				await ready;
				expect(() => process.kill(pid, 0)).not.toThrow();
				await harness.session.executeTool("bash", { command: "printf raw-call" });
				expect((await harness.session.reload()).cancelled).toBe(false);
				expect(() => process.kill(pid, 0)).not.toThrow();

				await harness.getExtensionRunner().emit({ type: "session_shutdown", reason: "quit" });

				expect(() => process.kill(pid, 0)).toThrow();
				const late = await harness.session.executeTool("session_service", {
					action: "ensure",
					key: "after-close",
					command: "must-not-be-started",
				});
				expect(JSON.stringify(late.content)).toContain("managed_session_closed");
			} finally {
				await harness.getExtensionRunner().emit({ type: "session_shutdown", reason: "quit" });
				await new Promise<void>((resolve, reject) =>
					readyServer.close((error) => (error ? reject(error) : resolve())),
				);
				harness.cleanup();
			}
		},
		30_000,
	);

	it("preserves a native probe refusal and does not start the foreground command", async () => {
		const harness = await createHarness({ extensionFactories: [registerTerminalExtension] });
		await harness.session.bindExtensions({ mode: "rpc" });
		try {
			const result = await harness.session.executeTool("session_service", {
				action: "ensure",
				key: `refused-${harness.sessionManager.getSessionId()}`,
				command: "must-not-be-started",
				args: [],
				probe: {
					command: process.execPath,
					args: ["-e", 'process.stderr.write("FIXTURE_IPC_EACCES");process.exit(7)'],
					absent_message: "FIXTURE_ABSENT",
				},
			});
			expect(result.details).toMatchObject({ isError: true });
			expect(JSON.stringify(result.content)).toContain("FIXTURE_IPC_EACCES");
			expect(JSON.stringify(result.content)).not.toContain("ENOENT");
			const listed = await harness.session.executeTool("session_service", { action: "list" });
			expect(listed.details).toEqual({ services: [] });
		} finally {
			await harness.getExtensionRunner().emit({ type: "session_shutdown", reason: "quit" });
			harness.cleanup();
		}
	}, 30_000);

	it("reuses a live external endpoint with the caller's client settings and leaves it running", async () => {
		const harness = await createHarness({ extensionFactories: [registerTerminalExtension] });
		await harness.session.bindExtensions({ mode: "rpc" });
		const external = createServer((socket) => socket.end());
		const listening = once(external, "listening");
		external.listen(0, "127.0.0.1");
		await listening;
		const address = external.address();
		if (address === null || typeof address === "string") throw new Error("missing external address");
		try {
			const result = await harness.session.executeTool("session_service", {
				action: "ensure",
				key: `external-${address.port}`,
				command: "must-not-be-started",
				client_env: { BSK_AUTO_START: "0" },
				probe: {
					command: process.execPath,
					args: [
						"-e",
						`if(process.env.BSK_AUTO_START!=="0")process.exit(7);const s=require("node:net").connect(${address.port},"127.0.0.1");s.on("connect",()=>s.end());s.on("error",()=>process.exit(9))`,
					],
					absent_message: "FIXTURE_ABSENT",
				},
			});
			expect(result.details).toMatchObject({ ownership: "external", client_env: { BSK_AUTO_START: "0" } });

			await harness.session.executeTool("session_service", { action: "stop", key: `external-${address.port}` });
			await harness.getExtensionRunner().emit({ type: "session_shutdown", reason: "quit" });

			expect(external.listening).toBe(true);
		} finally {
			await harness.getExtensionRunner().emit({ type: "session_shutdown", reason: "quit" });
			await new Promise<void>((resolve, reject) => external.close((error) => (error ? reject(error) : resolve())));
			harness.cleanup();
		}
	}, 30_000);
});
