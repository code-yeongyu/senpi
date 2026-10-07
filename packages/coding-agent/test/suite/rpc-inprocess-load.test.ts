import { statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listedSessions, MAX_THREADS_PER_SESSION, opened, threadCount } from "./rpc-inprocess-host-metrics.ts";
import {
	blockingTool,
	churnLine,
	fillResponsePool,
	measurePluginCell,
	openWorker,
	probeGetState,
	probeLine,
	queueToolTurn,
	resolveOmoPluginExtensions,
	runChurnCell,
	settled,
	slowAsyncTool,
	writeLargeTranscript,
	zombieCount,
} from "./rpc-inprocess-load-probes.ts";
import {
	contentionLine,
	createLoadHost,
	latencyLine,
	nodeLine,
	percentile,
	report,
	round,
	rssMb,
	scaleLine,
} from "./rpc-inprocess-load-support.ts";
import { startWorkerHost } from "./rpc-worker-host-support.ts";

/** Sessions the SCALE cell holds open at once - 50x the worker runtime's admission bound. */
const SCALE_SESSIONS = 1_000;
/** Sessions the SCALE cell closes and then reopens by path. */
const REOPENED_SESSIONS = 200;
const CHURN_CYCLES = 2_000;
const CHURN_CONCURRENCY = 50;
const CONCURRENT_STREAMS = 50;
const BASELINE_STREAMS = 20;
const PLUGIN_SESSIONS = 200;
const NODE_SESSIONS = 50;
const TRANSCRIPT_BYTES = 50_000_000;
/** Ceiling the todo names for a listing on a fully loaded host. */
const LIST_P95_BUDGET_MS = 500;
/** Ceiling the todo names for a neighbour's `get_state` while another session works. */
const NEIGHBOUR_P95_BUDGET_MS = 50;
const CELL_TIMEOUT_MS = 300_000;
/** Churn measures 2,000 real open/close cycles on Bun: 258 s measured, plus the GC settle. */
const CHURN_TIMEOUT_MS = 420_000;

// Opt-in: these cells hold thousands of real runtimes and run for minutes, so CI
// never pays for them. `SENPI_LOAD_TESTS=1` is the only way in.
describe.skipIf(process.env.SENPI_LOAD_TESTS !== "1")("in-process host under load", () => {
	// The two latency-gated NEIGHBOUR cells run FIRST on purpose: the 1,000-session and
	// 50-stream cells below leave gigabytes of garbage in THIS process, and a collector
	// pause during a neighbour probe is not the host stalling that neighbour.
	it(
		"(iv) NEIGHBOUR answers get_state while another session runs a 3 s async tool",
		async () => {
			const host = createLoadHost({ extensions: [slowAsyncTool] });
			try {
				const busy = await openWorker(host, 0);
				const idle = await openWorker(host, 1);
				queueToolTurn(host, "slow_async");
				// The turn - not the `started` acknowledgement - is the window this cell probes inside.
				const turn = settled(host, busy.sessionId);
				expect(
					await host.send({ type: "prompt", sessionId: busy.sessionId, message: "run slow_async" }),
				).toMatchObject({ command: "prompt", success: true });
				const samples = await probeGetState(host, idle.sessionId, turn);
				await turn;
				report(probeLine("(iv) async-tool neighbour", samples));
				// The tool occupies its session for 3 s at a 100 ms cadence: a neighbour that was
				// only answered after the tool settled would show a handful of samples, not ~30.
				expect(samples.latencies.length).toBeGreaterThan(10);
				expect(percentile(samples.latencies, 95)).toBeLessThan(NEIGHBOUR_P95_BUDGET_MS);
			} finally {
				await host.dispose();
			}
		},
		CELL_TIMEOUT_MS,
	);

	it(
		"(iv) NEIGHBOUR records the cost of a synchronous tool and of a 50 MB transcript",
		async () => {
			const blocking = createLoadHost({ extensions: [blockingTool] });
			try {
				const busy = await openWorker(blocking, 0);
				const idle = await openWorker(blocking, 1);
				queueToolTurn(blocking, "slow_sync");
				const turn = settled(blocking, busy.sessionId);
				await blocking.send({ type: "prompt", sessionId: busy.sessionId, message: "run slow_sync" });
				const samples = await probeGetState(blocking, idle.sessionId, turn);
				await turn;
				report(probeLine("(iv) sync-tool CONTRAST", samples));
			} finally {
				await blocking.dispose();
			}

			// A 50 MB transcript is ~12.5 M tokens of live context: a 128k-window model REFUSES
			// to resume it (`cannot resume: target context window ... short of ...`), so the cell
			// that measures the open gives its faux model a window that can hold the file.
			const opening = createLoadHost({ contextWindow: 64_000_000 });
			try {
				const idle = await openWorker(opening, 0);
				const transcript = writeLargeTranscript(opening.scratch, TRANSCRIPT_BYTES);
				const started = performance.now();
				const open = openWorker(opening, 1, transcript);
				const samples = await probeGetState(opening, idle.sessionId, open);
				const megabytes = Math.round(statSync(transcript).size / 1_000_000);
				report(
					probeLine(
						`(iv) ${megabytes}MB-transcript CONTRAST openMs=${round(performance.now() - started)}`,
						samples,
					),
				);
				await open;
			} finally {
				await opening.dispose();
			}
		},
		CELL_TIMEOUT_MS,
	);

	it(
		"(i) SCALE holds 1,000 sessions on one host and reopens closed ones by path",
		async () => {
			const host = createLoadHost();
			try {
				const baseRss = rssMb();
				const baseThreads = threadCount(process.pid);
				const sessions = [];
				// Read after the first open: the runtime's pools warm up once, and the claim is
				// that sessions 2..1000 carry no isolate of their own.
				let warmThreads = baseThreads;
				for (let index = 0; index < SCALE_SESSIONS; index++) {
					const path = index < REOPENED_SESSIONS ? join(host.scratch, `scale-${index}.jsonl`) : undefined;
					sessions.push(await openWorker(host, index, path));
					if (index === 0) warmThreads = threadCount(process.pid);
				}
				const threadGrowth = threadCount(process.pid) - warmThreads;
				report(scaleLine(SCALE_SESSIONS, [baseRss, rssMb()], [baseThreads, threadCount(process.pid)]));
				expect(listedSessions(await host.send({ type: "list_sessions", include_workers: true }))).toHaveLength(
					SCALE_SESSIONS,
				);
				// Worker sessions stay invisible to a default listing no matter how many there are.
				expect(listedSessions(await host.send({ type: "list_sessions" }))).toHaveLength(0);
				expect(threadGrowth).toBeLessThan(MAX_THREADS_PER_SESSION * (SCALE_SESSIONS - 1));

				for (let index = 0; index < REOPENED_SESSIONS; index++) {
					const session = sessions[index];
					if (!session) throw new Error(`No session ${index}`);
					expect(await host.send({ type: "close_session", sessionId: session.sessionId })).toMatchObject({
						success: true,
					});
				}
				expect(listedSessions(await host.send({ type: "list_sessions", include_workers: true }))).toHaveLength(
					SCALE_SESSIONS - REOPENED_SESSIONS,
				);

				const listings: number[] = [];
				for (let index = 0; index < REOPENED_SESSIONS; index++) {
					const session = sessions[index];
					if (!session) throw new Error(`No session ${index}`);
					const reopened = await openWorker(host, index, session.state.sessionFile);
					// Reopen, not attach: the close released the path reservation.
					expect(reopened.attached).toBeUndefined();
					const started = performance.now();
					const listed = listedSessions(await host.send({ type: "list_sessions", include_workers: true }));
					listings.push(performance.now() - started);
					expect(listed).toHaveLength(SCALE_SESSIONS - REOPENED_SESSIONS + index + 1);
				}
				report(latencyLine(`(i) reopened=${REOPENED_SESSIONS} list_sessions`, listings));
				expect(percentile(listings, 95)).toBeLessThan(LIST_P95_BUDGET_MS);
			} finally {
				await host.dispose();
			}
		},
		CELL_TIMEOUT_MS,
	);

	it(
		"(ii) CHURN returns the host to baseline after 2,000 open/close cycles",
		async () => {
			const churn = await runChurnCell(CHURN_CYCLES, CHURN_CONCURRENCY);
			report(churnLine(churn));
			expect(churn.errors).toBe(0);
			expect(churn.sessionsLeft).toBe(0);
			// The importer does not accumulate a generation per session: a leak would leave one
			// per cycle (2,000), and what may legitimately survive the forced collection is the
			// last in-flight batch, so the batch size is the bound. Measured: 0-3.
			expect(churn.importerAfter.generations).toBeLessThan(CHURN_CONCURRENCY);
			// One Bun.plugin registration for the whole run, no matter how many sessions loaded.
			expect(churn.importerAfter.plugins).toBe(churn.importerBefore.plugins);
			expect(churn.threadsAfter).toBeLessThan(churn.threadsBefore + CHURN_CONCURRENCY);
		},
		CHURN_TIMEOUT_MS,
	);

	it(
		"(iii) CONTENTION reports time-to-first-event for 50 concurrent streams",
		async () => {
			const host = createLoadHost();
			try {
				fillResponsePool(host, (BASELINE_STREAMS + CONCURRENT_STREAMS) * 3);
				// Every measured session is prompted for the FIRST time: a session reused across
				// samples would answer the watcher with the tail of its previous turn.
				const sessions = [];
				for (let index = 0; index < BASELINE_STREAMS + CONCURRENT_STREAMS; index++) {
					sessions.push(await openWorker(host, index));
				}
				const baseline: number[] = [];
				for (const session of sessions.slice(0, BASELINE_STREAMS)) {
					const settledTurn = settled(host, session.sessionId);
					baseline.push(await host.timeToFirstEvent(session.sessionId, "baseline"));
					await settledTurn;
				}

				const concurrent = sessions.slice(BASELINE_STREAMS);
				const settling = concurrent.map((session) => settled(host, session.sessionId));
				const streamed = await Promise.all(
					concurrent.map((session) => host.timeToFirstEvent(session.sessionId, "concurrent")),
				);
				await Promise.all(settling);

				report(contentionLine(baseline, streamed));
				// Ratios are REPORTED, never gated: wall-clock latency on a developer machine is
				// not a contract this host controls. What is gated is that every stream produced
				// its first event and the faux pool never ran dry under load.
				expect(streamed).toHaveLength(CONCURRENT_STREAMS);
				expect(host.faux.getPendingResponseCount()).toBeGreaterThan(0);
				// Every session reached the faux PROVIDER. Without this the cell would happily
				// time the host's error path: a model whose api resolves to nothing inside the
				// session's provider scope still emits agent_start, so the ratio above would be
				// measured on turns that never streamed a token.
				expect(host.faux.state.callCount).toBeGreaterThanOrEqual(BASELINE_STREAMS + CONCURRENT_STREAMS);
			} finally {
				await host.dispose();
			}
		},
		CELL_TIMEOUT_MS,
	);

	it(
		"(v) FD/PLUGIN records the cost of 200 worker sessions on the real omo plugin bundle",
		async () => {
			const bundle = resolveOmoPluginExtensions();
			if (bundle.length === 0) {
				report("(v) OMITTED: this machine has no omo plugin bundle installed");
				return;
			}
			const host = createLoadHost({ args: bundle.flatMap((path) => ["--extension", path]) });
			try {
				await measurePluginCell(host, bundle.length, PLUGIN_SESSIONS);
				expect(listedSessions(await host.send({ type: "list_sessions", include_workers: true }))).toHaveLength(
					PLUGIN_SESSIONS,
				);
			} finally {
				await host.dispose();
			}
		},
		CELL_TIMEOUT_MS,
	);

	it(
		"(vi) NODE boots the same host under Node and opens 50 sessions",
		async () => {
			const host = await startWorkerHost(undefined, { socket: true, node: true, sessionRuntime: "cli-default" });
			try {
				const pid = host.child.pid;
				if (pid === undefined) throw new Error("Node host has no pid");
				const client = await host.connect();
				for (let index = 0; index < NODE_SESSIONS; index++) {
					opened(await client.request({ type: "open_session", cwd: host.cwd, kind: "worker" }), index);
				}
				expect(listedSessions(await client.request({ type: "list_sessions", include_workers: true }))).toHaveLength(
					NODE_SESSIONS,
				);
				// The one bun:ffi-gated path on the host loop is the child reaper; under Node it
				// must turn ITSELF off with exactly one warning instead of failing the boot.
				const warnings = host.stderrText().split("child reaper unavailable under Node").length - 1;
				report(nodeLine(NODE_SESSIONS, warnings, zombieCount(pid)));
				expect(warnings).toBe(1);
			} finally {
				await host.dispose();
			}
		},
		CELL_TIMEOUT_MS,
	);
});
