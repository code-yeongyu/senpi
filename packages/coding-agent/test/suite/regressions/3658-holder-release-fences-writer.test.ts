import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { processBootAtMs } from "../../../src/core/extensions/builtin/terminal/process-identity.ts";
import { liveSessionHolders } from "../../../src/core/session-holders.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { encodedSessionId } from "../../../src/core/session-sidecar-store.ts";
import * as fence from "../../../src/core/session-write-fence.ts";

// senpi#3659 review: a holder released because its generation's heartbeat stopped may only be frozen, and a
// host on another endpoint never meets its reservation claim. Releasing the lease therefore advances the session
// file's write fence first: when the frozen holder resumes, its writes are refused and the file stays as is.
vi.mock("../../../src/core/session-write-fence.ts", { spy: true });

let root: string;
let file: string;
let id: string;
let record: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "holder-release-fence-"));
	const writer = SessionManager.create(root, join(root, "sessions"));
	writer.appendMessage({ role: "user", content: "before the freeze", timestamp: Date.now() });
	file = writer.getSessionFile() as string;
	id = writer.getSessionId();
	const dir = join(dirname(file), "session-holders", encodedSessionId(id));
	await mkdir(dir, { recursive: true });
	record = join(dir, "4242.json");
	await writeFile(
		record,
		JSON.stringify({
			pid: 4242,
			bootAtMs: processBootAtMs(),
			processStartedAtMs: 1_700_000_000_000,
			host_instance: "frozen-generation",
			host_daemon_dir: join(root, "daemon"),
		}),
	);
});

afterEach(async () => {
	vi.restoreAllMocks();
	await rm(root, { recursive: true, force: true });
});

const probes = { isProcessAlive: () => true, readProcessStartMs: async () => undefined, holderEnded: async () => true };

it("refuses the writes of a frozen holder that resumes after its lease was released", async () => {
	const frozen = SessionManager.open(file);

	expect(await liveSessionHolders(file, id, probes)).toEqual([]);
	const afterRelease = await readFile(file, "utf8");

	expect(() => frozen.appendMessage({ role: "user", content: "resumed", timestamp: Date.now() })).toThrow(
		fence.SessionFencedError,
	);
	expect(await readFile(file, "utf8")).toBe(afterRelease);
});

it("keeps the lease when the fence cannot be advanced", async () => {
	vi.mocked(fence.advanceSessionFence).mockRejectedValueOnce(new Error("read-only"));

	expect(await liveSessionHolders(file, id, probes)).toEqual([
		{ pid: 4242, cwd: undefined, host_instance: "frozen-generation" },
	]);
	await expect(readFile(record, "utf8")).resolves.toContain("frozen-generation");
});
