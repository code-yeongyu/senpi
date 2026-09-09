import { symlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { deadline, resumeRuntime } from "../issue-1473-runtime-support.ts";

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
