import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { SessionResumeConflictError } from "../../../src/core/session-resume-conflict.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { RpcClient } from "../../../src/modes/rpc/rpc-client.ts";
import { deadline, resumeRuntime } from "../issue-1473-runtime-support.ts";
import { startWorkerHost } from "../rpc-worker-host-support.ts";

function resumeSurface(runtimeHost: unknown, cwd: string) {
	const errors: string[] = [];
	let fatals = 0;
	let retries = 0;
	const ctx = Object.assign(Object.create(InteractiveMode.prototype) as object, {
		runtimeHost,
		clearStatusIndicator() {},
		showStatus() {},
		showError(message: string) {
			errors.push(message);
		},
		async handleFatalRuntimeError(_prefix: string, error: unknown) {
			fatals++;
			throw error;
		},
		async promptForMissingSessionCwd() {
			retries++;
			return cwd;
		},
		createProjectTrustContext() {
			return undefined;
		},
	});
	const handle = Object.getOwnPropertyDescriptor(InteractiveMode.prototype, "handleResumeSession")?.value as (
		this: object,
		path: string,
	) => Promise<{ cancelled: boolean }>;
	return { resume: (path: string) => handle.call(ctx, path), errors, fatals: () => fatals, retries: () => retries };
}

// PR #1473 ghN2K/ghN2H: real candidate + awaited veto mutation, not a mocked switch rejection.
it.each(["direct", "cwd retry"])("PR1473 ghN2K: %s resume conflict remains recoverable", async (route) => {
	const retry = route === "cwd retry";
	let target = "";
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const host = await resumeRuntime((pi) => {
		pi.on("session_before_switch", async () => {
			entered.resolve();
			await release.promise;
		});
	});
	let attempt: Promise<{ cancelled: boolean }> | undefined;
	try {
		await host.runtime.session.prompt("persist live");
		const live = host.runtime.session;
		target = join(host.cwd, "target.jsonl");
		const bytes = JSON.stringify({
			type: "session",
			version: 1,
			id: "target",
			timestamp: new Date(0).toISOString(),
			cwd: retry ? join(host.cwd, "gone") : host.cwd,
		});
		writeFileSync(target, bytes);
		const surface = resumeSurface(host.runtime, host.cwd);
		attempt = surface.resume(target);
		// Observe rejection immediately so a failed RED assertion cannot leave an unhandled promise.
		const outcome = attempt.then(
			(result) => ({ result }),
			(error: unknown) => ({ error }),
		);
		await deadline(entered.promise);
		appendFileSync(target, "\n");
		release.resolve();
		expect(await deadline(outcome)).toEqual({ result: { cancelled: true } });
		expect(surface.fatals()).toBe(0);
		expect(surface.retries()).toBe(retry ? 1 : 0);
		expect(surface.errors).toHaveLength(1);
		expect(readFileSync(target, "utf8")).toBe(`${bytes}\n`);
		expect(host.runtime.session).toBe(live);
		await live.prompt("follow-up after conflict");
		expect(live.messages.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "follow-up" }] });
	} finally {
		release.resolve();
		if (attempt)
			await attempt.catch((error: unknown) => {
				expect(error).toBeInstanceOf(SessionResumeConflictError);
			});
		await host.dispose();
	}
});

// PR #1473 ghN2K: a real isolate serializes via connection-handler; RpcClient consumes the socket reply.
it("PR1473 ghN2K: shared-host conflict retains typed identity", async () => {
	const fauxModule = fileURLToPath(new URL("../../../../ai/src/providers/faux.ts", import.meta.url));
	const host = await startWorkerHost(
		String.raw`
 import { appendFileSync } from "node:fs";
 import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(fauxModule)};
 export default function(pi) {
  const faux = fauxProvider({ provider: "pr1473", models: [{ id: "pr1473-faux" }] });
  faux.setResponses([fauxAssistantMessage("PR1473_FOLLOWUP")]);
  pi.registerProvider(faux.provider);
  pi.on("session_before_switch", async (event) => {
   await Promise.resolve();
   appendFileSync(event.targetSessionFile, "\n");
  });
 }
 `,
		{ socket: true },
	);
	const client = new RpcClient({ socketPath: join(host.scratch, "rpc.sock") });
	try {
		const target = join(host.cwd, "target.jsonl");
		const bytes = JSON.stringify({
			type: "session",
			version: 1,
			id: "target",
			timestamp: new Date(0).toISOString(),
			cwd: host.cwd,
		});
		writeFileSync(target, bytes);
		await client.start();
		const opened = await client.openSession({ cwd: host.cwd, provider: "pr1473", modelId: "pr1473-faux" });
		const wire = await host.connect();
		const response = await wire.request({ type: "switch_session", sessionId: opened.sessionId, sessionPath: target });
		expect
			.soft(response)
			.toMatchObject({ success: false, errorCode: "session_resume_conflict", errorData: { sessionFile: target } });
		await expect(client.switchSession(target)).rejects.toBeInstanceOf(SessionResumeConflictError);
		expect(readFileSync(target, "utf8")).toBe(`${bytes}\n\n`);
		for (const retry of [false, true]) {
			const uiTarget = join(host.cwd, retry ? "retry.jsonl" : "direct.jsonl");
			const uiBytes = JSON.stringify({
				type: "session",
				version: 1,
				id: "ui-target",
				timestamp: new Date(0).toISOString(),
				cwd: retry ? join(host.cwd, "gone") : host.cwd,
			});
			writeFileSync(uiTarget, uiBytes);
			const surface = resumeSurface(client, host.cwd);
			expect(await surface.resume(uiTarget)).toEqual({ cancelled: true });
			expect(surface.errors).toHaveLength(1);
			expect(surface.fatals()).toBe(0);
			expect(surface.retries()).toBe(retry ? 1 : 0);
			expect(readFileSync(uiTarget, "utf8")).toBe(`${uiBytes}\n`);
		}
		expect((await client.getState()).sessionId).toBe(opened.state.sessionId);
		const settled = Promise.withResolvers<void>();
		const unsubscribe = client.onEvent((event) => {
			if (event.type === "agent_settled") settled.resolve();
		});
		try {
			await client.prompt("follow-up after conflict", { sessionTitlePrompt: false });
			await deadline(settled.promise);
		} finally {
			unsubscribe();
		}
		expect(JSON.stringify(await client.getMessages())).toContain("PR1473_FOLLOWUP");
		// A different worker can now acquire the changed destination: candidate-only rollback crossed IPC.
		expect(
			await wire.request({
				type: "open_session",
				cwd: host.cwd,
				sessionPath: target,
				provider: "pr1473",
				modelId: "pr1473-faux",
			}),
		).toMatchObject({ success: true });
	} finally {
		await client.stop();
		await host.dispose();
	}
}, 60_000);
