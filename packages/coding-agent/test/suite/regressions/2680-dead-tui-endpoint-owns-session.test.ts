/**
 * senpi#2680: a `tui` endpoint whose terminal died uncleanly keeps naming the session it held.
 *
 * The live `list_sessions` answer is gone with the socket, so `owner` falls back to the session
 * record registration wrote into the endpoint directory - but only when that record's pid AND
 * processStartTime match the endpoint's current generation, so a new terminal reusing the socket
 * path never inherits the previous one's session. The registration-time sweep of dead `tui`
 * endpoints keeps such a record-bearing endpoint; an explicit `host gc` still removes it.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exitedPid } from "../../helpers/rpc-host-gc-fixtures.ts";
import { type EndpointFixture, startEndpoint } from "../../helpers/session-control-fixture.ts";
import {
	createDaemonDirectories,
	createHostDaemonPaths,
	type HostDaemonPaths,
} from "../../../src/modes/rpc/host-daemon-paths.ts";
import { thisProcessStartTime, writeHostRegistration } from "../../../src/modes/rpc/host-daemon-registration.ts";
import { gcHostEndpoints } from "../../../src/modes/rpc/host-gc.ts";
import { readAllHostStatus } from "../../../src/modes/rpc/host-status-all.ts";

const roots: string[] = [];
const fixtures: EndpointFixture[] = [];
const GENERATION_START = "2026-01-01T00:00:00.000Z";

afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		await fixture.endpoint.dispose();
		fixture.harness.cleanup();
	}
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A `tui` endpoint directory whose terminal exited without unregistering. */
async function deadTuiEndpoint(
	agentDir: string,
	label: string,
): Promise<{ readonly paths: HostDaemonPaths; readonly pid: number }> {
	const socket = join(agentDir, "rpc", "tui", `${label}.sock`);
	mkdirSync(join(socket, ".."), { recursive: true });
	const paths = createHostDaemonPaths({ socket, agentDir });
	const pid = await exitedPid();
	await createDaemonDirectories(paths, { kind: "tui" });
	await writeHostRegistration(paths, {
		record: { pid, processStartTime: GENERATION_START },
		socket,
		instanceId: "gen-a",
		generation: 0,
		launchProfileId: "fixture",
	});
	return { paths, pid };
}

/** The session record a registration writes, with whichever fields a case overrides. */
async function writeSessionRecord(
	paths: HostDaemonPaths,
	generation: { readonly pid: number; readonly processStartTime: string },
	session: {
		readonly id: string;
		readonly path?: string | null;
		readonly name?: string | null;
		readonly cwd?: string | null;
		readonly pid?: number;
		readonly processStartTime?: string;
	},
): Promise<void> {
	await writeFile(
		join(paths.dir, "tui-session.json"),
		`${JSON.stringify({
			id: session.id,
			path: session.path ?? null,
			name: session.name ?? null,
			cwd: session.cwd ?? null,
			pid: session.pid ?? generation.pid,
			processStartTime: session.processStartTime ?? generation.processStartTime,
		})}\n`,
	);
}

describe.skipIf(process.platform === "win32")("a dead tui endpoint still names its session (#2680)", () => {
	it("reports the recorded session on a dead row", async () => {
		// Given: a terminal died without unregistering, its endpoint directory holding the session record.
		const agentDir = mkdtempSync(join(tmpdir(), "sa-2680-dead-row-"));
		roots.push(agentDir);
		const { paths, pid } = await deadTuiEndpoint(agentDir, "gone");
		await writeSessionRecord(
			paths,
			{ pid, processStartTime: GENERATION_START },
			{
				id: "s-dead",
				path: "/sessions/s-dead.jsonl",
				name: "the-name",
				cwd: "/w/dead",
			},
		);

		// When: every endpoint is read after the socket is gone.
		const [row] = await readAllHostStatus({ agentDir, includeWorkers: false });

		// Then: the row stays dead but still names the session it held.
		expect(row).toMatchObject({
			endpoint_kind: "tui",
			dir: paths.dir,
			alive: false,
			owner: {
				pid,
				cwd: "/w/dead",
				session: { id: "s-dead", path: "/sessions/s-dead.jsonl", name: "the-name" },
			},
		});
	});

	it("never uses a record whose pid belongs to another generation", async () => {
		// Given: the dead endpoint's record names a different pid - a recycled or foreign terminal.
		const agentDir = mkdtempSync(join(tmpdir(), "sa-2680-pid-mismatch-"));
		roots.push(agentDir);
		const { paths, pid } = await deadTuiEndpoint(agentDir, "gone");
		await writeSessionRecord(
			paths,
			{ pid, processStartTime: GENERATION_START },
			{
				id: "s-other",
				cwd: "/w/other",
				pid: pid + 1,
			},
		);

		// When / Then: the dead row names no session and no cwd.
		const [row] = await readAllHostStatus({ agentDir, includeWorkers: false });
		expect(row).toMatchObject({
			dir: paths.dir,
			alive: false,
			owner: { pid, cwd: null, session: null },
		});
	});

	it("never uses a record whose processStartTime differs from the current generation", async () => {
		// Given: the record carries the same pid but another start time - the socket path was reused.
		const agentDir = mkdtempSync(join(tmpdir(), "sa-2680-start-mismatch-"));
		roots.push(agentDir);
		const { paths, pid } = await deadTuiEndpoint(agentDir, "reused");
		await writeSessionRecord(
			paths,
			{ pid, processStartTime: GENERATION_START },
			{
				id: "s-old",
				cwd: "/w/old",
				processStartTime: "2000-01-01T00:00:00.000Z",
			},
		);

		// When / Then: the reused socket path does not inherit the previous terminal's session.
		const [row] = await readAllHostStatus({ agentDir, includeWorkers: false });
		expect(row?.dir).toBe(paths.dir);
		expect(row?.owner).toEqual({ pid, cwd: null, session: null });
	});

	it("keeps a dead endpoint that names a session in the registration sweep; host gc still removes it", async () => {
		// Given: a dead tui endpoint whose directory holds a session record.
		const agentDir = mkdtempSync(join(tmpdir(), "sa-2680-sweep-"));
		roots.push(agentDir);
		const { paths, pid } = await deadTuiEndpoint(agentDir, "gone");
		await writeSessionRecord(
			paths,
			{ pid, processStartTime: GENERATION_START },
			{
				id: "s-dead",
				path: "/sessions/s-dead.jsonl",
				cwd: "/w/dead",
			},
		);

		// When: another terminal's registration-time sweep runs over dead tui endpoints.
		const sweep = await gcHostEndpoints(agentDir, { kinds: ["tui"], keepDeadNamingSessions: true });

		// Then: the record-bearing endpoint is kept for the session it names.
		expect(sweep.removed).toEqual([]);
		expect(sweep.kept).toEqual([expect.objectContaining({ dir: paths.dir, reason: "session_record" })]);

		// And: an explicit host gc still removes it on the same evidence.
		const removed = await gcHostEndpoints(agentDir);
		expect(removed.removed).toEqual([expect.objectContaining({ dir: paths.dir })]);
		expect(await readAllHostStatus({ agentDir, includeWorkers: false })).toEqual([]);
	});

	it("writes the session record when a terminal registers its endpoint", async () => {
		// Given: one terminal registered a control endpoint in the agent directory.
		const agentDir = mkdtempSync(join(tmpdir(), "sa-2680-register-"));
		roots.push(agentDir);
		const fixture = await startEndpoint({ agentDir });
		fixtures.push(fixture);
		const session = fixture.harness.session;

		// When: the endpoint is read and its directory's session record with it.
		const rows = await readAllHostStatus({ agentDir, includeWorkers: false });
		const record = JSON.parse(await readFile(join(rows[0]?.dir ?? "", "tui-session.json"), "utf8")) as Record<
			string,
			unknown
		>;

		// Then: the endpoint is alive and the record names the session it holds, under its own pid.
		expect(rows).toEqual([expect.objectContaining({ endpoint_kind: "tui", socket: fixture.socket, alive: true })]);
		expect(record).toMatchObject({
			id: session.sessionId,
			path: session.sessionFile ?? null,
			name: session.sessionName ?? null,
			cwd: session.sessionManager.getCwd(),
			pid: process.pid,
			processStartTime: await thisProcessStartTime(),
		});
	});
});
