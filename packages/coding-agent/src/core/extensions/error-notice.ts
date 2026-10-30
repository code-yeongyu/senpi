import { homedir } from "node:os";
import { getDebugLogPath } from "../../config.ts";
import { appendDebugLogEntry } from "../hidden-stdout-log.ts";
import { RUNTIME_EXTENSION_PATH } from "./types.ts";
import type { UserFacingErrorInfo } from "./user-facing-error.ts";

/** The parts of an extension failure a notice is built from; `stack` is never shown. */
export interface ExtensionFailure {
	readonly extensionPath: string;
	readonly event?: string;
	readonly error: string;
	readonly stack?: string;
	readonly userFacing?: UserFacingErrorInfo;
}

/**
 * What every surface shows for an extension failure: a coded failure is what happened and what to do;
 * anything else is a calm "Something went wrong" with a one-line reason and where the details are.
 */
export type ExtensionErrorNotice =
	| {
			readonly kind: "user";
			readonly source: string;
			readonly title: string;
			readonly detail?: string;
			readonly code: string;
			readonly docsUrl?: string;
	  }
	| {
			readonly kind: "unexpected";
			readonly source: string;
			readonly title: string;
			readonly detail: string;
			readonly logPath?: string;
	  };

const MAX_REASON_CHARACTERS = 240;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const ANSI_SEQUENCES = /\u001b\][\s\S]*?(?:\u0007|\u001b\\|\u009c|$)|(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
const EXTENSION_MODULE_URL = /senpi-extension:[^\s"'`)\]>]+/g;
const FILESYSTEM_PATH = /(^|[\s"'`(<[=,])((?:file:\/\/)?(?:~|[A-Za-z]:)?(?:[\\/][^\s\\/"'`)\]>,]+){2,}[\\/]?)/g;

function lastSegment(value: string): string {
	const segments = value.split(/[\\/]/).filter((segment) => segment.length > 0);
	return segments.at(-1) ?? value;
}

function decodedModuleName(moduleUrl: string): string {
	try {
		return lastSegment(decodeURIComponent(moduleUrl));
	} catch (error) {
		if (error instanceof URIError) return lastSegment(moduleUrl);
		throw error;
	}
}

export function extensionSourceName(extensionPath: string): string {
	if (extensionPath === RUNTIME_EXTENSION_PATH || extensionPath === "runtime") return "the session runtime";
	const segments = extensionPath.split(/[\\/]/).filter((segment) => segment.length > 0);
	const file = segments.at(-1) ?? extensionPath;
	const stem = file.replace(/\.[cm]?[jt]sx?$/i, "");
	const name = stem === "index" && segments.length > 1 ? (segments.at(-2) ?? stem) : stem;
	return name.replace(ANSI_SEQUENCES, "").replace(CONTROL_CHARACTERS, "") || "an extension";
}

/** The first line of a raw error message, with control bytes stripped and paths cut to file names. */
export function extensionErrorReason(message: string): string {
	const firstLine =
		message
			.replace(ANSI_SEQUENCES, "")
			.split(/\r?\n|\r/)
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? "";
	const reason = firstLine
		.replace(CONTROL_CHARACTERS, "")
		.replace(EXTENSION_MODULE_URL, (moduleUrl) => decodedModuleName(moduleUrl))
		.replace(FILESYSTEM_PATH, (_match, lead: string, path: string) => `${lead}${lastSegment(path)}`)
		.replace(/\s+/g, " ");
	if (reason.length === 0) return "No reason was given.";
	return reason.length <= MAX_REASON_CHARACTERS ? reason : `${reason.slice(0, MAX_REASON_CHARACTERS - 1)}…`;
}

export function displayDebugLogPath(): string {
	const logPath = getDebugLogPath();
	const home = homedir();
	return home.length > 0 && logPath.startsWith(`${home}/`) ? `~${logPath.slice(home.length)}` : logPath;
}

export function describeExtensionError(
	failure: ExtensionFailure,
	options: { readonly logPath?: string },
): ExtensionErrorNotice {
	const source = extensionSourceName(failure.extensionPath);
	const info = failure.userFacing;
	if (info !== undefined) {
		return {
			kind: "user",
			source,
			title: info.message,
			code: info.code,
			...(info.action === undefined ? {} : { detail: info.action }),
			...(info.docsUrl === undefined ? {} : { docsUrl: info.docsUrl }),
		};
	}
	const during = failure.event ? ` (during ${extensionErrorReason(failure.event)})` : "";
	return {
		kind: "unexpected",
		source,
		title: `Something went wrong in ${source}`,
		detail: `${extensionErrorReason(failure.error)}${during}`,
		...(options.logPath === undefined ? {} : { logPath: options.logPath }),
	};
}

export function extensionErrorNoticeLines(notice: ExtensionErrorNotice): string[] {
	switch (notice.kind) {
		case "user":
			return [
				notice.title,
				...(notice.detail === undefined ? [] : [notice.detail]),
				...(notice.docsUrl === undefined ? [] : [`More help: ${notice.docsUrl}`]),
				`${notice.source} · ${notice.code}`,
			];
		case "unexpected":
			return [notice.title, notice.detail, ...(notice.logPath === undefined ? [] : [`Details: ${notice.logPath}`])];
		default: {
			const unreachable: never = notice;
			return unreachable;
		}
	}
}

export function recordExtensionFailure(failure: ExtensionFailure): void {
	const body =
		failure.stack === undefined || !failure.stack.includes(failure.error)
			? [failure.error, failure.stack].filter((part) => part !== undefined).join("\n")
			: failure.stack;
	try {
		appendDebugLogEntry(
			`extension error in ${extensionSourceName(failure.extensionPath)} (${failure.event ?? "no event"}) from ${failure.extensionPath}`,
			body,
		);
	} catch (error) {
		// A failed log write must never change how the failure itself is delivered.
		if (!(error instanceof Error)) throw error;
	}
}

/** Record the failure's details in the debug log and return its notice as one line, for diagnostics lists. */
export function reportExtensionFailureLine(failure: ExtensionFailure): string {
	recordExtensionFailure(failure);
	return extensionErrorNoticeLines(describeExtensionError(failure, { logPath: displayDebugLogPath() })).join(" ");
}
