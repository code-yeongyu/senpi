import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { ModelUsabilityBudgetError } from "../../../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { deadline, resumeRuntime } from "../issue-1473-runtime-support.ts";

// PR #1473: exercise builtin /btw through a real runtime provider, holding its stream by events.
it.each(["cancelled", "budget-rejected", "accepted"])(
	"PR1473 btw: active query follows %s replacement",
	async (outcome) => {
		const events: string[] = [];
		const host = await resumeRuntime((pi) => {
			pi.on("session_before_switch", () => {
				events.push("veto");
				return { cancel: outcome === "cancelled" };
			});
			pi.on("session_shutdown", () => {
				events.push("shutdown");
			});
		}, 65_536);
		const started = Promise.withResolvers<AbortSignal>();
		const aborted = Promise.withResolvers<void>();
		const stream = createAssistantMessageEventStream();
		let aborts = 0;
		let sideQuery: Promise<void> | undefined;
		try {
			await host.runtime.session.prompt("persist source");
			const live = host.runtime.session;
			const model = host.faux.getModel();
			await host.runtime.services.modelRuntime.registerProvider(model.provider, {
				api: model.api,
				apiKey: "faux-key",
				baseUrl: model.baseUrl,
				models: [model],
				streamSimple: (_model, _context, options) => {
					const signal = options?.signal;
					if (!signal) throw new Error("Missing side-query cancellation signal");
					signal.addEventListener(
						"abort",
						() => {
							aborts++;
							stream.push({
								type: "error",
								reason: "aborted",
								error: fauxAssistantMessage("", { stopReason: "aborted" }),
							});
							stream.end();
							aborted.resolve();
						},
						{ once: true },
					);
					stream.push({
						type: "text_delta",
						contentIndex: 0,
						delta: "active",
						partial: fauxAssistantMessage("active"),
					});
					started.resolve(signal);
					return stream;
				},
			});
			const history = [...live.messages];
			sideQuery = live.prompt("/btw remain active");
			const signal = await deadline(started.promise);
			const target = SessionManager.create(host.cwd, join(host.cwd, "targets"));
			target.appendMessage({
				role: "user",
				content: outcome === "budget-rejected" ? "x".repeat(70_000) : "valid",
				timestamp: 0,
			});
			target.appendMessage(fauxAssistantMessage("stored"));
			const path = target.getSessionFile();
			if (!path) throw new Error("Missing target file");
			const bytes = readFileSync(path);
			if (outcome === "budget-rejected") {
				await expect(host.runtime.switchSession(path)).rejects.toBeInstanceOf(ModelUsabilityBudgetError);
			} else {
				expect(await host.runtime.switchSession(path)).toEqual({ cancelled: outcome === "cancelled" });
			}
			if (outcome === "accepted") {
				await deadline(aborted.promise);
				expect(signal.aborted).toBe(true);
				expect(aborts).toBe(1);
				expect(events).toEqual(["veto", "shutdown"]);
				expect(host.runtime.session).not.toBe(live);
			} else {
				expect.soft(signal.aborted).toBe(false);
				expect.soft(aborts).toBe(0);
				expect.soft(events).toEqual(["veto"]);
				expect(host.runtime.session).toBe(live);
				expect(readFileSync(path)).toEqual(bytes);
				expect(live.messages).toEqual(history);
				stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("completed side query") });
				stream.end();
			}
			await deadline(sideQuery);
		} finally {
			stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("cleanup") });
			stream.end();
			try {
				if (sideQuery) await deadline(sideQuery);
			} finally {
				await host.dispose();
			}
		}
	},
	30_000,
);
