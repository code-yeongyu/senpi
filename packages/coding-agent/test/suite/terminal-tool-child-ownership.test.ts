// senpi#3740 review: under --tool-runtime child the server (monitor) and the tool child (bash) each own terminal
// sessions. Their ids must never collide, every bash_output / kill_bash call must reach the session's owner, and a child
// background session's exit must still reach the session as its completion notice.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerTerminalExtension } from "../../src/core/extensions/builtin/terminal/extension.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createHarness } from "./harness.ts";

interface Notice {
	readonly customType: string;
	readonly content: string;
}

function textOf(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

function detailsId(result: { details?: unknown }): string {
	const id: unknown =
		typeof result.details === "object" && result.details !== null
			? Reflect.get(result.details, "bash_id")
			: undefined;
	if (typeof id !== "string")
		throw new Error(`no bash_id in ${JSON.stringify(result.details)}: ${JSON.stringify(result).slice(0, 600)}`);
	return id;
}

class NoticeRecorder {
	readonly #seen = new Map<string, Notice>();
	readonly #waiting = new Map<string, (notice: Notice) => void>();

	record(notice: Notice): void {
		const id = /Background terminal session (\S+) finished/.exec(notice.content)?.[1];
		if (id === undefined) return;
		this.#seen.set(id, notice);
		this.#waiting.get(id)?.(notice);
	}

	noticeFor(id: string): Promise<Notice> {
		const seen = this.#seen.get(id);
		if (seen !== undefined) return Promise.resolve(seen);
		return new Promise((resolveNotice) => this.#waiting.set(id, resolveNotice));
	}

	terminalExtension(): (pi: ExtensionAPI) => void {
		return (pi) =>
			registerTerminalExtension(
				new Proxy(pi, {
					get: (target, key, receiver) =>
						key === "sendMessage"
							? (message: Notice) => this.record(message)
							: Reflect.get(target, key, receiver),
				}),
			);
	}
}

describe.skipIf(process.platform === "win32")("terminal session ownership under the child tool runtime", () => {
	it("keeps server and child ids apart, routes each call to its owner, and relays the child's exit notice", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ttc-own-"));
		const notices = new NoticeRecorder();
		const harness = await createHarness({
			cwd: dir,
			toolRuntime: "child",
			extensionFactories: [notices.terminalExtension()],
		});
		try {
			// The completion notice only wakes an interactive session (print/json never do).
			await harness.session.bindExtensions({ mode: "rpc" });
			const watched = await harness.session.executeTool("monitor", {
				description: "server-side watch",
				command: "echo server-out; sleep 600",
			});
			const serverId = detailsId(watched);
			expect(serverId, textOf(watched)).not.toMatch(/_c\d+_\d+$/);

			const held = await harness.session.executeTool("bash", {
				command: "echo held-out; sleep 600",
				run_in_background: true,
			});
			const heldId = detailsId(held);
			expect(heldId, textOf(held)).toMatch(/^[a-z]+_c\d+_\d+$/);
			expect(heldId).not.toBe(serverId);

			const quick = await harness.session.executeTool("bash", {
				command: "echo quick-out",
				run_in_background: true,
			});
			const quickId = detailsId(quick);
			const delivered = await notices.noticeFor(quickId);
			expect(delivered.content).toContain(`Background terminal session ${quickId} finished: completed`);
			expect(delivered.content).toContain("quick-out");

			const serverRead = textOf(await harness.session.executeTool("bash_output", { bash_id: serverId }));
			expect(serverRead).not.toMatch(/no terminal session found|is lost/i);
			const childRead = textOf(await harness.session.executeTool("bash_output", { bash_id: heldId }));
			expect(childRead).not.toMatch(/no terminal session found|is lost/i);

			expect(textOf(await harness.session.executeTool("kill_bash", { bash_id: serverId }))).toBe(
				`Killed ${serverId}.`,
			);
			expect(textOf(await harness.session.executeTool("kill_bash", { bash_id: heldId }))).toBe(`Killed ${heldId}.`);
		} finally {
			harness.cleanup();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 120_000);
});
