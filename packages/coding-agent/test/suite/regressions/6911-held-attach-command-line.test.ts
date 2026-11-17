/**
 * senpi#6911, the review LOWs of senpi#6909. A terminal start of a session this machine's multi-session host holds
 * attaches to it; these pin what that start does with its command line and its terminal: the prompts, `--model`,
 * `--thinking`, `--use-theme` and `--tui-mode` reach the attached session (L1); `main.ts` attaches and exits without
 * opening the file (L2); an unproven host record keeps the plain refusal (L3); a start whose stdout is not a terminal
 * keeps the exit-76 refusal (L4). Every wait is on the record that proves the step, never on a clock.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { parseArgs } from "../../../src/cli/args.ts";
import { admitStartupSession, SESSION_HELD_EXIT_CODE } from "../../../src/cli/session-opening.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createSessionManager } from "../../../src/main.ts";
import { AttachedTui } from "../../../src/modes/interactive/attach.ts";
import { runAttachedTui } from "../../../src/modes/interactive/run-attached-tui.ts";
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

vi.mock("../../../src/modes/interactive/run-attached-tui.ts", () => ({ runAttachedTui: vi.fn(async () => {}) }));

const SWITCHED_MODEL = `${MOCK_MODEL}-switched`;

class Exited extends Error {
	readonly code: number | undefined;
	constructor(code: number | undefined) {
		super(`exit ${code}`);
		this.code = code;
	}
}

let home: string;
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "held-attach-home-"));
	for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"])
		vi.stubEnv(name, home);
});
const ttyDescriptors = new Map<NodeJS.ReadStream | NodeJS.WriteStream, PropertyDescriptor | undefined>();
afterEach(async () => {
	for (const [stream, descriptor] of ttyDescriptors) {
		if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
		else Reflect.deleteProperty(stream, "isTTY");
	}
	ttyDescriptors.clear();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	vi.mocked(runAttachedTui).mockClear();
	await rm(home, { recursive: true, force: true });
});

/** A real host holding a retained session that has a file, as the desktop leaves it after a turn. */
async function hostHeldSession() {
	const qa = scratch("held-attach");
	const fake = await startFakeModelServer();
	writeRpcModelsJson(qa.agentDir, fake.origin, [SWITCHED_MODEL]);
	const host = spawnRpc(
		["--mode", "rpc", "--listen", `unix://${qa.socketPath}`, "--provider", MOCK_PROVIDER, "--model", MOCK_MODEL],
		qa,
	);
	await waitForStderr(host, `senpi rpc listening on unix://${qa.socketPath}`);
	const keyRoot = process.env.SENPI_RPC_KEY_ROOT;
	process.env.SENPI_RPC_KEY_ROOT = qa.agentDir;
	const desktop = await connectPeer(qa.socketPath);
	const sessionId = openedSessionId(
		await desktop.peer.request({ id: "open", type: "open_session", cwd: qa.cwd, retain_on_disconnect: true }),
	);
	const replied = desktop.peer.waitFor(isEnd("assistant"), 30_000);
	await desktop.peer.request({ id: "p1", type: "prompt", sessionId, message: "say unique-1" });
	await replied;
	const state = await desktop.peer.request({ id: "state", type: "get_state", sessionId });
	const file = String((state.data as { sessionFile?: unknown }).sessionFile);
	const header = JSON.parse((await readFile(file, "utf8")).split("\n")[0] ?? "{}") as { id?: unknown };
	return {
		qa,
		desktop,
		sessionId,
		durableId: String(header.id),
		file,
		async close() {
			if (keyRoot === undefined) delete process.env.SENPI_RPC_KEY_ROOT;
			else process.env.SENPI_RPC_KEY_ROOT = keyRoot;
			desktop.socket.destroy();
			await fake.close();
		},
	};
}

const isEnd =
	(role: string, text?: string) =>
	(value: RecordValue): boolean => {
		const message = value.message as { role?: unknown } | undefined;
		return (
			value.type === "message_end" &&
			message?.role === role &&
			(text === undefined || messageText(value.message) === text)
		);
	};

function terminalAt(stdin: boolean, stdout: boolean): void {
	for (const [stream, value] of [
		[process.stdin, stdin],
		[process.stdout, stdout],
	] as const) {
		if (!ttyDescriptors.has(stream)) ttyDescriptors.set(stream, Object.getOwnPropertyDescriptor(stream, "isTTY"));
		Object.defineProperty(stream, "isTTY", { value, configurable: true, writable: true });
	}
}

async function startCli(args: string[], file: string) {
	const errors: string[] = [];
	vi.spyOn(console, "error").mockImplementation((line: unknown) => void errors.push(String(line)));
	vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new Exited(code === undefined || code === null ? undefined : Number(code));
	});
	const opened = vi.spyOn(SessionManager, "open");
	const outcome = await createSessionManager(
		parseArgs(["--session", file, ...args]),
		dirname(file),
		dirname(file),
		SettingsManager.inMemory(),
		"interactive",
	).catch((error: unknown) => error);
	return { outcome, errors, opened };
}

describe("a terminal start of a host-held session (senpi#6911)", () => {
	it("L2/L1: main.ts attaches with the whole command line, exits 0 and never opens the file", async () => {
		const host = await hostHeldSession();
		try {
			terminalAt(true, true);
			const { outcome, opened } = await startCli(
				[
					"--model",
					`${MOCK_PROVIDER}/${SWITCHED_MODEL}`,
					"--thinking",
					"high",
					"--use-theme",
					"light",
					"--tui-mode",
					"fullscreen",
					"first line",
					"second line",
				],
				host.file,
			);
			expect(outcome).toEqual(new Exited(0));
			expect(opened).not.toHaveBeenCalled();
			expect(vi.mocked(runAttachedTui).mock.calls).toEqual([
				[
					{
						address: host.qa.socketPath,
						session: host.durableId,
						tuiMode: "fullscreen",
						theme: "light",
						startup: {
							model: { provider: MOCK_PROVIDER, modelId: SWITCHED_MODEL },
							thinking: "high",
							prompts: [{ text: "first line" }, { text: "second line" }],
						},
					},
				],
			]);
		} finally {
			await host.close();
		}
	}, 120_000);

	it("L1: a --model the attached session cannot take exactly refuses the start with a notice", async () => {
		const host = await hostHeldSession();
		try {
			terminalAt(true, true);
			const { outcome, errors, opened } = await startCli(["--model", "claude*", "hello"], host.file);
			expect(outcome).toEqual(new Exited(1));
			expect(errors.join("\n")).toContain("--model claude* names no provider");
			expect(runAttachedTui).not.toHaveBeenCalled();
			expect(opened).not.toHaveBeenCalled();
		} finally {
			await host.close();
		}
	}, 120_000);

	it("L4: with stdout redirected the start keeps the exit-76 refusal", async () => {
		const host = await hostHeldSession();
		try {
			terminalAt(true, false);
			const { outcome, errors } = await startCli(["hello"], host.file);
			expect(outcome).toEqual(new Exited(SESSION_HELD_EXIT_CODE));
			expect(errors.join("\n")).toContain("It is open in a multi-session host");
			expect(runAttachedTui).not.toHaveBeenCalled();
		} finally {
			await host.close();
		}
	}, 120_000);

	it("L1: the attached session takes the model, the thinking level and the prompts in order", async () => {
		const host = await hostHeldSession();
		try {
			initTheme("dark");
			const view = new AttachedTui(new TUI(new VirtualTerminal(100, 30)), () => {});
			const switched = host.desktop.peer.waitFor(
				(value) =>
					value.type === "model_changed" && (value.model as { id?: unknown } | undefined)?.id === SWITCHED_MODEL,
				30_000,
			);
			const thought = host.desktop.peer.waitFor(
				(value) => value.type === "thinking_level_changed" && value.level === "high",
				30_000,
			);
			const first = host.desktop.peer.waitFor(isEnd("user", "first line"), 30_000);
			const second = host.desktop.peer.waitFor(isEnd("user", "second line"), 30_000);
			await view.connect(host.qa.socketPath, host.sessionId, {
				model: { provider: MOCK_PROVIDER, modelId: SWITCHED_MODEL },
				thinking: "high",
				prompts: [{ text: "first line" }, { text: "second line" }],
			});
			try {
				await Promise.all([switched, thought, first, second]);
				const order = host.desktop.peer.messages.filter(
					(value) => isEnd("user", "first line")(value) || isEnd("user", "second line")(value),
				);
				expect(order.map((value) => messageText(value.message))).toEqual(["first line", "second line"]);
			} finally {
				await view.close();
			}
		} finally {
			await host.close();
		}
	}, 120_000);
});

describe("an unproven host record (senpi#6911 L3)", () => {
	it("keeps the clear refusal instead of dialling the host", async () => {
		const root = await mkdtemp(join(tmpdir(), "held-unproven-"));
		try {
			const id = randomUUID();
			const file = join(root, "held.jsonl");
			await writeFile(
				file,
				`${JSON.stringify({ type: "session", version: 3, id, cwd: root, timestamp: new Date(0).toISOString() })}\n`,
			);
			const errors: string[] = [];
			const result = await admitStartupSession(file, {
				canAsk: true,
				canAttach: true,
				confirm: async () => {
					throw new Error("nothing is asked");
				},
				err: (line) => void errors.push(line),
				lookup: async () => ({
					holders: [{ pid: 4242, cwd: root, host_instance: "h-1", host_socket: "/run/rpc.sock", unproven: true }],
				}),
			});
			expect(result).toBe("refused");
			expect(errors.join("\n")).toContain("pid 4242");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
