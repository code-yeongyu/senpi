import { symlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { deadline, resumeRuntime } from "../issue-1473-runtime-support.ts";

// PR #1473 ghN2H: a veto is allowed to finish writing before the destination is snapshotted.
it("PR1473 ghN2H: resume observes writes completed by its awaited veto", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let path = "";
	const host = await resumeRuntime((pi) => {
		pi.on("session_before_switch", async () => {
			entered.resolve();
			await release.promise;
			SessionManager.open(path).appendMessage({ role: "user", content: "VETO_WRITE", timestamp: 1 });
		});
	});
	let attempt: Promise<{ cancelled: boolean }> | undefined;
	try {
		const target = SessionManager.create(host.cwd, join(host.cwd, "targets"));
		target.appendMessage(fauxAssistantMessage("stored"));
		const file = target.getSessionFile();
		if (!file) throw new Error("Missing target file");
		path = file;
		attempt = host.runtime.switchSession(path);
		const outcome = attempt.then(
			(result) => ({ result }),
			(error: unknown) => ({ error }),
		);
		await deadline(entered.promise);
		release.resolve();
		expect(await deadline(outcome)).toEqual({ result: { cancelled: false } });
		expect(host.runtime.session.messages).toContainEqual({ role: "user", content: "VETO_WRITE", timestamp: 1 });
		expect(host.runtime.session.messages).toEqual(SessionManager.open(path).buildSessionContext().messages);
	} finally {
		release.resolve();
		if (attempt) await Promise.allSettled([attempt]);
		await host.dispose();
	}
}, 30_000);

// PR #1473: both awaited boundaries must recheck self-resume before persistence or teardown.
it.each(["veto", "factory"])(
	"PR1473 busy: self-resume preserves work started during %s",
	async (stage) => {
		const entered = Promise.withResolvers<void>();
		const releasePreparation = Promise.withResolvers<void>();
		const toolStarted = Promise.withResolvers<void>();
		const releaseTool = Promise.withResolvers<void>();
		let factories = 0;
		let shutdowns = 0;
		let aborts = 0;
		const host = await resumeRuntime(async (pi) => {
			if (factories++ > 0 && stage === "factory") {
				entered.resolve();
				await releasePreparation.promise;
			}
			pi.on("session_before_switch", async () => {
				if (stage === "veto") {
					entered.resolve();
					await releasePreparation.promise;
				}
			});
			pi.on("session_shutdown", () => {
				shutdowns++;
			});
			pi.registerTool({
				name: "block",
				label: "Block",
				description: "Wait for explicit release",
				parameters: Type.Object({}),
				execute: async (_id, _params, signal) => {
					const onAbort = () => {
						aborts++;
						releaseTool.resolve();
					};
					signal?.addEventListener("abort", onAbort, { once: true });
					toolStarted.resolve();
					try {
						await releaseTool.promise;
						return { content: [{ type: "text", text: "BUSY_RESULT" }], details: {} };
					} finally {
						signal?.removeEventListener("abort", onAbort);
					}
				},
			});
		});
		let prompt: Promise<void> | undefined;
		let attempt: Promise<{ cancelled: boolean }> | undefined;
		try {
			await host.runtime.session.prompt("persist source");
			const live = host.runtime.session;
			const path = live.sessionFile;
			if (!path) throw new Error("Missing source file");
			attempt = host.runtime.switchSession(path);
			const result = attempt.then(
				(value) => ({ value }),
				(error: unknown) => ({ error }),
			);
			await deadline(entered.promise);
			host.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("block", {}, { id: "busy-call" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("complete"),
			]);
			prompt = live.prompt("start tool during resume");
			await deadline(toolStarted.promise);
			releasePreparation.resolve();
			expect(await deadline(result)).toEqual({ value: { cancelled: true } });
			expect(host.runtime.session).toBe(live);
			expect(factories).toBe(stage === "veto" ? 1 : 2);
			expect(shutdowns).toBe(0);
			expect(aborts).toBe(0);
			releaseTool.resolve();
			await deadline(prompt);
			expect(live.messages).toEqual(SessionManager.open(path).buildSessionContext().messages);
			expect(live.messages).toContainEqual(
				expect.objectContaining({
					role: "toolResult",
					toolCallId: "busy-call",
					isError: false,
					content: [{ type: "text", text: "BUSY_RESULT" }],
				}),
			);
		} finally {
			releasePreparation.resolve();
			releaseTool.resolve();
			try {
				if (attempt) await deadline(Promise.allSettled([attempt]));
				if (prompt) await deadline(prompt);
			} finally {
				await host.dispose();
			}
		}
	},
	30_000,
);

// PR #1473 ghN2F: the identity guard must use the same normalization as opening the target.
it.each(["file URL", "tilde", "symlink"])(
	"PR1473 ghN2F: normalized busy self-resume preserves the completing tool (%s)",
	async (alias) => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let aborts = 0;
		let vetoes = 0;
		const host = await resumeRuntime((pi) => {
			pi.on("session_before_switch", () => {
				vetoes++;
			});
			pi.registerTool({
				name: "block",
				label: "Block",
				description: "Wait for explicit release",
				parameters: Type.Object({}),
				execute: async (_id, _params, signal) => {
					const onAbort = () => {
						aborts++;
						release.resolve();
					};
					signal?.addEventListener("abort", onAbort, { once: true });
					started.resolve();
					try {
						await release.promise;
						return { content: [{ type: "text", text: "released" }], details: {} };
					} finally {
						signal?.removeEventListener("abort", onAbort);
					}
				},
			});
		});
		let prompt: Promise<void> | undefined;
		try {
			await host.runtime.session.prompt("persist source");
			const live = host.runtime.session;
			const path = live.sessionFile!;
			const link = join(host.cwd, "alias.jsonl");
			symlinkSync(path, link);
			vi.stubEnv("HOME", host.cwd);
			vi.stubEnv("USERPROFILE", host.cwd);
			const input =
				alias === "file URL"
					? pathToFileURL(path).href
					: alias === "tilde"
						? `~/${relative(host.cwd, path)}`
						: link;
			host.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("block", {}, { id: "completing-tool" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("complete"),
			]);
			prompt = live.prompt("start tool");
			await deadline(started.promise);
			expect(await host.runtime.switchSession(input)).toEqual({ cancelled: true });
			expect(host.runtime.session).toBe(live);
			expect(host.factories()).toBe(1);
			expect(vetoes).toBe(0);
			expect(aborts).toBe(0);
			release.resolve();
			await deadline(prompt);
			expect(live.messages).toEqual(SessionManager.open(path).buildSessionContext().messages);
			expect(live.messages.filter((m) => m.role === "toolResult")).toMatchObject([
				{ toolCallId: "completing-tool", isError: false, content: [{ type: "text", text: "released" }] },
			]);
		} finally {
			release.resolve();
			if (prompt) await deadline(prompt);
			vi.unstubAllEnvs();
			await host.dispose();
		}
	},
	30_000,
);
