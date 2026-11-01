import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { recoveryAgentDir } from "../../../src/modes/rpc/compact-storage-health.ts";
import { LegacyReplayStore } from "../../../src/modes/rpc/legacy-replay-store.ts";
import { MAX_RPC_MESSAGE_CHARACTERS } from "../../../src/modes/rpc/rpc-input-validation.ts";
import type { RpcCommand } from "../../../src/modes/rpc/rpc-types.ts";
import type { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import type { SessionWorkerClient } from "../../../src/modes/rpc/session-worker-client.ts";
import { SessionWorkerRequests } from "../../../src/modes/rpc/session-worker-requests.ts";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";
import { FLAG, laneOwned, type WireRecord } from "./4272-construction-host-support.ts";
import { workerAcceptanceHost } from "./4272-worker-acceptance-support.ts";

// Part of #4272, RULING-112: with the flag off, a session past the compact store's 4 MiB spill threshold
// (`compact-content-store.ts`, `spillAboveBytes`) stays on main's legacy path in process and in a worker: a late attach
// replays the legacy replay store's baseline, nothing new reaches stderr, no spill or recovery-health directory appears,
// and a worker commits without the acceptance offer or its permit transport.

const SPILL_ABOVE_BYTES = 4 * 1024 * 1024;
const TURNS = 3;
const PROMPT = "x".repeat(MAX_RPC_MESSAGE_CHARACTERS - 100_000);
const TURN_MS = 120_000;
const SPILL_DIR = /^senpi-(transcript|settled|current)-/;
const HEALTH_DIR = /^\.senpi-recovery-health-/;

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

interface Opened {
	readonly sessionId: string;
	readonly durableSessionId: string;
	readonly worker?: SessionWorkerClient;
}

interface LargeHost {
	readonly agentDir: string;
	readonly writer: SessionEventWriter;
	readonly records: readonly WireRecord[];
	open(): Promise<Opened>;
	prompt(sessionId: string, message: string): Promise<void>;
	/** A second connection attaches after the turns; resolves with every non-response record it received. */
	attachLate(opened: Opened): Promise<WireRecord[]>;
	dispose(): Promise<void>;
}

const durableIdOf = (data: Record<string, unknown>) => String((data.state as { sessionId: string }).sessionId);

// Each prompt is far past the faux window by design; with compaction on, the pre-prompt gate would refuse it.
async function withoutCompaction(agentDir: string): Promise<void> {
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
}

async function inProcessHost(): Promise<LargeHost> {
	const host = await statusHost();
	await withoutCompaction(host.agentDir);
	host.faux.setResponses(Array.from({ length: TURNS }, () => fauxAssistantMessage("ok", { timestamp: 1 })));
	const client = host.client("a");
	const idles = (sessionId: string) =>
		client.inbox.filter((record) => record.type === "agent_idle" && record.sessionId === sessionId).length;
	return {
		agentDir: host.agentDir,
		writer: host.writer,
		records: client.inbox,
		async open() {
			const data = dataOf(await client.request({ type: "open_session", cwd: host.cwd }));
			return { sessionId: String(data.sessionId), durableSessionId: durableIdOf(data) };
		},
		async prompt(sessionId, message) {
			const seen = idles(sessionId);
			const idle = client.waitFor(
				(record) => record.type === "agent_idle" && record.sessionId === sessionId && idles(sessionId) > seen,
				TURN_MS,
			);
			const response = await client.request({ type: "prompt", sessionId, message });
			expect(response.success, JSON.stringify(response)).toBe(true);
			await idle;
		},
		async attachLate({ sessionId, durableSessionId }) {
			const late = host.client("late");
			expect((await late.request({ type: "attach_session", sessionId, durableSessionId })).success).toBe(true);
			await host.writer.flush();
			return late.inbox.filter((record) => record.type !== "response");
		},
		dispose: () => host[Symbol.asyncDispose](),
	};
}

async function workerHost(): Promise<LargeHost> {
	const host = await workerAcceptanceHost();
	await withoutCompaction(join(host.dir, "agent"));
	return {
		agentDir: join(host.dir, "agent"),
		writer: host.writer,
		records: host.records,
		async open() {
			const { sessionId, worker } = await host.open();
			const opened = host.records.find(
				(record) => record.type === "response" && (record.data as { sessionId?: string })?.sessionId === sessionId,
			);
			return { sessionId, worker, durableSessionId: durableIdOf(dataOf(opened ?? {})) };
		},
		async prompt(sessionId, message) {
			const idle = host.next(
				"agent_idle",
				(record) => record.type === "agent_idle" && record.sessionId === sessionId,
				TURN_MS,
			);
			const response = await host.request({ type: "prompt", sessionId, message });
			expect(response.success, JSON.stringify(response)).toBe(true);
			await idle;
		},
		async attachLate({ sessionId, durableSessionId }) {
			const lines: WireRecord[] = [];
			host.writer.registerConnection("late", {
				writeRaw: (chunk) => {
					for (const text of chunk.split("\n")) if (text !== "") lines.push(JSON.parse(text) as WireRecord);
				},
				waitForBackpressure: async () => {},
			});
			const command = { type: "attach_session", sessionId, durableSessionId, id: "late-attach" } as RpcCommand;
			const direct = await host.writer.withConnection("late", () => host.router.handle(command));
			await host.writer.flush();
			const response = direct ?? lines.find((record) => record.type === "response" && record.id === "late-attach");
			expect(response?.success, JSON.stringify(response)).toBe(true);
			return lines.filter((record) => record.type !== "response");
		},
		dispose: () => host.dispose(),
	};
}

/** Every frame the legacy replay store's attach cursor handed out, by session: what a late peer's baseline read. */
function storeBaselines(): Map<string, string[]> {
	const frames = new Map<string, string[]>();
	const freeze = LegacyReplayStore.prototype.freezeAttach;
	vi.spyOn(LegacyReplayStore.prototype, "freezeAttach").mockImplementation(function (
		this: LegacyReplayStore,
		id,
		view,
	) {
		const cursor = freeze.call(this, id, view);
		const read: string[] = [];
		frames.set(id, read);
		return {
			get empty() {
				return cursor.empty;
			},
			next: async () => {
				const frame = await cursor.next();
				if (frame !== undefined) read.push(frame);
				return frame;
			},
			release: () => cursor.release(),
		};
	});
	return frames;
}

async function entries(dirs: readonly string[], pattern: RegExp): Promise<string[]> {
	const found = await Promise.all(
		dirs.map(async (dir) =>
			(await readdir(dir).catch(() => [])).filter((name) => pattern.test(name)).map((name) => join(dir, name)),
		),
	);
	return found.flat().sort();
}

const userChars = (records: readonly WireRecord[], sessionId: string) =>
	records
		.filter((record) => record.type === "message_end" && record.sessionId === sessionId)
		.map((record) => record.message as { role?: string; content?: unknown })
		.filter((message) => message.role === "user")
		.reduce((sum, message) => sum + JSON.stringify(message.content).length, 0);

async function largeFlagOffSession(create: () => Promise<LargeHost>) {
	vi.stubEnv(FLAG, "0");
	const stderr: string[] = [];
	vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		stderr.push(String(chunk));
		return true;
	});
	const frames = storeBaselines();
	const requests = vi.spyOn(SessionWorkerRequests.prototype, "request");
	// A private temp root: other test files create and remove the same spill dirs in the shared tmpdir().
	const temp = await mkdtemp(join(tmpdir(), "l"));
	vi.stubEnv("TMPDIR", temp);
	const host = await create();
	const healthDirs = [host.agentDir, recoveryAgentDir];
	const healthBefore = await entries(healthDirs, HEALTH_DIR);
	try {
		const opened = await host.open();
		for (let turn = 0; turn < TURNS; turn++) await host.prompt(opened.sessionId, `${turn}${PROMPT}`);
		expect(userChars(host.records, opened.sessionId) * 2).toBeGreaterThan(SPILL_ABOVE_BYTES);

		const baseline = await host.attachLate(opened);

		expect(laneOwned(host.writer, opened.sessionId), "the session owns no acceptance lane").toBe(false);
		const remembered = frames.get(opened.sessionId);
		expect(remembered, "the late attach froze the legacy replay store").toBeDefined();
		expect(remembered?.length, "main's baseline is not empty").toBeGreaterThan(0);
		expect(baseline).toEqual(remembered?.map((line) => JSON.parse(line)));
		const added = stderr.filter((line) => /^senpi rpc acceptance:|^senpi rpc worker .* bound mode=/m.test(line));
		expect(added).toEqual([]);
		expect(await entries([temp], SPILL_DIR)).toEqual([]);
		expect(await entries(healthDirs, HEALTH_DIR)).toEqual(healthBefore);
		const commits = requests.mock.calls.map(([message]) => message).filter((message) => message.type === "commit");
		return { opened, commits };
	} finally {
		await host.dispose();
		await rm(temp, { recursive: true, force: true });
	}
}

it("in process: a flag-off session past the spill threshold replays main's legacy baseline to a late attach", async () => {
	const { opened, commits } = await largeFlagOffSession(inProcessHost);
	expect(opened.worker).toBeUndefined();
	expect(commits).toEqual([]);
}, 600_000);

// Node only, like the other real-isolate cases.
it.skipIf(process.versions.bun !== undefined)(
	"worker: the same flag-off session commits on the legacy transport and replays main's legacy baseline",
	async () => {
		const { opened, commits } = await largeFlagOffSession(workerHost);
		expect(commits, "a plain commit: no acceptance offer, recovery epoch or permits").toEqual([{ type: "commit" }]);
		expect(opened.worker?.acceptance).toBeUndefined();
		expect(opened.worker?.intake).toBeUndefined();
	},
	600_000,
);
