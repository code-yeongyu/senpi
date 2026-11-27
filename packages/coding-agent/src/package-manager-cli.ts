import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import chalk from "chalk";
import lockfile from "proper-lockfile";
// BETA(omo-local-update): removable beta import - delete with src/beta/omo-local-update.ts
import { runOmoLocalUpdateBeta } from "./beta/omo-local-update.ts";
import { CONFIG_IMPORT_PI_ARGV, runConfigImportPi } from "./cli/config-import-pi.ts";
import { CONFIG_COMMAND_USAGE, printConfigCommandHelp } from "./cli/config-command-help.ts";
import { selectConfig } from "./cli/config-selector.ts";
import { cliTrustDecider, savedProjectTrust } from "./cli/command-trust.ts";
import { renderEngineDiagnostics } from "./cli/engine-diagnostics-render.ts";
import {
	APP_NAME,
	CONFIG_DIR_NAME,
	DISPLAY_VERSION,
	detectInstallMethod,
	type InstallMethod,
	getAgentDir,
	getInstallPackageDir,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	PACKAGE_NAME,
	type SelfUpdateCommand,
	type SelfUpdatePackageTarget,
	VERSION,
} from "./config.ts";
import { brandProfile } from "./core/brand.ts";
import type { InlineExtension } from "./core/extensions/types.ts";
import { type HeldFileLock, lockWithLossHandling } from "./core/file-lock.ts";
import { type ConfiguredPackage, type ProgressEvent } from "./core/package-manager.ts";
import type { EngineCommandScope } from "./engine/command-settings.ts";
import { openResourceConfig } from "./engine/config.ts";
import { updateModelCatalogs } from "./engine/models.ts";
import {
	installPackage,
	listPackages,
	openPackageManager,
	type PackageCommandCode,
	removePackage,
	runPackageStep,
	updatePackages,
	updateStep,
} from "./engine/packages.ts";
import type { EngineResult } from "./engine/result.ts";
import { spawnProcess, spawnProcessSync, waitForChildProcess } from "./utils/child-process.ts";
import { canonicalizePath, getCwdRelativePath } from "./utils/paths.ts";
import { getPiUserAgent } from "./utils/pi-user-agent.ts";
import { formatVersionCheckError, getLatestPiRelease, isNewerPackageVersion } from "./utils/version-check.ts";
import {
	cleanupWindowsSelfUpdateQuarantine,
	quarantineWindowsNativeDependencies,
} from "./utils/windows-self-update.ts";

export type PackageCommand = "install" | "remove" | "update" | "list";

type UpdateTarget = { type: "all" } | { type: "self" } | { type: "extensions"; source?: string } | { type: "models" };

const DEFAULT_INSTALLER_API_BASE = "https://pi.dev/api/installer/releases";
const MANAGED_INSTALL_MARKER = "managed-install.json";
const MANAGED_RELEASE_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function getActiveManagedInstallRoot(): string | undefined {
	const configuredRoot = process.env.PI_MANAGED_INSTALL_ROOT?.trim();
	if (!configuredRoot) return undefined;

	const managedRoot = resolve(configuredRoot);
	const releasesDir = canonicalizePath(join(managedRoot, "releases"));
	// The launcher environment is inherited by child processes. Do not classify a
	// source checkout or another Pi installation launched from managed Pi as managed.
	if (getCwdRelativePath(canonicalizePath(getInstallPackageDir()), releasesDir) === undefined) return undefined;

	const markerPath = join(managedRoot, MANAGED_INSTALL_MARKER);
	try {
		const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
			kind?: unknown;
			layout?: unknown;
			schemaVersion?: unknown;
		};
		if (marker.kind !== "pi-managed-install" || marker.schemaVersion !== 1 || marker.layout !== "releases-v1") {
			throw new Error();
		}
	} catch {
		throw new Error(`Managed install marker is missing or invalid: ${markerPath}`);
	}

	return managedRoot;
}

async function fetchInstallerArtifact(url: string, label: string): Promise<string> {
	const response = await fetch(url, { headers: { "User-Agent": getPiUserAgent(VERSION) } });
	if (!response.ok) {
		throw new Error(`Could not download managed installer ${label} from ${url}: HTTP ${response.status}`);
	}
	return await response.text();
}

async function runManagedNpmCi(stageDir: string): Promise<void> {
	const args = [
		"ci",
		"--ignore-scripts",
		"--min-release-age=0",
		"--omit=dev",
		"--include=optional",
		"--no-fund",
		"--no-audit",
		"--loglevel=error",
		"--progress=false",
	];
	const code = await waitForChildProcess(spawnProcess("npm", args, { cwd: stageDir, stdio: "inherit" }));
	if (code !== 0) throw new Error(`npm ${args.join(" ")} exited with code ${code ?? "unknown"}`);
}

function verifyManagedRelease(releaseDir: string, expectedVersion: string): void {
	const binPath = join(
		releaseDir,
		"node_modules",
		".bin",
		process.platform === "win32" ? `${APP_NAME}.cmd` : APP_NAME,
	);
	const result = spawnProcessSync(binPath, ["--version"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error || result.status !== 0) {
		const reason = result.error?.message || result.stderr.trim() || `exit code ${result.status ?? "unknown"}`;
		throw new Error(`Could not verify managed Pi ${expectedVersion}: ${reason}`);
	}
	const installedVersion = result.stdout.trim();
	if (installedVersion !== expectedVersion) {
		throw new Error(`Managed Pi smoke test returned version ${installedVersion}; expected ${expectedVersion}.`);
	}
}

function activateManagedRelease(managedRoot: string, version: string): void {
	const currentPath = join(managedRoot, "current-version");
	const temporaryPath = join(managedRoot, `current-version.tmp.${process.pid}-${Date.now()}`);
	try {
		writeFileSync(temporaryPath, `${version}\n`);
		renameSync(temporaryPath, currentPath);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
}

function cleanupManagedStaging(managedRoot: string): void {
	const stagingRoot = join(managedRoot, "staging");
	try {
		for (const entry of readdirSync(stagingRoot)) {
			if (entry.startsWith("update-")) {
				rmSync(join(stagingRoot, entry), { force: true, recursive: true });
			}
		}
	} catch {
		// The staging directory does not exist yet or is not writable.
	}
}

export function cleanupManagedInstall(): void {
	let managedRoot: string | undefined;
	try {
		managedRoot = getActiveManagedInstallRoot();
	} catch {
		return;
	}
	if (!managedRoot) return;

	try {
		const releaseLock = lockfile.lockSync(join(managedRoot, "update"), { realpath: false });
		try {
			cleanupManagedStaging(managedRoot);
		} finally {
			releaseLock();
		}
	} catch {
		// A live update owns the staging directory, or cleanup is unavailable.
	}
}

async function runManagedSelfUpdate(managedRoot: string, version: string): Promise<void> {
	if (!MANAGED_RELEASE_VERSION_RE.test(version)) {
		throw new Error(`Invalid managed release version: ${version}`);
	}

	let updateLock: HeldFileLock;
	try {
		updateLock = await lockWithLossHandling(join(managedRoot, "update"), { realpath: false });
	} catch (error: unknown) {
		if (error instanceof Error && "code" in error && error.code === "ELOCKED") {
			throw new Error("Another managed Pi update is already running.");
		}
		throw error;
	}

	let stageDir: string | undefined;
	try {
		cleanupManagedStaging(managedRoot);
		const installerApiBase = (process.env.PI_INSTALLER_API_BASE?.trim() || DEFAULT_INSTALLER_API_BASE).replace(
			/\/+$/,
			"",
		);
		const releaseUrl = `${installerApiBase}/${encodeURIComponent(version)}`;
		const stagingRoot = join(managedRoot, "staging");
		const releasesRoot = join(managedRoot, "releases");
		mkdirSync(releasesRoot, { recursive: true });
		const releaseDir = join(releasesRoot, version);
		if (existsSync(releaseDir)) {
			verifyManagedRelease(releaseDir, version);
			updateLock.assertHeld();
			activateManagedRelease(managedRoot, version);
			return;
		}

		mkdirSync(stagingRoot, { recursive: true });
		stageDir = mkdtempSync(join(stagingRoot, "update-"));
		const [packageJsonContent, packageLockContent] = await Promise.all([
			fetchInstallerArtifact(`${releaseUrl}/package.json`, "package.json"),
			fetchInstallerArtifact(`${releaseUrl}/package-lock.json`, "package-lock.json"),
		]);
		writeFileSync(join(stageDir, "package.json"), packageJsonContent);
		writeFileSync(join(stageDir, "package-lock.json"), packageLockContent);

		await runManagedNpmCi(stageDir);
		verifyManagedRelease(stageDir, version);
		updateLock.assertHeld();
		renameSync(stageDir, releaseDir);
		updateLock.assertHeld();
		activateManagedRelease(managedRoot, version);
	} finally {
		if (stageDir) rmSync(stageDir, { force: true, recursive: true });
		await updateLock.release();
	}
}

const SELF_UPDATE_NOTE_MARKDOWN_THEME: MarkdownTheme = {
	heading: (text) => chalk.bold(chalk.yellow(text)),
	link: (text) => chalk.cyan(text),
	linkUrl: (text) => chalk.dim(text),
	code: (text) => chalk.yellow(text),
	codeBlock: (text) => chalk.dim(text),
	codeBlockBorder: (text) => chalk.dim(text),
	quote: (text) => chalk.dim(text),
	quoteBorder: (text) => chalk.dim(text),
	hr: (text) => chalk.dim(text),
	listBullet: (text) => chalk.yellow(text),
	bold: (text) => chalk.bold(text),
	italic: (text) => chalk.italic(text),
	strikethrough: (text) => chalk.strikethrough(text),
	underline: (text) => chalk.underline(text),
};

interface PackageCommandOptions {
	command: PackageCommand;
	source?: string;
	updateTarget?: UpdateTarget;
	showExtensionsSkippedNote: boolean;
	// BETA(omo-local-update): hidden internal flag; remove with src/beta/omo-local-update*.ts.
	omoLocalUpdateWorker: boolean;
	local: boolean;
	force: boolean;
	projectTrustOverride?: boolean;
	help: boolean;
	invalidOption?: string;
	invalidArgument?: string;
	missingOptionValue?: string;
	conflictingOptions?: string;
}

function getPackageCommandUsage(command: PackageCommand): string {
	switch (command) {
		case "install":
			return `${APP_NAME} install <source> [-l] [--approve|--no-approve]`;
		case "remove":
			return `${APP_NAME} remove <source> [-l] [--approve|--no-approve]`;
		case "update":
			return `${APP_NAME} update [source|self|${APP_NAME}] [--self|--extensions|--models|--all] [--extension <source>] [--approve|--no-approve] [--force]`;
		case "list":
			return `${APP_NAME} list [--approve|--no-approve]`;
	}
}

function printPackageCommandHelp(command: PackageCommand): void {
	switch (command) {
		case "install":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("install")}

Install a package and add it to settings.

Options:
  -l, --local       Install project-locally (${CONFIG_DIR_NAME}/settings.json)
  -a, --approve     Trust project-local files for this command
  -na, --no-approve Ignore project-local files for this command

Examples:
  ${APP_NAME} install npm:@foo/bar
  ${APP_NAME} install git:github.com/user/repo
  ${APP_NAME} install git:git@github.com:user/repo
  ${APP_NAME} install https://github.com/user/repo
  ${APP_NAME} install ssh://git@github.com/user/repo
  ${APP_NAME} install ./local/path
`);
			return;

		case "remove":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("remove")}

Remove a package and its source from settings.
Alias: ${APP_NAME} uninstall <source> [-l]

Options:
  -l, --local       Remove from project settings (${CONFIG_DIR_NAME}/settings.json)
  -a, --approve     Trust project-local files for this command
  -na, --no-approve Ignore project-local files for this command

Examples:
  ${APP_NAME} remove npm:@foo/bar
  ${APP_NAME} uninstall npm:@foo/bar
`);
			return;

		case "update":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("update")}

Update ${APP_NAME}, installed packages, or model catalogs.

Options:
  --self                  Update ${APP_NAME} only (default when no target is given)
  --extensions            Update installed packages only
  --models                Refresh model catalogs only
  --all                   Update ${APP_NAME} and installed packages
  --extension <source>    Update one package only
  -a, --approve           Trust project-local files for this command
  -na, --no-approve       Ignore project-local files for this command
  --force                 Reinstall ${APP_NAME} even if the current version is latest

Short forms:
  ${APP_NAME} update                Update ${APP_NAME} only
  ${APP_NAME} update --all          Update ${APP_NAME} and all extensions
  ${APP_NAME} update --models       Refresh model catalogs only
  ${APP_NAME} update <source>       Update one package
  ${APP_NAME} update ${APP_NAME}     Update ${APP_NAME} only (self and pi work as aliases)
`);
			return;

		case "list":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("list")}

List installed packages from user and project settings.

Options:
  -a, --approve      Trust project-local files for this command
  -na, --no-approve  Ignore project-local files for this command
`);
			return;
	}
}

function parsePackageCommand(args: string[]): PackageCommandOptions | undefined {
	const [rawCommand, ...rest] = args;
	let command: PackageCommand | undefined;
	if (rawCommand === "uninstall") {
		command = "remove";
	} else if (rawCommand === "install" || rawCommand === "remove" || rawCommand === "update" || rawCommand === "list") {
		command = rawCommand;
	}
	if (!command) {
		return undefined;
	}

	let local = false;
	let force = false;
	let omoLocalUpdateWorker = false;
	let projectTrustOverride: boolean | undefined;
	let help = false;
	let invalidOption: string | undefined;
	let invalidArgument: string | undefined;
	let missingOptionValue: string | undefined;
	let conflictingOptions: string | undefined;
	let source: string | undefined;
	let selfFlag = false;
	let extensionsFlag = false;
	let modelsFlag = false;
	let allFlag = false;
	let extensionFlagSource: string | undefined;

	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index];
		if (arg === "-h" || arg === "--help") {
			help = true;
			continue;
		}

		if (arg === "-l" || arg === "--local") {
			if (command === "install" || command === "remove") {
				local = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--self") {
			if (command === "update") {
				selfFlag = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--extensions") {
			if (command === "update") {
				extensionsFlag = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--models") {
			if (command === "update") {
				modelsFlag = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--all") {
			if (command === "update") {
				allFlag = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--approve" || arg === "-a") {
			projectTrustOverride = true;
			continue;
		}

		if (arg === "--no-approve" || arg === "-na") {
			projectTrustOverride = false;
			continue;
		}

		if (arg === "--force") {
			if (command === "update") {
				force = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--omo-local-update-worker") {
			if (command === "update") {
				omoLocalUpdateWorker = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--extension") {
			if (command !== "update") {
				invalidOption = invalidOption ?? arg;
				continue;
			}

			const value = rest[index + 1];
			if (!value || value.startsWith("-")) {
				missingOptionValue = missingOptionValue ?? arg;
			} else if (extensionFlagSource) {
				conflictingOptions = conflictingOptions ?? "--extension can only be provided once";
				index++;
			} else {
				extensionFlagSource = value;
				index++;
			}
			continue;
		}

		if (arg.startsWith("-")) {
			invalidOption = invalidOption ?? arg;
			continue;
		}

		if (!source) {
			source = arg;
		} else {
			invalidArgument = invalidArgument ?? arg;
		}
	}

	let updateTarget: UpdateTarget | undefined;
	let showExtensionsSkippedNote = false;
	if (command === "update") {
		if (allFlag && (selfFlag || extensionsFlag || modelsFlag || extensionFlagSource)) {
			conflictingOptions =
				conflictingOptions ?? "--all cannot be combined with --self, --extensions, --models, or --extension";
		}
		if (allFlag && source) {
			conflictingOptions = conflictingOptions ?? "--all cannot be combined with a positional source";
		}

		if (modelsFlag) {
			if (selfFlag || extensionsFlag || allFlag || extensionFlagSource) {
				conflictingOptions =
					conflictingOptions ?? "--models cannot be combined with --self, --extensions, --all, or --extension";
			}
			if (source) {
				conflictingOptions = conflictingOptions ?? "--models cannot be combined with a positional source";
			}
			updateTarget = { type: "models" };
		} else if (extensionFlagSource) {
			if (selfFlag || extensionsFlag || allFlag) {
				conflictingOptions =
					conflictingOptions ?? "--extension cannot be combined with --self, --extensions, or --all";
			}
			if (source) {
				conflictingOptions = conflictingOptions ?? "--extension cannot be combined with a positional source";
			}
			updateTarget = { type: "extensions", source: extensionFlagSource };
		} else if (source) {
			const sourceIsSelf = source === "self" || source === "pi" || source === APP_NAME;
			if (sourceIsSelf) {
				updateTarget = extensionsFlag ? { type: "all" } : { type: "self" };
			} else {
				if (extensionsFlag || selfFlag || allFlag) {
					conflictingOptions =
						conflictingOptions ??
						"positional update targets cannot be combined with --self, --extensions, or --all";
				}
				updateTarget = { type: "extensions", source };
			}
		} else if (allFlag) {
			updateTarget = { type: "all" };
		} else if (selfFlag && extensionsFlag) {
			updateTarget = { type: "all" };
		} else if (selfFlag) {
			updateTarget = { type: "self" };
		} else if (extensionsFlag) {
			updateTarget = { type: "extensions" };
		} else {
			updateTarget = { type: "self" };
			showExtensionsSkippedNote = true;
		}
	}

	return {
		command,
		source,
		updateTarget,
		showExtensionsSkippedNote,
		omoLocalUpdateWorker,
		local,
		force,
		projectTrustOverride,
		help,
		invalidOption,
		invalidArgument,
		missingOptionValue,
		conflictingOptions,
	};
}

function updateTargetIncludesSelf(target: UpdateTarget): boolean {
	return target.type === "all" || target.type === "self";
}

function updateTargetIncludesExtensions(target: UpdateTarget): boolean {
	return target.type === "all" || target.type === "extensions";
}

function printSelfUpdateUnavailable(
	npmCommand?: string[],
	updatePackageTarget: SelfUpdatePackageTarget = PACKAGE_NAME,
): void {
	console.error(`error: ${APP_NAME} cannot self-update this installation.`);
	console.error(getSelfUpdateUnavailableInstruction(PACKAGE_NAME, npmCommand, updatePackageTarget));

	const entrypoint = process.argv[1];
	if (entrypoint) {
		console.error("");
		console.error(`Location of ${APP_NAME} executable: ${entrypoint}`);
	}
}

function printSelfUpdateFallback(command: SelfUpdateCommand): void {
	console.error(chalk.dim(`If this keeps failing, run this command yourself: ${command.display}`));
}

function printPnpmSelfUpdateMetadataHint(): void {
	console.error(chalk.yellow("If pnpm reports missing package versions, its cached registry metadata may be stale."));
	console.error(chalk.yellow(`Run \`pnpm store prune\` and retry \`${APP_NAME} update --self\`.`));
}

function printSelfUpdateNote(note: string): void {
	const trimmedNote = note.trim();
	if (!trimmedNote) {
		return;
	}

	console.log();
	console.log(chalk.bold(chalk.yellow("Update note")));
	try {
		const width = Math.max(20, process.stdout.columns ?? 80);
		const renderedLines = new Markdown(trimmedNote, 0, 0, SELF_UPDATE_NOTE_MARKDOWN_THEME)
			.render(width)
			.map((line) => line.trimEnd());
		console.log(renderedLines.join("\n"));
	} catch {
		console.log(trimmedNote);
	}
	console.log();
}

export interface SelfUpdatePlan {
	packageName: string;
	installSpec: string;
	version: string;
	shouldRun: boolean;
	note?: string;
}

/**
 * The latest-version lookup failed. A standalone binary cannot update itself in place, and since senpi#6633 its lookup
 * asks the unauthenticated GitHub API (60 requests per hour per IP), so a failed lookup points it at the download page
 * instead of failing `update --self`. Every other install still fails, because it would run an install command.
 */
export function selfUpdatePlanAfterLookupFailure(installMethod: InstallMethod, reason: string): SelfUpdatePlan {
	if (installMethod !== "bun-binary") {
		throw new Error(`Could not determine latest ${APP_NAME} version${reason ? `: ${reason}` : "."}`);
	}
	console.log(chalk.yellow(`Could not check the latest ${APP_NAME} release${reason ? ` (${reason})` : ""}.`));
	console.log(chalk.cyan("Download from: https://github.com/code-yeongyu/senpi/releases/latest"));
	return { packageName: PACKAGE_NAME, installSpec: PACKAGE_NAME, version: VERSION, shouldRun: false };
}

async function getSelfUpdatePlan(force: boolean): Promise<SelfUpdatePlan> {
	const brandUpdate = brandProfile()?.update;
	if (brandUpdate) {
		console.log(chalk.yellow(`${APP_NAME} ships inside ${brandUpdate.packageName}. Update it with:`));
		console.log(chalk.cyan(`  ${brandUpdate.command}`));
		return {
			packageName: brandUpdate.packageName,
			installSpec: brandUpdate.command,
			version: DISPLAY_VERSION,
			shouldRun: false,
		};
	}

	let latestRelease: Awaited<ReturnType<typeof getLatestPiRelease>>;
	try {
		latestRelease = await getLatestPiRelease(VERSION, { retry: true });
	} catch (error: unknown) {
		try {
			return selfUpdatePlanAfterLookupFailure(detectInstallMethod(), formatVersionCheckError(error));
		} catch (planError: unknown) {
			throw planError instanceof Error ? Object.assign(planError, { cause: error }) : planError;
		}
	}
	if (!latestRelease) {
		return selfUpdatePlanAfterLookupFailure(detectInstallMethod(), "");
	}

	const packageName = latestRelease.packageName ?? PACKAGE_NAME;
	const installSpec = `${packageName}@${latestRelease.version}`;
	if (force || packageName !== PACKAGE_NAME || isNewerPackageVersion(latestRelease.version, VERSION)) {
		return {
			packageName,
			installSpec,
			version: latestRelease.version,
			...(latestRelease.note ? { note: latestRelease.note } : {}),
			shouldRun: true,
		};
	}

	console.log(chalk.green(`${APP_NAME} is already up to date (v${VERSION})`));
	return { packageName, installSpec, version: latestRelease.version, shouldRun: false };
}

async function runSelfUpdate(command: SelfUpdateCommand): Promise<void> {
	console.log(chalk.dim(`Updating ${APP_NAME} with ${command.display}...`));
	for (const step of command.steps ?? [command]) {
		await new Promise<void>((resolve, reject) => {
			const child = spawnProcess(step.command, step.args, {
				stdio: "inherit",
			});
			child.on("error", (error) => {
				reject(error);
			});
			child.on("close", (code, signal) => {
				if (code === 0) {
					resolve();
				} else if (signal) {
					reject(new Error(`${step.display} terminated by signal ${signal}`));
				} else {
					reject(new Error(`${step.display} exited with code ${code ?? "unknown"}`));
				}
			});
		});
	}
}

function prepareWindowsNpmSelfUpdate(): void {
	if (process.platform !== "win32") {
		return;
	}

	const packageDir = getInstallPackageDir();
	cleanupWindowsSelfUpdateQuarantine(packageDir);
	quarantineWindowsNativeDependencies(packageDir);
}

export interface PackageCommandRuntimeOptions {
	extensionFactories?: InlineExtension[];
}

function commandScope(runtimeOptions: PackageCommandRuntimeOptions): EngineCommandScope {
	const base = {
		cwd: process.cwd(),
		agentDir: getAgentDir(),
		extensionFactories: runtimeOptions.extensionFactories ?? [],
	};
	return { ...base, decideTrust: cliTrustDecider(base) };
}

function printProgressStart(event: ProgressEvent): void {
	if (event.type === "start") process.stdout.write(chalk.dim(`${event.message}\n`));
}

/** Prints the diagnostics, then the refusal or the success; a refusal sets exit code 1. */
function renderPackageResult<T>(result: EngineResult<T, PackageCommandCode>, onSuccess: (value: T) => void): boolean {
	renderEngineDiagnostics(result.diagnostics);
	if (result.kind === "ok") {
		onSuccess(result.value);
		return true;
	}
	console.error(chalk.red(result.error.code === "failed" ? `Error: ${result.error.message}` : result.error.message));
	process.exitCode = 1;
	return true;
}

function printPackageList(packages: readonly ConfiguredPackage[]): void {
	if (packages.length === 0) {
		console.log(chalk.dim("No packages installed."));
		return;
	}
	const userPackages = packages.filter((pkg) => pkg.scope === "user");
	const projectPackages = packages.filter((pkg) => pkg.scope === "project");
	const formatPackage = (pkg: ConfiguredPackage) => {
		console.log(`  ${pkg.filtered ? `${pkg.source} (filtered)` : pkg.source}`);
		if (pkg.installedPath) console.log(chalk.dim(`    ${pkg.installedPath}`));
	};
	if (userPackages.length > 0) {
		console.log(chalk.bold("User packages:"));
		for (const pkg of userPackages) formatPackage(pkg);
	}
	if (projectPackages.length > 0) {
		if (userPackages.length > 0) console.log();
		console.log(chalk.bold("Project packages:"));
		for (const pkg of projectPackages) formatPackage(pkg);
	}
}

export async function handleConfigCommand(
	args: string[],
	runtimeOptions: PackageCommandRuntimeOptions = {},
): Promise<boolean> {
	const [command, ...rest] = args;
	if (command !== "config") {
		return false;
	}

	if (rest.includes("-h") || rest.includes("--help")) {
		printConfigCommandHelp();
		return true;
	}
	if (rest[0] === CONFIG_IMPORT_PI_ARGV) {
		runConfigImportPi(rest.slice(1));
		return true;
	}

	let local = false;
	let projectTrustOverride: boolean | undefined;
	for (const arg of rest) {
		if (arg === "-l" || arg === "--local") {
			local = true;
		} else if (arg === "-a" || arg === "--approve") {
			projectTrustOverride = true;
		} else if (arg === "-na" || arg === "--no-approve") {
			projectTrustOverride = false;
		} else if (arg.startsWith("-")) {
			console.error(chalk.red(`Unknown option ${arg} for "config".`));
			console.error(chalk.dim(`Use "${APP_NAME} --help" or "${CONFIG_COMMAND_USAGE}".`));
			process.exitCode = 1;
			return true;
		} else {
			console.error(chalk.red(`Unexpected argument ${arg}.`));
			console.error(chalk.dim(`Usage: ${CONFIG_COMMAND_USAGE}`));
			process.exitCode = 1;
			return true;
		}
	}

	const scope = commandScope(runtimeOptions);
	const opened = await openResourceConfig(scope, {
		local,
		...(projectTrustOverride === undefined ? {} : { trust: projectTrustOverride }),
	});
	renderEngineDiagnostics(opened.diagnostics);
	if (opened.kind === "error") {
		console.error(chalk.red(opened.error.message));
		process.exitCode = 1;
		return true;
	}
	const { settingsManager, global, project, writeScope, projectModeAvailable } = opened.value;
	await selectConfig({
		resolvedPaths: { global, project },
		settingsManager,
		cwd: scope.cwd,
		agentDir: scope.agentDir,
		writeScope,
		projectModeAvailable,
	});

	process.exit(0);
}

/** `update` with the engine itself as a target (`--self`, `--all`, the default) or the local-update worker. */
async function runEngineUpdate(
	options: PackageCommandOptions,
	target: UpdateTarget,
	runtimeOptions: PackageCommandRuntimeOptions,
): Promise<boolean> {
	const scope = commandScope(runtimeOptions);
	const { agentDir } = scope;
	const opened = await openPackageManager(scope, {
		trust: savedProjectTrust(scope.cwd, agentDir, options.projectTrustOverride),
		writesProjectConfig: false,
		onProgress: printProgressStart,
	});
	if ("kind" in opened) return renderPackageResult(opened, () => {});
	renderEngineDiagnostics(opened.diagnostics);
	const { settingsManager } = opened;
	const selfUpdateNpmCommand = settingsManager.getGlobalSettings().npmCommand;

	try {
		// BETA(omo-local-update): remove this block, src/beta/omo-local-update*.ts and all test/omo-local-update* files to drop the feature.
		if (options.omoLocalUpdateWorker) {
			await runOmoLocalUpdateBeta({
				env: process.env,
				agentDir,
				settings: settingsManager.getGlobalSettings(),
				force: options.force,
				mode: "build",
			});
			return true;
		}
		if (options.showExtensionsSkippedNote) {
			await runOmoLocalUpdateBeta({
				env: process.env,
				agentDir,
				settings: settingsManager.getGlobalSettings(),
				force: options.force,
				mode: "dispatch",
			});
		}
		if (options.showExtensionsSkippedNote) {
			console.log(chalk.dim(`Extensions are skipped. Run ${APP_NAME} update --extensions to update extensions.`));
		}
		if (updateTargetIncludesExtensions(target)) {
			const updated = await runPackageStep(opened, updateStep(undefined));
			if (updated.kind === "error") {
				console.error(chalk.red(`Error: ${updated.error.message}`));
				process.exitCode = 1;
				return true;
			}
			console.log(chalk.green("Updated packages"));
		}
		if (updateTargetIncludesSelf(target)) {
			const managedInstallRoot = getActiveManagedInstallRoot();
			if (managedInstallRoot && options.force) {
				console.error(
					chalk.red(
						`Managed ${APP_NAME} installations do not support --force; rerun the installer to repair this installation.`,
					),
				);
				process.exitCode = 1;
				return true;
			}
			const selfUpdatePlan = await getSelfUpdatePlan(options.force);
			if (!selfUpdatePlan.shouldRun) {
				return true;
			}
			if (managedInstallRoot) {
				if (selfUpdatePlan.note) {
					printSelfUpdateNote(selfUpdatePlan.note);
				}
				try {
					console.log(chalk.dim(`Updating managed ${APP_NAME} installation...`));
					await runManagedSelfUpdate(managedInstallRoot, selfUpdatePlan.version);
				} catch (error: unknown) {
					const message = error instanceof Error ? error.message : "Unknown managed update error";
					console.error(chalk.red(`Error: ${message}`));
					process.exitCode = 1;
					return true;
				}
				console.log(chalk.green(`Updated ${APP_NAME} from ${VERSION} to ${selfUpdatePlan.version}`));
				return true;
			}

			const installMethod = detectInstallMethod();
			if (process.platform === "win32" && installMethod !== "npm" && installMethod !== "pnpm") {
				console.error(chalk.red(`${APP_NAME} self-update on Windows is only supported for npm and pnpm installs.`));
				console.error(chalk.dim(`Detected install method: ${installMethod}. Update ${APP_NAME} manually.`));
				process.exitCode = 1;
				return true;
			}
			const selfUpdateTarget = {
				packageName: selfUpdatePlan.packageName,
				installSpec: selfUpdatePlan.installSpec,
			};
			const selfUpdateCommand = getSelfUpdateCommand(PACKAGE_NAME, selfUpdateNpmCommand, selfUpdateTarget);
			if (!selfUpdateCommand) {
				printSelfUpdateUnavailable(selfUpdateNpmCommand, selfUpdateTarget);
				process.exitCode = 1;
				return true;
			}
			if (selfUpdatePlan.note) {
				printSelfUpdateNote(selfUpdatePlan.note);
			}
			try {
				if (installMethod === "npm") {
					prepareWindowsNpmSelfUpdate();
				}
				await runSelfUpdate(selfUpdateCommand);
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : "Unknown package command error";
				console.error(chalk.red(`Error: ${message}`));
				if (installMethod === "pnpm") {
					printPnpmSelfUpdateMetadataHint();
				}
				printSelfUpdateFallback(selfUpdateCommand);
				process.exitCode = 1;
				return true;
			}
			console.log(chalk.green(`Updated ${APP_NAME} from ${VERSION} to ${selfUpdatePlan.version}`));
		}
		return true;
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Unknown package command error";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
}

export async function handlePackageCommand(
	args: string[],
	runtimeOptions: PackageCommandRuntimeOptions = {},
): Promise<boolean> {
	const options = parsePackageCommand(args);
	if (!options) {
		return false;
	}

	if (options.help) {
		printPackageCommandHelp(options.command);
		return true;
	}

	if (options.invalidOption) {
		console.error(chalk.red(`Unknown option ${options.invalidOption} for "${options.command}".`));
		console.error(chalk.dim(`Use "${APP_NAME} --help" or "${getPackageCommandUsage(options.command)}".`));
		process.exitCode = 1;
		return true;
	}

	if (options.missingOptionValue) {
		console.error(chalk.red(`Missing value for ${options.missingOptionValue}.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	if (options.invalidArgument) {
		console.error(chalk.red(`Unexpected argument ${options.invalidArgument}.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	if (options.conflictingOptions) {
		console.error(chalk.red(options.conflictingOptions));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	const source = options.source;
	if ((options.command === "install" || options.command === "remove") && !source) {
		console.error(chalk.red(`Missing ${options.command} source.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	if (options.command === "update" && options.updateTarget?.type === "models") {
		const refreshed = await updateModelCatalogs({ agentDir: getAgentDir() });
		if (refreshed.kind === "ok") {
			console.log(chalk.green("Model catalogs refreshed"));
		} else {
			console.error(chalk.red(`Error: ${refreshed.error.message}`));
			process.exitCode = 1;
		}
		return true;
	}

	const trust = options.projectTrustOverride === undefined ? {} : { trust: options.projectTrustOverride };
	const progress = { onProgress: printProgressStart };
	switch (options.command) {
		case "install":
			return renderPackageResult(
				await installPackage(
					commandScope(runtimeOptions),
					{ source: source ?? "", local: options.local, ...trust },
					progress,
				),
				(value) => console.log(chalk.green(`Installed ${value.source}`)),
			);
		case "remove":
			return renderPackageResult(
				await removePackage(
					commandScope(runtimeOptions),
					{ source: source ?? "", local: options.local, ...trust },
					progress,
				),
				(value) => console.log(chalk.green(`Removed ${value.source}`)),
			);
		case "list":
			return renderPackageResult(await listPackages(commandScope(runtimeOptions), trust), (value) =>
				printPackageList(value.packages),
			);
		case "update": {
			const target = options.updateTarget ?? { type: "self" };
			if (options.omoLocalUpdateWorker || target.type !== "extensions") {
				return runEngineUpdate(options, target, runtimeOptions);
			}
			return renderPackageResult(
				await updatePackages(
					commandScope(runtimeOptions),
					{
						...(target.source === undefined ? {} : { source: target.source }),
						trust: savedProjectTrust(process.cwd(), getAgentDir(), options.projectTrustOverride),
					},
					progress,
				),
				(value) => console.log(chalk.green(value.source ? `Updated ${value.source}` : "Updated packages")),
			);
		}
	}
}
