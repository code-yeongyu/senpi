import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai/compat";
import { vi } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import type { InlineExtension } from "../../src/index.ts";
import { createCliRuntimeFactory } from "../../src/main.ts";
import { createHostCore } from "../../src/modes/rpc/multi-session-host.ts";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";

/** One host record as it leaves the writer; only the routing fields are read here. */
export type LoadRecord = Record<string, unknown> & { id?: string; type?: string; sessionId?: string };

/** Command a load cell sends; the rig assigns the correlation id, so callers omit it. */
export type LoadCommand = RpcCommand;

/** Deadline for one awaited record. A load cell that exceeds it has a defect, not a slow machine. */
const RECORD_DEADLINE_MS = 60_000;

/** Flags the daemon path uses for a session that loads nothing from the project. */
const LEAN_ARGS = [
	"--mode",
	"rpc",
	"--multi-session",
	"--no-extensions",
	"--no-skills",
	"--no-context-files",
	"--no-prompt-templates",
	"--no-themes",
] as const;

export interface LoadHostOptions {
	/** CLI flags appended to the lean daemon argv (the plugin cell passes `--extension`). */
	readonly args?: readonly string[];
	/** Inline extensions every session loads, on top of the faux provider registration. */
	readonly extensions?: readonly InlineExtension[];
	/** Context window of the faux model; raised only by the cell that resumes a huge transcript. */
	readonly contextWindow?: number;
}

/** Resident set of this process in megabytes. */
export function rssMb(): number {
	return Math.round(process.memoryUsage.rss() / 1_000_000);
}

/** One measured line of a load cell, tagged so a suite run can be grepped for its numbers. */
export function report(line: string): void {
	process.stderr.write(`[load] ${line}\n`);
}

/** One decimal: every load number is a measurement, never an exact value. */
export function round(value: number): string {
	return value.toFixed(1);
}

/** `before->after` with the per-session share of the growth. */
function growth(pair: readonly [number, number], sessions: number, unit: string): string {
	return `${pair[0]}->${pair[1]}${unit} (${round((pair[1] - pair[0]) / sessions)}${unit}/session)`;
}

/** The SCALE cell's line: what a thousand live sessions cost this process. */
export function scaleLine(
	sessions: number,
	rss: readonly [number, number],
	threads: readonly [number, number],
): string {
	return `(i) sessions=${sessions} errors=0 rss=${growth(rss, sessions, "MB")} threads=${growth(threads, sessions, "")}`;
}

/** The distribution of a latency sample set, the shape every reported cell ends with. */
export function latencyLine(label: string, samples: readonly number[]): string {
	return (
		`${label} n=${samples.length} p50=${round(percentile(samples, 50))}ms ` +
		`p95=${round(percentile(samples, 95))}ms max=${round(percentile(samples, 100))}ms`
	);
}

/** The CONTENTION cell's line: both distributions and the ratio between them. */
export function contentionLine(single: readonly number[], concurrent: readonly number[]): string {
	const ratio = (rank: number) => round(percentile(concurrent, rank) / percentile(single, rank));
	return (
		`(iii) ${latencyLine("single", single)} | ${latencyLine(`concurrent${concurrent.length}`, concurrent)} | ` +
		`ratio p50=${ratio(50)}x p95=${ratio(95)}x`
	);
}

/** The NODE cell's line, read off the live host process. */
export function nodeLine(sessions: number, warnings: number, zombies: number): string {
	return `(vi) runtime=node sessions=${sessions} reaperWarnings=${warnings} zombies=${zombies}`;
}

/** Sample at the requested percentile (nearest-rank), the shape every load cell reports. */
export function percentile(samples: readonly number[], rank: number): number {
	if (samples.length === 0) return Number.NaN;
	const sorted = [...samples].sort((left, right) => left - right);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1));
	return sorted[index] ?? Number.NaN;
}

/** Open file descriptors of one process (`lsof -p <pid> | wc -l`, header row removed). */
export function openDescriptorCount(pid: number): number {
	return (
		execFileSync("lsof", ["-p", String(pid)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
			.trim()
			.split("\n").length - 1
	);
}

/** Soft `RLIMIT_NOFILE` of this process, as the kernel reports it to the shell. */
export function softFileLimit(): string {
	return execFileSync("/bin/sh", ["-c", "ulimit -Sn"], { encoding: "utf8" }).trim();
}

/**
 * One in-process multi-session host: the production `createHostCore` seam with no
 * `workerConfiguration`, i.e. the `RpcSessionRegistry` a `--listen` host selects, the
 * real session binding (so every command runs the connection handler), and the real
 * `createCliRuntimeFactory` runtime. The only fake is the model: a faux provider is
 * registered into every session's scope, so no cell can reach a real provider.
 */
export function createLoadHost(options: LoadHostOptions = {}) {
	const scratch = mkdtempSync(join(tmpdir(), "senpi-load-"));
	const cwd = join(scratch, "cwd");
	const agentDir = join(scratch, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	// The developer shell that runs this suite points these at the LIVE desktop-managed
	// agent dir; a load cell must never resolve one of its sessions against it.
	vi.stubEnv("SENPI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("OMO_CODING_AGENT_DIR", agentDir);
	for (const socketVar of ["OMO_RPC_SOCKET_PATH", "OMO_RPC_SOCKET", "SENPI_RPC_SOCKET", "PI_RPC_SOCKET"]) {
		vi.stubEnv(socketVar, undefined);
	}

	// A NATIVE faux provider, not the module-global faux registry: every session runs
	// inside its own `ProviderScope`, and a scoped lookup consults the scope overlay and
	// the builtins only (`api-registry.ts` getApiProvider). Registering the provider from
	// inside the session's own extension load is what puts the stream implementation where
	// that session will look for it.
	const faux = fauxProvider({
		models: [{ id: "faux-1", reasoning: false, contextWindow: options.contextWindow ?? 128_000 }],
	});
	const model = faux.getModel();
	const registerFauxModels: InlineExtension = (pi) => {
		pi.registerProvider(faux.provider);
	};
	const parsed = parseArgs([...LEAN_ARGS, ...(options.args ?? [])]);
	const pending = new Map<string, (record: LoadRecord) => void>();
	const watchers = new Set<{ sessionId: string; accept: (record: LoadRecord) => void }>();
	const writer = new SessionEventWriter((chunk) => {
		for (const line of chunk.split("\n")) {
			if (!line) continue;
			const record = JSON.parse(line) as LoadRecord;
			if (typeof record.id === "string") pending.get(record.id)?.(record);
			if (typeof record.sessionId !== "string" || record.type === "response") continue;
			for (const watcher of [...watchers]) if (watcher.sessionId === record.sessionId) watcher.accept(record);
		}
	});
	const { router } = createHostCore(
		{
			agentDir,
			cwd,
			// Load cells measure throughput, never an approval dialog: a tool call that
			// stopped for permission would read as latency the host did not cause.
			permissionPreset: "full-access",
			createRuntime: createCliRuntimeFactory(
				{ parsed, cwd, agentDir, appMode: "rpc" },
				{ extensionFactories: [registerFauxModels, ...(options.extensions ?? [])] },
			),
			creationModel: { provider: model.provider, modelId: model.id },
		},
		writer,
		[],
	);

	let serial = 0;
	/**
	 * Sends one command through the host's own dispatch and resolves with its response.
	 *
	 * Control commands answer from `router.handle`; a session command answers through
	 * the writer once the binding is DONE with it - `prompt` only after its turn has
	 * settled - so a load cell that wants the turn's window awaits this promise.
	 */
	const send = async (command: LoadCommand): Promise<LoadRecord> => {
		const id = `load-${++serial}`;
		let settle!: (record: LoadRecord) => void;
		let fail!: (cause: Error) => void;
		const answered = new Promise<LoadRecord>((resolve, reject) => {
			settle = resolve;
			fail = reject;
		});
		const timer = setTimeout(
			() => fail(new Error(`No response for ${command.type} (${id}) within ${RECORD_DEADLINE_MS}ms`)),
			RECORD_DEADLINE_MS,
		);
		pending.set(id, (record) => {
			clearTimeout(timer);
			pending.delete(id);
			settle(record);
		});
		const immediate = (await router.handle({ ...command, id })) as LoadRecord | undefined;
		if (immediate) pending.get(id)?.(immediate);
		await writer.flush();
		return answered;
	};
	/** Resolves with the first record this session emits that satisfies the predicate. */
	const nextRecord = (sessionId: string, accepts: (record: LoadRecord) => boolean): Promise<LoadRecord> =>
		new Promise((resolve, reject) => {
			const watcher = {
				sessionId,
				accept: (record: LoadRecord) => {
					if (!accepts(record)) return;
					clearTimeout(timer);
					watchers.delete(watcher);
					resolve(record);
				},
			};
			const timer = setTimeout(() => {
				watchers.delete(watcher);
				reject(new Error(`No matching record from ${sessionId} within ${RECORD_DEADLINE_MS}ms`));
			}, RECORD_DEADLINE_MS);
			watchers.add(watcher);
		});

	return {
		cwd,
		agentDir,
		scratch,
		faux,
		router,
		send,
		nextRecord,
		/** Every record this session emits, until the returned unsubscribe is called. */
		watch(sessionId: string, accept: (record: LoadRecord) => void): () => void {
			const watcher = { sessionId, accept };
			watchers.add(watcher);
			return () => watchers.delete(watcher);
		},
		/** Milliseconds from issuing a prompt to the session's first streamed record. */
		async timeToFirstEvent(sessionId: string, message: string): Promise<number> {
			const started = performance.now();
			const first = nextRecord(sessionId, () => true).then(() => performance.now() - started);
			await send({ type: "prompt", sessionId, message });
			return first;
		},
		async dispose(): Promise<void> {
			await router.dispose();
			rmSync(scratch, { recursive: true, force: true });
		},
	};
}

export type LoadHost = ReturnType<typeof createLoadHost>;
