import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type BunRuntimeOptions,
	bunVersionSatisfies,
	findBunBinary,
	processBunRuntimeOptions,
} from "../../bun-runtime.ts";
import { APP_COMMAND, APP_NAME, BRAND, detectInstallMethod, getAgentDir, PACKAGE_NAME, VERSION } from "../../config.ts";
import { envValue } from "../../core/brand.ts";
import type { NoticeSpec } from "../../core/extensions/notice/index.ts";
import { hasInheritedInspectorOption } from "../../inspector-policy.ts";
import {
	type BunAvailability,
	buildRuntimeNotice,
	reinstallTarget,
	runtimeNoticeSkipReason,
	runtimePinEnvName,
	SKIP_RUNTIME_NOTICE_ENV_SUFFIX,
} from "./runtime-notice.ts";

export const RUNTIME_NOTICE_STATE_FILE = "runtime-notice.json";

export function readShownVersion(agentDir: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(join(agentDir, RUNTIME_NOTICE_STATE_FILE), "utf8"));
	} catch {
		// Missing or unreadable state means the notice was never recorded as shown.
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || !("shownVersion" in parsed)) return undefined;
	return typeof parsed.shownVersion === "string" ? parsed.shownVersion : undefined;
}

function recordShownVersion(agentDir: string, version: string): void {
	try {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, RUNTIME_NOTICE_STATE_FILE), `${JSON.stringify({ shownVersion: version })}\n`);
	} catch {
		// Best effort: a read-only agent dir only means the notice shows again next launch,
		// which must never fail the interactive startup that is already underway.
	}
}

export function detectBunAvailability(options: BunRuntimeOptions): BunAvailability {
	const bunPath = findBunBinary(options);
	if (bunPath === undefined) return { kind: "missing" };
	const version = options.bunVersion(bunPath);
	return version !== undefined && bunVersionSatisfies(version)
		? { kind: "ready", version }
		: { kind: "outdated", version };
}

function skipRequested(): boolean {
	const value = envValue(SKIP_RUNTIME_NOTICE_ENV_SUFFIX);
	return value !== undefined && value !== "" && value !== "0";
}

export function maybeShowRuntimeNotice(show: (spec: NoticeSpec) => void): void {
	const agentDir = getAgentDir();
	const skip = runtimeNoticeSkipReason({
		versions: process.versions,
		env: process.env,
		hasInheritedInspectorOption: hasInheritedInspectorOption(),
		skipRequested: skipRequested(),
		engineVersion: VERSION,
		shownVersion: readShownVersion(agentDir),
	});
	if (skip !== undefined) return;
	show(
		buildRuntimeNotice({
			appName: APP_NAME,
			appCommand: APP_COMMAND,
			nodeVersion: process.version,
			platform: process.platform,
			installMethod: detectInstallMethod(),
			target: reinstallTarget(BRAND, PACKAGE_NAME),
			bun: detectBunAvailability(processBunRuntimeOptions(existsSync, realpathSync)),
			pinEnvName: runtimePinEnvName(process.env),
		}),
	);
	recordShownVersion(agentDir, VERSION);
}
