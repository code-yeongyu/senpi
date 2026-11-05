import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Reads a page through the browser the user already has connected to BrowserSkill (Tencent's `bsk`
 * daemon plus its extension), the same integration OmOWright's `connectBrowserSkill` drives. webfetch
 * never launches a browser or starts the daemon: when no daemon is running or no browser is
 * connected, the caller keeps its static result and reports the typed reason (senpi#5939).
 *
 * Wire shapes follow `crates/bsk-protocol` (JSON Lines frames over the daemon's Unix socket):
 * `system.status` -> `browsers[]`, `session.start` -> `session_id`, `tool.navigate` ->
 * `final_url`, `tool.get_html` -> `html`, `session.stop`.
 */

export interface RenderedPage {
	readonly url: string;
	readonly html: string;
}

export interface PageRenderOptions {
	readonly timeoutMs: number;
	readonly signal?: AbortSignal;
}

export interface PageRenderer {
	readonly name: string;
	render(url: string, options: PageRenderOptions): Promise<RenderedPage>;
}

export type BrowserSkillErrorCode =
	| "integration_not_running"
	| "no_browser_connected"
	| "browser_unresponsive"
	| "timeout"
	| "render_failed";

export class BrowserSkillError extends Error {
	override readonly name = "BrowserSkillError";
	readonly code: BrowserSkillErrorCode;

	constructor(code: BrowserSkillErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

export interface BrowserSkillOptions {
	readonly home?: string;
	readonly settlePollMs?: number;
}

const SETTLE_POLL_MS = 250;
// The page counts as rendered once two reads in a row return the same HTML length.
const SETTLED_READS = 2;
const STOP_TIMEOUT_MS = 5_000;

export function browserSkillHome(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.BSK_HOME;
	return override ? override : join(env.HOME || homedir(), ".bsk");
}

function readSocketPath(home: string): string | undefined {
	try {
		const info: unknown = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8"));
		const sockPath: unknown = typeof info === "object" && info !== null ? Reflect.get(info, "sock_path") : undefined;
		return typeof sockPath === "string" && sockPath ? sockPath : undefined;
	} catch {
		return undefined;
	}
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: undefined;
}

function callDaemon(
	sockPath: string,
	method: string,
	params: Record<string, unknown>,
	timeoutMs: number,
): Promise<unknown> {
	const id = `webfetch-${method.replace(/[^a-z0-9]+/giu, "-")}-${randomBytes(4).toString("hex")}`;
	return new Promise((resolve, reject) => {
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
			() => finish(() => reject(new BrowserSkillError("timeout", `${method} did not answer within ${timeoutMs}ms`))),
			timeoutMs,
		);
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
		socket.on("error", (error: NodeJS.ErrnoException) =>
			finish(() =>
				reject(
					new BrowserSkillError(
						"integration_not_running",
						`the BrowserSkill daemon is not answering (${error.code ?? error.message})`,
					),
				),
			),
		);
		socket.on("close", () =>
			finish(() => reject(new BrowserSkillError("render_failed", `${method}: the daemon closed the connection`))),
		);
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			finish(() => {
				const reply = record(JSON.parse(buffer.slice(0, newline)));
				const error = record(reply?.error);
				if (error) {
					const code = error.code === "no_browser_connected" ? "no_browser_connected" : "render_failed";
					reject(
						new BrowserSkillError(code, `${method}: ${String(error.message ?? error.code ?? "daemon error")}`),
					);
				} else {
					resolve(reply?.result);
				}
			});
		});
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createBrowserSkillRenderer(options: BrowserSkillOptions = {}): PageRenderer {
	const settlePollMs = options.settlePollMs ?? SETTLE_POLL_MS;
	return {
		name: "your connected browser (BrowserSkill)",
		async render(url, { timeoutMs, signal }) {
			signal?.throwIfAborted();
			const deadline = Date.now() + timeoutMs;
			const left = (): number => {
				const ms = deadline - Date.now();
				if (ms <= 0) throw new BrowserSkillError("timeout", `the browser read took longer than ${timeoutMs}ms`);
				return ms;
			};
			const sockPath = readSocketPath(options.home ?? browserSkillHome());
			if (sockPath === undefined) {
				throw new BrowserSkillError(
					"integration_not_running",
					"no BrowserSkill daemon is running (no daemon.json)",
				);
			}
			const call = (method: string, params: Record<string, unknown>): Promise<unknown> => {
				signal?.throwIfAborted();
				return callDaemon(sockPath, method, params, left());
			};

			const status = record(await call("system.status", {}));
			const browsers = Array.isArray(status?.browsers) ? status.browsers.map(record) : [];
			if (browsers.length === 0) {
				throw new BrowserSkillError(
					"no_browser_connected",
					"the BrowserSkill daemon is up but no browser is connected",
				);
			}
			if (browsers.every((browser) => browser?.unresponsive === true)) {
				throw new BrowserSkillError("browser_unresponsive", "the connected browser stopped answering the daemon");
			}

			const started = record(await call("session.start", { task_name: "webfetch", focused: false }));
			const sessionId = started?.session_id;
			if (typeof sessionId !== "string" || !sessionId) {
				throw new BrowserSkillError("render_failed", "session.start returned no session_id");
			}
			try {
				const navigated = record(
					await call("tool.navigate", {
						session_id: sessionId,
						url,
						wait_until: "networkidle",
						timeout_ms: Math.max(1, left()),
					}),
				);
				const finalUrl = typeof navigated?.final_url === "string" ? navigated.final_url : url;
				let html = "";
				let stableReads = 0;
				for (;;) {
					const read = record(await call("tool.get_html", { session_id: sessionId }));
					const next = typeof read?.html === "string" ? read.html : "";
					stableReads = next.length > 0 && next.length === html.length ? stableReads + 1 : 0;
					html = next;
					if (stableReads + 1 >= SETTLED_READS || deadline - Date.now() <= settlePollMs) break;
					await delay(settlePollMs);
				}
				return { url: finalUrl, html };
			} finally {
				await callDaemon(sockPath, "session.stop", { session_id: sessionId }, STOP_TIMEOUT_MS).catch(
					() => undefined,
				);
			}
		},
	};
}
