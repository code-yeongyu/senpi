/**
 * senpi#7572 acceptance: the answer key is not present in the environment, files or descriptors of processes the
 * session's tools start, nor anywhere the engine writes. The real key goes through open, an attach that presents it, an
 * answer carrying it, a refused answer carrying it and close; meanwhile the session's own `bash` call records its
 * environment and its open descriptors. Then every byte under the scratch root (agent dir, session files, cwd, the
 * child's records) and the test process's environment are searched for the key.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { ASK_COMMAND, type DelegatedHost } from "../rpc-delegated-host-support.ts";
import { FrameLog, permissionHost } from "../rpc-delegated-permission-support.ts";
import type { WireRecord } from "../rpc-delegated-peer.ts";

let host: DelegatedHost | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
}, 60_000);

/** Every regular file under `root`, read whole; a socket, a FIFO or a vanished entry is skipped. */
async function filesUnder(root: string): Promise<Array<{ path: string; bytes: Buffer }>> {
	const found: Array<{ path: string; bytes: Buffer }> = [];
	for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
		const path = join(entry.parentPath, entry.name);
		const info = await stat(path).catch(() => undefined);
		if (!info?.isFile()) continue;
		found.push({ path, bytes: await readFile(path) });
	}
	return found;
}

describe("#7572 the answer key never leaves the opener and the host's memory", () => {
	it("is absent from the tool child's environment and descriptors, every file under the scratch root, and replies", async () => {
		host = await permissionHost([], { hostArgs: ["--tools", "bash,read"] });
		const cwd = host.cwd;
		host.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(
						"bash",
						{ command: "env > child-env.txt; ls -l /proc/self/fd > child-fds.txt; cat /proc/self/environ > child-environ.bin" },
						{ id: "dump" },
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		const opener = await host.proven();
		const log = new FrameLog(opener);
		const opened = await opener.send({ type: "open_session", designatedAnswerer: true });
		const data = opened.data as { sessionId: string; state: { sessionId: string }; answerKey: string };
		const key = data.answerKey;
		expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const { sessionId } = data;

		const holder = await host.proven();
		expect(
			await holder.send({ type: "attach_session", sessionId, durableSessionId: data.state.sessionId, answerKey: key }),
		).toMatchObject({ success: true, data: { answerer: true } });

		const dumped = log.next(
			(record) => record.type === "tool_execution_end" && record.sessionId === sessionId && record.toolCallId === "dump",
		);
		const idle = log.next((record) => record.type === "agent_idle" && record.sessionId === sessionId);
		await opener.send({ type: "prompt", sessionId, message: "dump" });
		expect(await dumped).toMatchObject({ isError: false });
		await idle;

		const asked = log.next(
			(record) => record.type === "extension_ui_request" && record.sessionId === sessionId && record.title === "Question",
		);
		void opener.send({ type: "prompt", sessionId, message: `/${ASK_COMMAND}` }).catch(() => {});
		const dialog = await asked;
		const keyed: WireRecord = { type: "extension_ui_response", sessionId, uiRequestId: dialog.id, value: "x", answerKey: key };
		const answered = await opener.send(keyed);
		expect(answered).toMatchObject({ success: true });
		const refused = await opener.send(keyed);
		expect(refused.success).toBe(false);
		expect(await opener.send({ type: "close_session", sessionId })).toMatchObject({ success: true });

		const replies = JSON.stringify([answered, refused, ...log.frames.filter((frame) => frame !== opened)]);
		expect(replies).not.toContain(key);
		const files = await filesUnder(host.scratch);
		expect(files.map((file) => file.path)).toEqual(
			expect.arrayContaining([join(cwd, "child-env.txt"), join(cwd, "child-fds.txt"), join(cwd, "child-environ.bin")]),
		);
		expect(files.filter((file) => file.bytes.includes(key)).map((file) => file.path)).toEqual([]);
		expect(Object.values(process.env).filter((value) => value?.includes(key))).toEqual([]);
		const descriptors = await readFile(join(cwd, "child-fds.txt"), "utf8");
		expect(descriptors).not.toContain(join(host.scratch, "s"));
	}, 120_000);
});
