/**
 * omo-desktop-app#6059: the OmO desktop runs its sessions on this machine's multi-session host. Opening such a
 * session in a terminal was refused ("open in a multi-session host; close it there"), so nothing the desktop did
 * reached the terminal and nothing typed there reached the desktop. A terminal start now attaches to the live session
 * on that host: a message or a model switch from either client shows on the other. Every step waits on the record
 * that proves it landed, never on a clock; the latencies are printed for the record.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { admitStartupSession } from "../../../src/cli/session-opening.ts";
import { AttachedTui } from "../../../src/modes/interactive/attach.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { startFakeModelServer } from "../../helpers/rpc-fake-model.ts";
import { MOCK_MODEL, MOCK_PROVIDER, writeRpcModelsJson } from "../../helpers/rpc-hermetic.ts";
import type { RecordValue } from "../../helpers/rpc-jsonl-peer.ts";
import {
	connectPeer,
	messageText,
	openedSessionId,
	scratch,
	spawnRpc,
	waitForStderr,
} from "../../helpers/rpc-socket-host-support.ts";

const SWITCHED_MODEL = `${MOCK_MODEL}-switched`;
const noQuestion = async (): Promise<boolean> => {
	throw new Error("attaching to a host session asks nothing");
};

describe("startup admission of a session a multi-session host holds", () => {
	let root: string;
	let sessionFile: string;
	let id: string;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "held-by-host-"));
		id = randomUUID();
		sessionFile = join(root, "held.jsonl");
		await writeFile(
			sessionFile,
			`${JSON.stringify({ type: "session", version: 3, id, cwd: root, timestamp: new Date(0).toISOString() })}\n`,
		);
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});
	const hostHolder = { pid: 4242, cwd: "/w", host_instance: "h-1", host_socket: "/run/rpc.sock" };

	it("attaches to the host's live session from a terminal", async () => {
		const result = await admitStartupSession(sessionFile, {
			canAsk: true,
			canAttach: true,
			confirm: noQuestion,
			err: () => {},
			lookup: async () => ({ holders: [hostHolder] }),
		});
		expect(result).toEqual({ attach: { socket: "/run/rpc.sock", sessionId: id } });
	});

	it.each([
		{ name: "no terminal to attach", canAsk: false, canAttach: true, holders: [hostHolder] },
		{ name: "a rebind, which rewrites the file", canAsk: true, canAttach: false, holders: [hostHolder] },
		{
			name: "a host without a public socket",
			canAsk: true,
			canAttach: true,
			holders: [{ ...hostHolder, host_socket: undefined }],
		},
		{
			name: "a plain process beside the host",
			canAsk: true,
			canAttach: true,
			holders: [hostHolder, { pid: 7, cwd: "/w" }],
		},
	])("keeps refusing with $name", async ({ canAsk, canAttach, holders }) => {
		const errors: string[] = [];
		const result = await admitStartupSession(sessionFile, {
			canAsk,
			canAttach,
			confirm: noQuestion,
			err: (line) => void errors.push(line),
			lookup: async () => ({ holders }),
		});
		expect(result).toBe("refused");
		expect(errors.join("\n")).toContain("pid 4242");
	});
});

/** Resolves once `done` holds, re-checked on every render the attached view asks for. */
function renderedWhen(ui: TUI, done: () => boolean): Promise<void> {
	if (done()) return Promise.resolve();
	return new Promise((resolve) => {
		const render = ui.requestRender.bind(ui);
		const spy = vi.spyOn(ui, "requestRender").mockImplementation((...args) => {
			render(...args);
			if (!done()) return;
			spy.mockRestore();
			resolve();
		});
	});
}

const lines = (view: AttachedTui) => view.render(120).join("\n");
const count = (text: string, part: string) => text.split(part).length - 1;
// The fake model answers every turn with the first `unique-N` of the conversation, so each reply reads "unique-1".
const REPLY = "unique-1";
const isAssistantEnd = (model: string) => (value: RecordValue) => {
	const message = value.message as { role?: unknown; model?: unknown } | undefined;
	return value.type === "message_end" && message?.role === "assistant" && message.model === model;
};
const isUserEnd = (text: string) => (value: RecordValue) =>
	value.type === "message_end" &&
	(value.message as { role?: unknown } | undefined)?.role === "user" &&
	messageText(value.message) === text;

describe("a terminal and the desktop on one host session (omo-desktop-app#6059)", () => {
	it("a message and a model switch from either side show on the other, with no take-over", async () => {
		const qa = scratch("held-by-host");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin, [SWITCHED_MODEL]);
		const host = spawnRpc(
			["--mode", "rpc", "--listen", `unix://${qa.socketPath}`, "--provider", MOCK_PROVIDER, "--model", MOCK_MODEL],
			qa,
		);
		await waitForStderr(host, `senpi rpc listening on unix://${qa.socketPath}`);
		const keyRoot = process.env.SENPI_RPC_KEY_ROOT;
		process.env.SENPI_RPC_KEY_ROOT = qa.agentDir;
		// The desktop: one client of the host that opened the session, retained like every session it opens there.
		const desktop = await connectPeer(qa.socketPath);
		try {
			const sessionId = openedSessionId(
				await desktop.peer.request({ id: "open", type: "open_session", cwd: qa.cwd, retain_on_disconnect: true }),
			);
			const firstReply = desktop.peer.waitFor(isAssistantEnd(MOCK_MODEL), 30_000);
			await desktop.peer.request({ id: "p1", type: "prompt", sessionId, message: "say unique-1" });
			await firstReply;
			const state = await desktop.peer.request({ id: "state", type: "get_state", sessionId });
			const file = (state.data as { sessionFile?: unknown }).sessionFile;
			expect(typeof file).toBe("string");

			// The terminal: `omo --session <that file>` is admitted as an attach to the host, not refused.
			const admission = await admitStartupSession(String(file), {
				canAsk: true,
				canAttach: true,
				confirm: noQuestion,
				err: (line) => {
					throw new Error(line);
				},
			});
			if (typeof admission !== "object") throw new Error(`expected an attach, got ${admission}`);
			expect(admission.attach.socket).toBe(qa.socketPath);
			initTheme("dark");
			const ui = new TUI(new VirtualTerminal(120, 30));
			const terminal = new AttachedTui(ui, () => {});
			await terminal.connect(admission.attach.socket, admission.attach.sessionId);
			try {
				const before = lines(terminal);
				expect(before).toContain("say unique-1");
				const replies = count(before, REPLY);

				let start = performance.now();
				const shown = renderedWhen(ui, () => {
					const now = lines(terminal);
					return now.includes("say unique-2") && count(now, REPLY) > replies;
				});
				await desktop.peer.request({ id: "p2", type: "prompt", sessionId, message: "say unique-2" });
				await shown;
				const desktopToTerminalMessage = Math.round(performance.now() - start);

				start = performance.now();
				const switched = renderedWhen(ui, () => lines(terminal).includes(`${MOCK_PROVIDER}/${SWITCHED_MODEL}`));
				await desktop.peer.request({
					id: "model",
					type: "set_model",
					sessionId,
					provider: MOCK_PROVIDER,
					modelId: SWITCHED_MODEL,
				});
				await switched;
				const desktopToTerminalModel = Math.round(performance.now() - start);

				start = performance.now();
				const typed = desktop.peer.waitFor(isUserEnd("say unique-3"), 30_000);
				const answered = desktop.peer.waitFor(isAssistantEnd(SWITCHED_MODEL), 30_000);
				await terminal.submit("say unique-3");
				await typed;
				await answered;
				const terminalToDesktopMessage = Math.round(performance.now() - start);

				console.log(
					`#6059 latency ms: desktop->terminal message=${desktopToTerminalMessage} model=${desktopToTerminalModel}; terminal->desktop message=${terminalToDesktopMessage}`,
				);
				// One writer: the host still runs the session, the terminal only attached to it.
				const listed = await desktop.peer.request({ id: "list", type: "list_sessions" });
				expect((listed.data as { sessions: unknown[] }).sessions).toEqual([
					expect.objectContaining({ sessionId, status: "open", attachments: 2, retain_on_disconnect: true }),
				]);
			} finally {
				await terminal.close();
			}
		} finally {
			if (keyRoot === undefined) delete process.env.SENPI_RPC_KEY_ROOT;
			else process.env.SENPI_RPC_KEY_ROOT = keyRoot;
			desktop.socket.destroy();
			await fake.close();
		}
	}, 120_000);
});
