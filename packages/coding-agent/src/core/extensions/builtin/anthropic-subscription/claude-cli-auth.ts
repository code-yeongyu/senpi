import type { ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createClaudeCliBrowserCapture } from "./claude-cli-browser-capture.ts";
import { type ClaudeCliRun, spawnClaudeCli, stopClaudeCli } from "./claude-cli-process.ts";

/** The method select's two answers: the one-click browser flow, or a URL plus a pasted code. */
export type ClaudeCliLoginMethod = "browser" | "copy-code";

export type ClaudeCliLoginFailure =
	| "org_not_allowed"
	| "provider_not_allowed"
	| "oauth_failed"
	| "unexpected_exit"
	| "spawn_failed";

export type ClaudeCliLoginResult =
	| { readonly outcome: "success" }
	| { readonly outcome: "failed"; readonly reason: ClaudeCliLoginFailure }
	| { readonly outcome: "cancelled" }
	| { readonly outcome: "timeout" };

export type ClaudeCliLoginOptions = ClaudeCliRun & {
	readonly method: ClaudeCliLoginMethod;
	readonly signal?: AbortSignal;
	/** Resets on every pasted code; matches the desktop's login completion budget. */
	readonly idleTimeoutMs?: number;
	readonly killGraceMs?: number;
	/** The localhost-redirect URL the CLI hands `$BROWSER` (browser method only). */
	readonly onAutomaticUrl?: (url: string) => void;
	/** The copy-code URL the CLI prints for the paste fallback. */
	readonly onManualUrl?: (url: string) => void;
};

export type ClaudeCliLogin = {
	/** Writes a pasted code to the CLI's stdin (never argv). False when the text holds no code or the CLI is gone. */
	readonly submitCode: (input: string) => boolean;
	readonly result: Promise<ClaudeCliLoginResult>;
};

const LOGIN_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 5_000;
const MANUAL_URL_LINE = /If the browser didn't open, visit: (https:\/\/\S+)\r?\n/;
const SUCCESS_LINE = /^(?:Paste code here if prompted > )?Login successful\.\r?$/m;
// OSC sequences (an OSC 8 hyperlink is ESC]8;;<uri>ST<text>ESC]8;;ST, ST being BEL or ESC\) and CSI sequences (colors),
// removed explicitly so the visible text is left. node:util's stripVTControlCharacters is not used: under Bun 1.4.4 it
// leaves an OSC 8 link whose URI holds "+" partly in place, and Claude's copy-code URL joins its scopes with "+".
const TERMINAL_SEQUENCE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g;
// The copy-code URL is shown to the user to open, so only Claude's own sign-in hosts are passed on.
const MANUAL_URL_HOSTS: ReadonlySet<string> = new Set([
	"claude.ai",
	"claude.com",
	"platform.claude.com",
	"console.anthropic.com",
]);

function visibleText(output: string): string {
	return output.replace(TERMINAL_SEQUENCE, "");
}

function isClaudeSignInUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.username === "" &&
			url.password === "" &&
			url.port === "" &&
			MANUAL_URL_HOSTS.has(url.hostname)
		);
	} catch {
		return false;
	}
}

/** Accepts `code#state`, a bare code, a query string, or the full callback URL; returns the line the CLI reads. */
export function normalizePastedCode(input: string): string | undefined {
	const value = input.trim();
	if (value.length === 0 || /[\r\n]/.test(value)) return undefined;
	let params: URLSearchParams | undefined;
	try {
		params = new URL(value).searchParams;
	} catch {
		if (!value.includes("#") && value.includes("code=")) params = new URLSearchParams(value);
	}
	if (params === undefined) return value;
	const code = params.get("code");
	if (!code) return undefined;
	const state = params.get("state");
	return state ? `${code}#${state}` : code;
}

function failureReason(stderr: string): ClaudeCliLoginFailure {
	if (stderr.includes("cli_auth_login_org_not_allowed")) return "org_not_allowed";
	if (stderr.includes("cli_auth_login_provider_not_allowed")) return "provider_not_allowed";
	if (stderr.includes("OAuth login failed")) return "oauth_failed";
	return "unexpected_exit";
}

/**
 * Runs `<claude> auth login --claudeai` for one account dir. `--console` and `--sso` are never passed, so an
 * API-billing login cannot happen here. Output, URLs and pasted codes are never logged.
 */
export function startClaudeCliLogin(options: ClaudeCliLoginOptions): ClaudeCliLogin {
	const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
	const idleTimeoutMs = options.idleTimeoutMs ?? LOGIN_IDLE_TIMEOUT_MS;
	const capture = createClaudeCliBrowserCapture(options.method === "browser" ? "capture" : "discard", (url) =>
		options.onAutomaticUrl?.(url),
	);
	let child: ChildProcess | undefined;
	let ending: "cancelled" | "timeout" | undefined;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;

	const end = (why: "cancelled" | "timeout") => {
		if (ending !== undefined || child === undefined) return;
		ending = why;
		stopClaudeCli(child, killGraceMs);
	};
	const armIdle = () => {
		clearTimeout(idleTimer);
		idleTimer = setTimeout(() => end("timeout"), idleTimeoutMs);
		idleTimer.unref?.();
	};
	const onAbort = () => end("cancelled");

	const result = new Promise<ClaudeCliLoginResult>((resolve) => {
		const settle = (value: ClaudeCliLoginResult) => {
			clearTimeout(idleTimer);
			options.signal?.removeEventListener("abort", onAbort);
			capture.dispose();
			resolve(value);
		};
		if (options.signal?.aborted) {
			settle({ outcome: "cancelled" });
			return;
		}
		try {
			mkdirSync(options.configDir, { recursive: true, mode: 0o700 });
			child = spawnClaudeCli(options, ["auth", "login", "--claudeai"], capture.helperPath);
		} catch {
			settle({ outcome: "failed", reason: "spawn_failed" });
			return;
		}
		let stdout = "";
		let stderr = "";
		let manualSeen = false;
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
			capture.flush();
			const manual = manualSeen ? null : MANUAL_URL_LINE.exec(visibleText(stdout));
			if (manual?.[1] !== undefined) {
				manualSeen = true;
				if (isClaudeSignInUrl(manual[1])) options.onManualUrl?.(manual[1]);
			}
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.stdin?.on("error", () => {}); // a CLI that exited before reading the paste closes the pipe
		child.once("error", () => {
			if (child?.pid === undefined) settle({ outcome: "failed", reason: "spawn_failed" });
		});
		child.once("close", (exitCode: number | null) => {
			capture.flush();
			if (ending !== undefined) settle({ outcome: ending });
			else if (exitCode === 0 && SUCCESS_LINE.test(visibleText(stdout))) settle({ outcome: "success" });
			else settle({ outcome: "failed", reason: exitCode === 0 ? "unexpected_exit" : failureReason(stderr) });
		});
		options.signal?.addEventListener("abort", onAbort, { once: true });
		armIdle();
	});

	return {
		result,
		submitCode: (input) => {
			const line = normalizePastedCode(input);
			const stdin = child?.stdin;
			if (line === undefined || stdin === undefined || stdin === null || !stdin.writable || ending !== undefined) {
				return false;
			}
			armIdle();
			stdin.write(`${line}\n`);
			return true;
		},
	};
}
