import { closeSync, openSync, readSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { win32 } from "node:path";
import { debuglog } from "node:util";
import { APP_COMMAND } from "../../../../config.ts";
import type { ExtensionAPI, ExtensionContext, ProgramStatus } from "../../types.ts";
import { connectSessionLiveness } from "../session-liveness/connect.ts";
import { initialHerdrState, selectHerdrBlockedKind, selectHerdrReport } from "../session-liveness/state.ts";
import { HerdrClient, type HerdrMethod } from "./herdr-client.ts";

/**
 * Herdr keys prompt delivery and session restore on agent labels it knows, so the protocol agent stays `pi`.
 * The product command (`omo`, `senpi`, `pi`) travels in this display-only pane token instead (omo#12395).
 */
const APP_TOKEN = "app";

/**
 * Herdr drops a reported resume command whenever its process probe names another agent in the pane. That happens
 * when herdr cannot read this process's `HERDR_AGENT` hint (it skips processes in uninterruptible sleep) and finds
 * a provider's `claude` child by name. An unchanged re-report is a no-op for herdr and restores a dropped command.
 */
const RESUME_REASSERT_MS = 5000;

export interface HerdrDependencies {
	getLoadedExtensionPaths: (ctx: ExtensionContext) => readonly string[];
	readHeader: (path: string) => string;
	now: () => number;
	connect: (path: string) => Socket;
	debug?: (message: string) => void;
}

export default function herdrExtension(pi: ExtensionAPI): void {
	createHerdrExtension({
		getLoadedExtensionPaths: (ctx) => ctx.loadedExtensionPaths ?? [],
		readHeader: (path) => {
			const file = openSync(path, "r");
			try {
				const header = Buffer.alloc(400);
				const length = readSync(file, header, 0, header.length, 0);
				return header.toString("utf8", 0, length);
			} finally {
				closeSync(file);
			}
		},
		now: Date.now,
		connect: createConnection,
	})(pi);
}

/** Read host-owned discovery state only after all extensions have loaded. */
export function createHerdrExtension(deps: HerdrDependencies) {
	return (pi: Pick<ExtensionAPI, "on" | "events">): void => {
		const debug = deps.debug ?? debuglog("senpi:herdr");
		let client: HerdrClient | undefined;
		let bound: ExtensionContext["sessionManager"] | undefined;
		let boundCtx: ExtensionContext | undefined;
		let lastProgramStatus: string | undefined;
		let state = initialHerdrState();
		let stopped = false;
		let deferred = false;
		let lastReport: string | undefined;
		let title: string | undefined;
		let resumeTimer: ReturnType<typeof setInterval> | undefined;
		const subscriptions: Array<() => void> = [];
		const pending = new Set<Promise<boolean>>();
		const owns = (ctx: ExtensionContext) => !stopped && bound === ctx.sessionManager;
		const sessionRef = () => {
			const path = bound?.getSessionFile();
			return path ? { agent_session_path: path } : { agent_session_id: bound?.getSessionId() };
		};
		function send(method: HerdrMethod, params: Record<string, unknown>): Promise<boolean> {
			if (!client) return Promise.resolve(false);
			const work = client.send(method, params).then(
				() => true,
				(error: unknown) => {
					debug(error instanceof Error ? error.message : "Herdr transport failed");
					return false;
				},
			);
			pending.add(work);
			void work.then(() => pending.delete(work));
			return work;
		}
		function reportProgramStatus(report: ReturnType<typeof selectHerdrReport>): void {
			const kind = report.state === "blocked" ? selectHerdrBlockedKind(state) : undefined;
			const status: ProgramStatus = {
				state: report.state,
				...(kind === undefined ? {} : { kind }),
				...(report.message === undefined ? {} : { message: report.message }),
			};
			const key = JSON.stringify(status);
			if (lastProgramStatus === key) return;
			lastProgramStatus = key;
			// An outside SDK host's UI context may predate setProgramStatus (senpi#5344); the herdr socket must not depend on it.
			boundCtx?.ui.setProgramStatus?.(status);
		}
		async function publish(): Promise<void> {
			if (!bound || stopped) return;
			const report = selectHerdrReport(state);
			reportProgramStatus(report);
			if (!client) return;
			const key = JSON.stringify(report);
			if (lastReport === key) return;
			lastReport = key;
			if (!(await send("pane.report_agent", { agent: "pi", ...report, ...sessionRef() })) && lastReport === key) {
				lastReport = undefined;
			}
		}
		function reportResume(sessionStartSource?: string): Promise<boolean> {
			if (!bound || stopped) return Promise.resolve(false);
			return send("pane.report_agent_session", {
				agent: "pi",
				...sessionRef(),
				resume_argv: [APP_COMMAND, "--session", bound.getSessionFile() ?? bound.getSessionId()],
				session_start_source: sessionStartSource,
			});
		}
		async function reportTitle(ctx: ExtensionContext): Promise<void> {
			const next = ctx.sessionManager.getSessionName() ?? "";
			if (title === next) return;
			title = next;
			const params = { title: next, display_agent: next, tokens: { [APP_TOKEN]: APP_COMMAND } };
			if (!(await send("pane.report_metadata", params)) && title === next) title = undefined;
		}

		pi.on("session_start", async (_event, ctx) => {
			if (stopped || bound || ctx.mode !== "tui") return;
			// Program status (OSC 7501) reaches any terminal that reads it, such as herdr-core panes that set no
			// HERDR_* variables (senpi#5321); the herdr socket client below keeps its own preconditions.
			bound = ctx.sessionManager;
			boundCtx = ctx;
			const socketPath = process.env.HERDR_SOCKET_PATH;
			const paneId = process.env.HERDR_PANE_ID;
			if (!deferred && process.env.HERDR_ENV === "1" && socketPath && paneId) {
				if (hasUserReporter(deps, ctx, debug)) {
					deferred = true;
					debug("Herdr builtin deferred to a loaded user reporter");
				} else client = new HerdrClient(socketPath, paneId, deps);
			}
			// The session's one liveness fold (turn, blocks, monitors, wake sources, child records) is shared with the
			// todo widget; this reporter only publishes it (senpi#1146).
			const liveness = connectSessionLiveness(pi.events);
			if (liveness) {
				subscriptions.push(
					liveness.subscribe((next) => {
						if (stopped) return;
						state = next;
						return publish();
					}),
				);
				state = liveness.state();
			}
			if (!client) return publish();
			// Herdr accepts a resume command only after this reporter holds the pane.
			await Promise.all([reportTitle(ctx), publish()]);
			await reportResume(_event.reason);
			if (stopped) return;
			resumeTimer = setInterval(() => void reportResume(), RESUME_REASSERT_MS);
			resumeTimer.unref();
		});
		pi.on("session_info_changed", (_event, ctx) => {
			if (owns(ctx)) return reportTitle(ctx);
		});
		pi.on("session_shutdown", async (event, ctx) => {
			if (!owns(ctx)) return;
			stopped = true;
			clearInterval(resumeTimer);
			for (const unsubscribe of subscriptions) unsubscribe();
			if (event.reason === "quit") ctx.ui.setProgramStatus?.(undefined);
			// Drain before the host builds the successor runtime, or releases the pane.
			await Promise.all(pending);
			if (event.reason !== "quit") return;
			// Herdr keeps pane tokens after release and after the process exits, so the brand is cleared explicitly.
			await send("pane.report_metadata", { tokens: { [APP_TOKEN]: null } });
			await send("pane.release_agent", { agent: "pi" });
		});
	};
}

function hasUserReporter(deps: HerdrDependencies, ctx: ExtensionContext, debug: (message: string) => void): boolean {
	return deps.getLoadedExtensionPaths(ctx).some((path) => {
		if (!/^herdr-.*\.(ts|js|mjs)$/.test(win32.basename(path))) return false;
		try {
			return !Buffer.from(deps.readHeader(path)).subarray(0, 400).includes("HERDR_INTEGRATION_ID=");
		} catch {
			// An unreadable loaded reporter cannot safely be classified as managed.
			debug("Herdr reporter header unavailable; treating it as user-authored");
			return true;
		}
	});
}
