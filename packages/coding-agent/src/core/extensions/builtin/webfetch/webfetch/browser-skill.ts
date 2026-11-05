import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * Reads a page through the browser the user already has connected to BrowserSkill (Tencent's `bsk`
 * daemon plus its extension), the integration OmOWright's `connectBrowserSkill` drives. webfetch never
 * launches a browser and never starts the daemon: when the integration is not connected and in use,
 * the caller keeps its static result and reports a typed skip (senpi#5939, senpi#5940; design in
 * senpi#5940 issuecomment-6651347167).
 *
 * Two session modes: `incognito` renders a page the user did not list in an incognito Agent Window,
 * so none of the profile's cookies are sent; `signed-in` renders a listed host in a normal window
 * with the user's session. Wire shapes follow `crates/bsk-protocol` (JSON Lines over the daemon's
 * Unix socket or Windows named pipe).
 */

export interface RenderedPage {
	readonly url: string;
	readonly html: string;
	readonly truncated: boolean;
}

export type BrowserMode = "incognito" | "signed-in";

export interface ConnectedBrowser {
	readonly instanceId: string;
	readonly browserName: string;
	readonly label: string;
}

export interface PageRenderOptions {
	readonly mode: BrowserMode;
	readonly timeoutMs: number;
	readonly signal?: AbortSignal;
	readonly browser?: string;
}

export interface PageRenderer {
	readonly name: string;
	render(
		url: string,
		options: PageRenderOptions,
	): Promise<{ readonly page: RenderedPage; readonly browser: ConnectedBrowser }>;
}

export type WebfetchBrowserSkipReason =
	| "disabled"
	| "no_time_left"
	| "integration_not_connected"
	| "incognito_unsupported"
	| "incognito_unavailable"
	| "timeout"
	| "render_failed"
	| "no_more_text"
	| "host_not_allowed";

export type WebfetchNotConnectedCause =
	| "no_daemon"
	| "daemon_unreachable"
	| "incompatible"
	| "no_browser"
	| "browser_unresponsive"
	| "pinned_browser_missing";

export interface WebfetchBrowserSkip {
	readonly reason: WebfetchBrowserSkipReason;
	readonly cause?: WebfetchNotConnectedCause;
	readonly message: string;
	readonly detail?: string;
}

export const NOT_CONNECTED_MESSAGE = "browser integration not connected; render skipped";

export class BrowserSkillError extends Error {
	override readonly name = "BrowserSkillError";
	readonly skip: WebfetchBrowserSkip;

	constructor(skip: WebfetchBrowserSkip) {
		super(skip.detail === undefined ? skip.message : `${skip.message} (${skip.detail})`);
		this.skip = skip;
	}
}

function notConnected(cause: WebfetchNotConnectedCause, detail: string): BrowserSkillError {
	return new BrowserSkillError({ reason: "integration_not_connected", cause, message: NOT_CONNECTED_MESSAGE, detail });
}

function skip(
	reason: Exclude<WebfetchBrowserSkipReason, "integration_not_connected">,
	message: string,
	detail?: string,
) {
	return new BrowserSkillError({ reason, message, ...(detail === undefined ? {} : { detail }) });
}

export interface BrowserSkillOptions {
	readonly home?: string;
	readonly settlePollMs?: number;
	readonly statusTimeoutMs?: number;
	/** The uid that must own the daemon socket; defaults to this process's uid. Tests inject a mismatch. */
	readonly ownerUid?: number;
	readonly maxSessions?: number;
	readonly platform?: NodeJS.Platform;
}

const SETTLE_POLL_MS = 250;
// The page counts as rendered once two reads in a row return the same HTML length.
const SETTLED_READS = 2;
const STATUS_TIMEOUT_MS = 2_000;
const STOP_TIMEOUT_MS = 5_000;
const CANCEL_TIMEOUT_MS = 2_000;
// navigate leaves this much of the budget for the HTML reads that follow it.
const GET_HTML_RESERVE_MS = 1_500;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_SESSIONS = 2;
// A page whose URL changes across this many reads in a row is still navigating and is refused.
const MAX_UNSTEADY_READS = 8;
// A page whose HTML never settles (live counters, carousels) is read at most this many times; the last
// steady read is returned instead of spending the whole request timeout and losing it to a late failure.
const MAX_SETTLE_READS = 12;
// How long a failed session.start is given to still answer, so a session the daemon created is stopped.
const LATE_SESSION_WAIT_MS = 1_500;
const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";

export function browserSkillHome(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.BSK_HOME;
	return override ? override : join(env.HOME || homedir(), ".bsk");
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: undefined;
}

/** The daemon's socket as named in its own daemon.json, refused unless it is a socket this user owns (or a named pipe). */
export function resolveDaemonSocket(
	home: string,
	options: Pick<BrowserSkillOptions, "ownerUid" | "platform"> = {},
): string {
	let info: unknown;
	try {
		info = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8"));
	} catch {
		throw notConnected("no_daemon", "no readable daemon.json");
	}
	const sockPath = record(info)?.sock_path;
	if (typeof sockPath !== "string" || sockPath.length === 0)
		throw notConnected("no_daemon", "daemon.json names no socket");
	if ((options.platform ?? process.platform) === "win32") {
		if (!sockPath.startsWith(WINDOWS_PIPE_PREFIX))
			throw notConnected("no_daemon", "daemon.json socket is not a named pipe");
		return sockPath;
	}
	if (!isAbsolute(sockPath)) throw notConnected("no_daemon", "daemon.json socket path is not absolute");
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(sockPath);
	} catch {
		throw notConnected("daemon_unreachable", "the daemon socket does not exist");
	}
	if (!stat.isSocket()) throw notConnected("no_daemon", "daemon.json socket path is not a socket");
	const expectedUid = options.ownerUid ?? process.getuid?.();
	if (expectedUid !== undefined && stat.uid !== expectedUid) {
		throw notConnected("no_daemon", "the daemon socket belongs to another user");
	}
	return sockPath;
}

interface DaemonReply {
	readonly id: unknown;
	readonly result?: unknown;
	readonly error?: Readonly<Record<string, unknown>>;
}

interface DaemonCall {
	readonly id: string;
	readonly reply: Promise<DaemonReply>;
	abort(): void;
}

class DaemonTimeout extends Error {
	override readonly name = "DaemonTimeout";
}

class DaemonUnreachable extends Error {
	override readonly name = "DaemonUnreachable";
}

function callDaemon(sockPath: string, method: string, params: Record<string, unknown>, timeoutMs: number): DaemonCall {
	const id = `webfetch-${method.replace(/[^a-z0-9]+/giu, "-")}-${randomBytes(4).toString("hex")}`;
	let abort = (): void => {};
	const reply = new Promise<DaemonReply>((resolve, reject) => {
		const socket = connect(sockPath);
		let buffer = "";
		let settled = false;
		const finish = (settle: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			settle();
		};
		const timer = setTimeout(
			() => finish(() => reject(new DaemonTimeout(`${method} did not answer within ${timeoutMs}ms`))),
			Math.max(1, timeoutMs),
		);
		abort = () => finish(() => reject(new DaemonTimeout(`${method} was abandoned`)));
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
		socket.on("error", (error: NodeJS.ErrnoException) =>
			finish(() => reject(new DaemonUnreachable(error.code ?? error.message))),
		);
		socket.on("close", () =>
			finish(() => reject(new DaemonUnreachable(`${method}: connection closed without a reply`))),
		);
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			finish(() => {
				let parsed: unknown;
				try {
					parsed = JSON.parse(buffer.slice(0, newline));
				} catch {
					reject(new DaemonUnreachable(`${method}: reply is not JSON`));
					return;
				}
				const frame = record(parsed);
				const error = record(frame?.error);
				resolve({ id: frame?.id, result: frame?.result, ...(error ? { error } : {}) });
			});
		});
	});
	return { id, reply, abort: () => abort() };
}

function protocolParts(version: unknown): [number, number] | undefined {
	if (typeof version !== "string") return undefined;
	const match = /^(\d+)\.(\d+)/u.exec(version);
	return match ? [Number(match[1]), Number(match[2])] : undefined;
}

function supportsIncognito(version: unknown): boolean {
	const parts = protocolParts(version);
	return parts !== undefined && parts[0] === 1 && parts[1] >= 4;
}

interface EligibleBrowser extends ConnectedBrowser {
	readonly protocol: unknown;
}

function pickBrowser(
	browsers: readonly Readonly<Record<string, unknown>>[],
	preferred: string | undefined,
): EligibleBrowser {
	if (browsers.length === 0) throw notConnected("no_browser", "no browser is connected to the daemon");
	const eligible = browsers.filter(
		(browser) => browser.unresponsive !== true && typeof browser.instance_id === "string",
	);
	if (eligible.length === 0) throw notConnected("browser_unresponsive", "every connected browser stopped answering");
	const pinned =
		preferred === undefined
			? undefined
			: eligible.find((browser) => browser.instance_id === preferred || browser.label === preferred);
	// A pinned browser is the user's choice of signed-in profile; reading through another one would use a
	// session they did not pick, so a pin that matches nothing refuses the read instead of falling back.
	if (preferred !== undefined && pinned === undefined) {
		throw notConnected("pinned_browser_missing", `no connected browser matches the pinned browser "${preferred}"`);
	}
	const chosen =
		pinned ??
		eligible.reduce((best, browser) =>
			Number(browser.connected_at_ms ?? 0) > Number(best.connected_at_ms ?? 0) ? browser : best,
		);
	return {
		instanceId: String(chosen.instance_id),
		browserName: typeof chosen.browser_name === "string" ? chosen.browser_name : "",
		label: typeof chosen.label === "string" ? chosen.label : "",
		protocol: chosen.extension_protocol_version,
	};
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

class Semaphore {
	#free: number;
	readonly #waiters: Array<() => void> = [];

	constructor(size: number) {
		this.#free = size;
	}

	async acquire(deadline: number, signal?: AbortSignal): Promise<boolean> {
		if (this.#free > 0) {
			this.#free--;
			return true;
		}
		return await new Promise<boolean>((resolve) => {
			const give = (): void => {
				const index = this.#waiters.indexOf(grant);
				if (index !== -1) this.#waiters.splice(index, 1);
				clearTimeout(timer);
				signal?.removeEventListener("abort", give);
				resolve(false);
			};
			const timer = setTimeout(give, Math.max(0, deadline - Date.now()));
			signal?.addEventListener("abort", give, { once: true });
			const grant = (): void => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", give);
				resolve(true);
			};
			this.#waiters.push(grant);
		});
	}

	release(): void {
		const next = this.#waiters.shift();
		if (next) next();
		else this.#free++;
	}
}

export function createBrowserSkillRenderer(options: BrowserSkillOptions = {}): PageRenderer {
	const settlePollMs = options.settlePollMs ?? SETTLE_POLL_MS;
	const statusTimeoutMs = options.statusTimeoutMs ?? STATUS_TIMEOUT_MS;
	const sessions = new Semaphore(options.maxSessions ?? MAX_SESSIONS);
	return {
		name: "your connected browser (BrowserSkill)",
		async render(url, { mode, timeoutMs, signal, browser: preferred }) {
			let controllerName = "";
			signal?.throwIfAborted();
			const deadline = Date.now() + timeoutMs;
			const left = (): number => deadline - Date.now();
			const sockPath = resolveDaemonSocket(options.home ?? browserSkillHome(), options);

			const statusCall = callDaemon(sockPath, "system.status", {}, Math.min(statusTimeoutMs, Math.max(1, left())));
			let statusReply: DaemonReply;
			try {
				statusReply = await statusCall.reply;
			} catch (error) {
				throw notConnected("daemon_unreachable", error instanceof Error ? error.message : String(error));
			}
			if (statusReply.id !== statusCall.id) throw notConnected("incompatible", "status reply id does not match");
			const status = record(statusReply.result);
			if (!status) throw notConnected("incompatible", "status reply carries no result object");
			if (protocolParts(status.protocol_version)?.[0] !== 1) {
				throw notConnected("incompatible", `daemon protocol ${String(status.protocol_version)} is not 1.x`);
			}
			const browsers = Array.isArray(status.browsers)
				? status.browsers.flatMap((entry) => {
						const browser = record(entry);
						return browser ? [browser] : [];
					})
				: [];
			const chosen = pickBrowser(browsers, preferred);
			if (mode === "incognito" && !supportsIncognito(chosen.protocol)) {
				throw skip(
					"incognito_unsupported",
					"the connected browser's extension cannot open an incognito window",
					`extension protocol ${String(chosen.protocol)}`,
				);
			}

			if (!(await sessions.acquire(deadline, signal))) {
				signal?.throwIfAborted();
				throw skip("no_time_left", "no browser session slot was free within the request timeout");
			}
			let sessionId: string | undefined;
			let startCall: DaemonCall | undefined;
			let startAnswered = false;
			let pending: DaemonCall | undefined;
			const onAbort = (): void => pending?.abort();
			signal?.addEventListener("abort", onAbort, { once: true });
			const settleCall = async (
				method: string,
				handle: DaemonCall,
				reply: Promise<DaemonReply>,
			): Promise<unknown> => {
				let answered: DaemonReply;
				try {
					answered = await reply;
				} catch (error) {
					signal?.throwIfAborted();
					if (error instanceof DaemonTimeout) {
						const cancel = callDaemon(sockPath, "cancel", { rpc_id: handle.id }, CANCEL_TIMEOUT_MS);
						await cancel.reply.catch(() => undefined);
					}
					throw error;
				} finally {
					pending = undefined;
				}
				if (answered.error) throw daemonError(method, mode, answered.error);
				return answered.result;
			};
			const call = async (method: string, params: Record<string, unknown>, budgetMs = left()): Promise<unknown> => {
				signal?.throwIfAborted();
				if (budgetMs <= 0) throw new DaemonTimeout(`no time left for ${method}`);
				const handle = callDaemon(sockPath, method, params, budgetMs);
				pending = handle;
				return await settleCall(method, handle, handle.reply);
			};
			try {
				// A unique controller name per render, so a session the daemon created after this call was
				// abandoned can be found in system.status and stopped instead of leaving a window open.
				controllerName = `senpi webfetch ${randomBytes(4).toString("hex")}`;
				const startParams = {
					task_name: "webfetch",
					controller: { name: controllerName },
					browser_instance_id: chosen.instanceId,
					incognito: mode === "incognito",
					focused: false,
				};
				// The daemon can still create the session after we stop waiting for the reply (abort or our own
				// timeout), and that session owns a window in the user's browser. The reply is kept so the finally
				// block can stop whatever id arrives, even though this call has already failed.
				// An abort that landed during system.status or the slot wait must not open a window at all.
				signal?.throwIfAborted();
				startCall = callDaemon(sockPath, "session.start", startParams, Math.max(1, left()));
				pending = startCall;
				const startReply = startCall.reply.then((reply) => {
					const id = record(reply.result)?.session_id;
					if (typeof id === "string" && id) sessionId = id;
					return reply;
				});
				startReply.catch(() => undefined);
				// An explicit error reply means the daemon created nothing, so the abandoned-session recovery below
				// (a fixed wait plus a status call) is not owed. A timeout-shaped error is the exception: the
				// extension can still open the window after the daemon gave up waiting on it.
				startReply
					.then((reply) => {
						const code = record(reply.error)?.code;
						if (reply.error && code !== "timeout" && code !== "extension_unresponsive") startAnswered = true;
					})
					.catch(() => undefined);
				const started = record(await settleCall("session.start", startCall, startReply));
				const startedId = started?.session_id;
				if (typeof startedId !== "string" || !startedId)
					throw skip("render_failed", "session.start returned no session_id");
				const navigated = record(
					await call("tool.navigate", {
						session_id: sessionId,
						url,
						wait_until: "networkidle",
						timeout_ms: Math.max(1, left() - GET_HTML_RESERVE_MS),
					}),
				);
				const tabId = typeof navigated?.tab_id === "number" ? navigated.tab_id : undefined;
				// The page can navigate on its own after the load settled (a timer or meta refresh), so navigate's
				// final_url does not name the document get_html reads later. Each read is bracketed by the tab's
				// live URL; a read counts only when the URL did not change across it, and the URL returned is the
				// one the HTML was read from. A page that never holds still is refused.
				const tabUrl = async (): Promise<string> => {
					const listed = record(await call("tool.tab_list", { session_id: sessionId, scope: "agent" }));
					const tabs = Array.isArray(listed?.tabs)
						? listed.tabs.flatMap((tab) => (record(tab) ? [record(tab)] : []))
						: [];
					const tab =
						tabId === undefined
							? tabs.length === 1
								? tabs[0]
								: undefined
							: tabs.find((entry) => entry?.tab_id === tabId);
					if (typeof tab?.url !== "string" || !tab.url) {
						throw skip("render_failed", "the browser read failed", "the session's tab reported no URL");
					}
					return tab.url;
				};
				let html = "";
				let pageUrl = "";
				let good: RenderedPage | undefined;
				let stableReads = 0;
				let unsteadyReads = 0;
				let reads = 0;
				let refusal: BrowserSkillError | undefined;
				for (;;) {
					reads++;
					try {
						const before = await tabUrl();
						const read = record(
							await call("tool.get_html", { session_id: sessionId, max_bytes: MAX_HTML_BYTES }),
						);
						const after = await tabUrl();
						const next = typeof read?.html === "string" ? read.html : "";
						// A read from another tab than the one navigate opened is not this page, whatever its URL says.
						const readTab = typeof read?.tab_id === "number" ? read.tab_id : undefined;
						const steady =
							before === after && (tabId === undefined || readTab === undefined || readTab === tabId);
						stableReads =
							steady && after === pageUrl && next.length > 0 && next.length === html.length
								? stableReads + 1
								: 0;
						html = next;
						pageUrl = steady ? after : "";
						unsteadyReads = steady ? 0 : unsteadyReads + 1;
						if (steady && next.length > 0) good = { url: after, html: next, truncated: read?.truncated === true };
						if (steady && (stableReads + 1 >= SETTLED_READS || left() <= settlePollMs)) break;
						if (!steady && unsteadyReads >= MAX_UNSTEADY_READS) {
							refusal = skip(
								"render_failed",
								"the browser read failed",
								"the page kept navigating while it was read",
							);
							throw refusal;
						}
						if (reads >= MAX_SETTLE_READS) break;
					} catch (error) {
						// A read that fails after an earlier one succeeded keeps the page already in hand, whether the
						// daemon answered with an error, lost the tab, or never answered at all. Only an abort, a render
						// that read nothing at all, and this loop's own refusal still fail.
						if (good === undefined || signal?.aborted || error === refusal) throw error;
						break;
					}
					await delay(settlePollMs);
				}
				if (good === undefined) {
					throw skip("render_failed", "the browser read failed", "the page never held still long enough to read");
				}
				return { page: good, browser: chosen };
			} catch (error) {
				if (signal?.aborted) throw error;
				if (error instanceof BrowserSkillError) throw error;
				if (error instanceof DaemonTimeout)
					throw skip("timeout", "the browser read took longer than the request timeout", error.message);
				throw skip(
					"render_failed",
					"the browser read failed",
					error instanceof Error ? error.message : String(error),
				);
			} finally {
				signal?.removeEventListener("abort", onAbort);
				if (sessionId === undefined && startCall !== undefined && !startAnswered) {
					sessionId = await abandonedSession(sockPath, controllerName, statusTimeoutMs);
				}
				if (sessionId !== undefined) {
					await callDaemon(sockPath, "session.stop", { session_id: sessionId }, STOP_TIMEOUT_MS).reply.catch(
						() => undefined,
					);
				}
				sessions.release();
			}
		},
	};
}

/** The session a start call created after it was abandoned, named by this render's own controller name. */
async function abandonedSession(
	sockPath: string,
	controllerName: string,
	timeoutMs: number,
): Promise<string | undefined> {
	if (!controllerName) return undefined;
	await delay(LATE_SESSION_WAIT_MS);
	const status = record(await callDaemon(sockPath, "system.status", {}, timeoutMs).reply.catch(() => undefined));
	const sessions = Array.isArray(record(status?.result)?.sessions)
		? (record(status?.result)?.sessions as unknown[])
		: [];
	for (const entry of sessions) {
		const session = record(entry);
		if (record(session?.controller)?.name !== controllerName) continue;
		if (typeof session?.session_id === "string" && session.session_id) return session.session_id;
	}
	return undefined;
}

function daemonError(method: string, mode: BrowserMode, error: Readonly<Record<string, unknown>>): BrowserSkillError {
	const code = typeof error.code === "string" ? error.code : "error";
	const detail = `${method}: ${code}: ${typeof error.message === "string" ? error.message : "daemon error"}`;
	const reason = record(error.data)?.reason;
	if (code === "no_browser_connected" || code === "not_found") return notConnected("no_browser", detail);
	if (code === "timeout" && reason === "extension_unresponsive") return notConnected("browser_unresponsive", detail);
	if (method === "session.start" && mode === "incognito") {
		if (code === "unsupported" || reason === "unsupported_feature") {
			return skip(
				"incognito_unsupported",
				"the connected browser's extension cannot open an incognito window",
				detail,
			);
		}
		return skip("incognito_unavailable", "the connected browser refused an incognito window", detail);
	}
	if (code === "timeout") return skip("timeout", "the browser read took longer than the request timeout", detail);
	return skip("render_failed", "the browser read failed", detail);
}
