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
	| "browser_unresponsive";

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

	async acquire(deadline: number): Promise<boolean> {
		if (this.#free > 0) {
			this.#free--;
			return true;
		}
		return await new Promise<boolean>((resolve) => {
			const timer = setTimeout(
				() => {
					const index = this.#waiters.indexOf(grant);
					if (index !== -1) this.#waiters.splice(index, 1);
					resolve(false);
				},
				Math.max(0, deadline - Date.now()),
			);
			const grant = (): void => {
				clearTimeout(timer);
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

			if (!(await sessions.acquire(deadline))) {
				throw skip("no_time_left", "no browser session slot was free within the request timeout");
			}
			let sessionId: string | undefined;
			let pending: DaemonCall | undefined;
			const onAbort = (): void => pending?.abort();
			signal?.addEventListener("abort", onAbort, { once: true });
			const call = async (method: string, params: Record<string, unknown>, budgetMs = left()): Promise<unknown> => {
				signal?.throwIfAborted();
				if (budgetMs <= 0) throw new DaemonTimeout(`no time left for ${method}`);
				pending = callDaemon(sockPath, method, params, budgetMs);
				let reply: DaemonReply;
				try {
					reply = await pending.reply;
				} catch (error) {
					signal?.throwIfAborted();
					if (error instanceof DaemonTimeout && pending) {
						const cancel = callDaemon(sockPath, "cancel", { rpc_id: pending.id }, CANCEL_TIMEOUT_MS);
						await cancel.reply.catch(() => undefined);
					}
					throw error;
				} finally {
					pending = undefined;
				}
				if (reply.error) throw daemonError(method, mode, reply.error);
				return reply.result;
			};
			try {
				const started = record(
					await call("session.start", {
						task_name: "webfetch",
						controller: { name: "senpi webfetch" },
						browser_instance_id: chosen.instanceId,
						incognito: mode === "incognito",
						focused: false,
					}),
				);
				const startedId = started?.session_id;
				if (typeof startedId !== "string" || !startedId)
					throw skip("render_failed", "session.start returned no session_id");
				sessionId = startedId;
				const navigated = record(
					await call("tool.navigate", {
						session_id: sessionId,
						url,
						wait_until: "networkidle",
						timeout_ms: Math.max(1, left() - GET_HTML_RESERVE_MS),
					}),
				);
				const finalUrl = typeof navigated?.final_url === "string" ? navigated.final_url : url;
				let html = "";
				let truncated = false;
				let stableReads = 0;
				for (;;) {
					const read = record(await call("tool.get_html", { session_id: sessionId, max_bytes: MAX_HTML_BYTES }));
					const next = typeof read?.html === "string" ? read.html : "";
					stableReads = next.length > 0 && next.length === html.length ? stableReads + 1 : 0;
					html = next;
					truncated = read?.truncated === true;
					if (stableReads + 1 >= SETTLED_READS || left() <= settlePollMs) break;
					await delay(settlePollMs);
				}
				return { page: { url: finalUrl, html, truncated }, browser: chosen };
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
