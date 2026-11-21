import { closeSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join, win32 } from "node:path";
import { debuglog } from "node:util";
import { APP_COMMAND } from "../../../../config.ts";
import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "../../types.ts";
import {
	isTerminalMonitorStateEvent,
	isWakeSourceStateEvent,
	TERMINAL_MONITOR_STATE_EVENT,
	WAKE_SOURCE_STATE_EVENT,
} from "../monitor-state-event.ts";
import { HerdrClient, type HerdrMethod } from "./herdr-client.ts";
import {
	type HerdrTurnOutcome,
	initialHerdrState,
	isHerdrBlockedEvent,
	openEndedMonitors,
	reduceHerdrState,
	selectHerdrReport,
	selectProgramStatus,
} from "./herdr-state.ts";

/**
 * Herdr keys prompt delivery and session restore on agent labels it knows, so the protocol agent stays `pi`.
 * The product command (`omo`, `senpi`, `pi`) travels in this display-only pane token instead (omo#12395).
 */
const APP_TOKEN = "app";

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
		let poll: ReturnType<typeof setInterval> | undefined;
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
		function reportProgramStatus(): void {
			const status = selectProgramStatus(state);
			const key = JSON.stringify(status);
			if (lastProgramStatus === key) return;
			lastProgramStatus = key;
			// An outside SDK host's UI context may predate setProgramStatus (senpi#5344); the herdr socket must not depend on it.
			boundCtx?.ui.setProgramStatus?.(status);
		}
		async function publish(): Promise<void> {
			if (!bound || stopped) return;
			const report = selectHerdrReport(state);
			reportProgramStatus();
			if (!client) return;
			const key = JSON.stringify(report);
			if (lastReport === key) return;
			lastReport = key;
			if (!(await send("pane.report_agent", { agent: "pi", ...report, ...sessionRef() })) && lastReport === key) {
				lastReport = undefined;
			}
		}
		async function reportTitle(ctx: ExtensionContext): Promise<void> {
			const next = ctx.sessionManager.getSessionName() ?? "";
			if (title === next) return;
			title = next;
			const params = { title: next, display_agent: next, tokens: { [APP_TOKEN]: APP_COMMAND } };
			if (!(await send("pane.report_metadata", params)) && title === next) title = undefined;
		}
		function refreshChildren(ctx: ExtensionContext): void {
			state = reduceHerdrState(state, { type: "children", count: countRunningChildTasks(ctx, debug) });
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
			state = reduceHerdrState(state, { type: "turn", active: !ctx.isIdle() });
			refreshChildren(ctx);
			subscriptions.push(
				pi.events.on("herdr:blocked", (data) => {
					if (stopped || !isHerdrBlockedEvent(data)) return;
					state = reduceHerdrState(state, { type: "blocked", ...data });
					return publish();
				}),
			);
			subscriptions.push(
				pi.events.on(TERMINAL_MONITOR_STATE_EVENT, (data) => {
					if (stopped || !isTerminalMonitorStateEvent(data)) return;
					state = reduceHerdrState(state, {
						type: "monitors",
						count: data.activeCount,
						openEnded: openEndedMonitors(data),
					});
					return publish();
				}),
			);
			subscriptions.push(
				pi.events.on(WAKE_SOURCE_STATE_EVENT, (data) => {
					if (stopped || !isWakeSourceStateEvent(data)) return;
					state = reduceHerdrState(state, { type: "wake-source", source: data.source, count: data.activeCount });
					return publish();
				}),
			);
			poll = setInterval(() => {
				refreshChildren(ctx);
				void publish();
			}, 4000);
			poll.unref();
			if (!client) return publish();
			// Herdr accepts a resume command only after this reporter holds the pane.
			await Promise.all([reportTitle(ctx), publish()]);
			await send("pane.report_agent_session", {
				agent: "pi",
				...sessionRef(),
				resume_argv: [APP_COMMAND, "--session", bound.getSessionFile() ?? bound.getSessionId()],
				session_start_source: _event.reason,
			});
		});
		pi.on("session_info_changed", (_event, ctx) => {
			if (owns(ctx)) return reportTitle(ctx);
		});
		pi.on("agent_start", (_event, ctx) => {
			if (!owns(ctx)) return;
			state = reduceHerdrState(state, { type: "turn", active: true });
			return publish();
		});
		pi.on("agent_end", (event, ctx) => {
			if (!owns(ctx)) return;
			state = reduceHerdrState(state, { type: "outcome", outcome: classifyTurnOutcome(event) });
		});
		pi.on("session_abort", (_event, ctx) => {
			if (!owns(ctx)) return;
			state = reduceHerdrState(state, { type: "outcome", outcome: { kind: "idle" } });
			return publish();
		});
		pi.on("agent_settled", (event, ctx) => {
			if (!owns(ctx)) return;
			if (event.fallbackExhausted !== undefined && state.turnOutcome.kind !== "error") {
				state = reduceHerdrState(state, {
					type: "outcome",
					outcome: { kind: "error", message: "All fallback providers exhausted" },
				});
			}
			state = reduceHerdrState(state, { type: "turn", active: !ctx.isIdle() });
			refreshChildren(ctx);
			return publish();
		});
		pi.on("session_shutdown", async (event, ctx) => {
			if (!owns(ctx)) return;
			stopped = true;
			if (poll) clearInterval(poll);
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

function findLastAssistantMessage(
	messages: AgentEndEvent["messages"] | undefined,
): { stopReason?: string; errorMessage?: string } | undefined {
	if (!Array.isArray(messages)) return undefined;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message !== undefined && "role" in message && message.role === "assistant") {
			return {
				stopReason:
					"stopReason" in message && typeof message.stopReason === "string" ? message.stopReason : undefined,
				errorMessage:
					"errorMessage" in message && typeof message.errorMessage === "string" ? message.errorMessage : undefined,
			};
		}
	}
	return undefined;
}

function classifyTurnOutcome(event: AgentEndEvent): HerdrTurnOutcome {
	if (event.willRetry) return { kind: "idle" };
	if (event.aborted && event.abortSource === "user") return { kind: "idle" };
	if (event.deadline !== undefined) {
		return {
			kind: "error",
			message: event.deadline.kind === "inactivity" ? "Turn timed out (inactivity)" : "Turn timed out (max runtime)",
		};
	}
	const lastAssistant = findLastAssistantMessage(event.messages);
	if (lastAssistant?.stopReason === "error") {
		const message = lastAssistant.errorMessage?.trim();
		return message ? { kind: "error", message } : { kind: "error" };
	}
	if (event.aborted) {
		if (event.abortSource === "provider" || event.abortSource === "system") {
			const message = lastAssistant?.errorMessage?.trim();
			return {
				kind: "error",
				message: message || (event.abortSource === "provider" ? "Provider aborted turn" : "Turn aborted"),
			};
		}
		return { kind: "idle" };
	}
	return { kind: "done" };
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

function countRunningChildTasks(ctx: ExtensionContext, debug: (message: string) => void): number {
	const directory = join(ctx.cwd, ".omo", "senpi-task", "tasks");
	let entries: string[];
	try {
		entries = readdirSync(directory);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
			debug("Herdr child-task directory unavailable");
		return 0;
	}
	let count = 0;
	for (const file of entries) {
		if (!file.endsWith(".json")) continue;
		try {
			const record: unknown = JSON.parse(readFileSync(join(directory, file), "utf8"));
			if (
				typeof record !== "object" ||
				record === null ||
				!("status" in record) ||
				(record.status !== "running" && record.status !== "pending")
			)
				continue;
			const sessionId = ctx.sessionManager.getSessionId();
			if (
				("root_session_id" in record && record.root_session_id === sessionId) ||
				("parent_session_id" in record && record.parent_session_id === sessionId)
			)
				count++;
		} catch {
			// Task records are an external, concurrently-written boundary. Retry on the next poll.
			debug("Herdr ignored an unreadable or partial child-task record");
		}
	}
	return count;
}
