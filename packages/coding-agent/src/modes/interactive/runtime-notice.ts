/**
 * The "running on Node.js" startup notice: when to show it and what it says.
 *
 * The only trigger is the runtime itself. Every install path that can run on Bun already
 * re-execs there (`bun-runtime.ts` for senpi, the OmO Native launcher for omo), so a process
 * still on Node here is one the user can fix: Bun is missing or too old, or the package was
 * installed by a manager that keeps it on Node. Everything in this file is pure; the
 * interactive mode supplies the facts through `runtime-notice-presenter.ts`.
 */
import { MIN_BUN_VERSION, RUNTIME_ENV_VAR } from "../../bun-runtime.ts";
import type { InstallMethod } from "../../config.ts";
import type { BrandProfile } from "../../core/brand.ts";
import type { NoticeLine, NoticeSpec } from "../../core/extensions/notice/index.ts";

export const SKIP_RUNTIME_NOTICE_ENV_SUFFIX = "SKIP_RUNTIME_NOTICE";

export type RuntimeNoticeSkip = "bun-runtime" | "node-pinned" | "inspector" | "skip-requested" | "already-shown";

export interface RuntimeNoticeGate {
	readonly versions: Readonly<Record<string, string | undefined>>;
	readonly env: NodeJS.ProcessEnv;
	readonly hasInheritedInspectorOption: boolean;
	readonly skipRequested: boolean;
	readonly engineVersion: string;
	readonly shownVersion: string | undefined;
}

/**
 * The variable that pins the runtime from the user's side. The OmO Native launcher always
 * forwards its own runtime as `SENPI_RUNTIME`, so under OmO Native only `OMO_RUNTIME` is the
 * user's choice; a forwarded `SENPI_RUNTIME=node` just means the launcher could not use Bun.
 */
export function runtimePinEnvName(env: NodeJS.ProcessEnv): string {
	return env.OMO_NATIVE === "1" ? "OMO_RUNTIME" : RUNTIME_ENV_VAR;
}

export function runtimeNoticeSkipReason(gate: RuntimeNoticeGate): RuntimeNoticeSkip | undefined {
	if (gate.versions.bun !== undefined) return "bun-runtime";
	if (gate.env[runtimePinEnvName(gate.env)] === "node") return "node-pinned";
	if (gate.hasInheritedInspectorOption) return "inspector";
	if (gate.skipRequested) return "skip-requested";
	if (gate.shownVersion === gate.engineVersion) return "already-shown";
	return undefined;
}

export type BunAvailability =
	| { readonly kind: "missing" }
	| { readonly kind: "outdated"; readonly version: string | undefined }
	| { readonly kind: "ready"; readonly version: string };

export interface ReinstallTarget {
	readonly packageName: string;
	readonly installSpec: string;
	readonly ignoreScripts: boolean;
}

export function reinstallTarget(brand: BrandProfile | undefined, packageName: string): ReinstallTarget | undefined {
	if (brand === undefined) return { packageName, installSpec: packageName, ignoreScripts: true };
	const update = brand.update;
	// A brand without an update channel manages its own installs; there is no command to offer.
	if (update === undefined) return undefined;
	const installSpec = update.distTag === "latest" ? update.packageName : `${update.packageName}@${update.distTag}`;
	// Branded products may rely on their install script; senpi documents --ignore-scripts.
	return { packageName: update.packageName, installSpec, ignoreScripts: false };
}

function uninstallCommand(method: InstallMethod, packageName: string): string | undefined {
	switch (method) {
		case "npm":
			return `npm uninstall -g ${packageName}`;
		case "pnpm":
			return `pnpm remove -g ${packageName}`;
		case "yarn":
			return `yarn global remove ${packageName}`;
		case "bun":
		case "bun-binary":
		case "unknown":
			return undefined;
	}
}

/** Clean reinstall: remove the Node-managed copy so PATH cannot keep resolving it, then add it with Bun. */
export function bunReinstallCommand(method: InstallMethod, target: ReinstallTarget): string {
	const install = `bun add -g ${target.ignoreScripts ? "--ignore-scripts " : ""}${target.installSpec}`;
	const uninstall = uninstallCommand(method, target.packageName);
	return uninstall === undefined ? install : `${uninstall} && ${install}`;
}

export function installBunCommand(platform: NodeJS.Platform): string {
	return platform === "win32"
		? `powershell -c "irm bun.sh/install.ps1 | iex"`
		: "curl -fsSL https://bun.sh/install | bash";
}

export interface RuntimeNoticeInput {
	readonly appName: string;
	readonly appCommand: string;
	readonly nodeVersion: string;
	readonly platform: NodeJS.Platform;
	readonly installMethod: InstallMethod;
	readonly target: ReinstallTarget | undefined;
	readonly bun: BunAvailability;
	readonly pinEnvName: string;
}

function bunStep(input: RuntimeNoticeInput): NoticeLine | undefined {
	switch (input.bun.kind) {
		case "missing":
			return { text: `Install Bun: ${installBunCommand(input.platform)}`, tone: "accent" };
		case "outdated":
			return {
				text: `Upgrade Bun (found ${input.bun.version ?? "an unreadable version"}, needs ${MIN_BUN_VERSION}+): bun upgrade`,
				tone: "accent",
			};
		case "ready":
			return undefined;
	}
}

function reinstallStep(input: RuntimeNoticeInput, afterBunStep: boolean): NoticeLine {
	const lead = afterBunStep ? "Then reinstall" : "Reinstall";
	// A Bun-global install needs no reinstall: a current Bun takes it over on the next launch.
	if (input.installMethod === "bun" || input.target === undefined) {
		return { text: `${afterBunStep ? "Then restart" : "Restart"} ${input.appCommand}.`, tone: "accent" };
	}
	return { text: `${lead} with Bun: ${bunReinstallCommand(input.installMethod, input.target)}`, tone: "accent" };
}

export function buildRuntimeNotice(input: RuntimeNoticeInput): NoticeSpec {
	const first = bunStep(input);
	const extra: NoticeLine[] = [
		...(first === undefined ? [] : [first]),
		reinstallStep(input, first !== undefined),
		{ text: `To stay on Node.js and hide this notice, set ${input.pinEnvName}=node.` },
	];
	return {
		title: "Running on Node.js",
		tone: "warning",
		why: `${input.appName} is running on Node.js ${input.nodeVersion}. It starts faster and every feature works on Bun ${MIN_BUN_VERSION}+.`,
		extra,
	};
}
