import { mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ResolvedCodemodeSettings } from "../config/settings.ts";
import { withRootLock } from "./install-lock.ts";
import {
	absoluteSpec,
	type JsInstallerChoice,
	parseJsPackages,
	requestedPackageName,
	resolveJsInstaller,
	runJsInstall,
	withoutHostPaths,
} from "./js-installer.ts";
import { carryNpmrcSettings, recordedFileSpecs, seedPackageJson } from "./js-revision-files.ts";
import { assertBuiltRevisionLinks, assertNoLinksBelow, recordedInstallSources } from "./no-links.ts";
import { projectResolves } from "./project-resolves.ts";
import type { EnvironmentMode } from "./py-environment.ts";
import { EnvironmentError } from "./py-installer.ts";
import { mkdirPrivate, publishNextRevision, readActiveRevision } from "./revision-store.ts";

/** The paths in a revision that the installer writes. */
const INSTALLER_WRITES = [
	"package.json",
	"package-lock.json",
	"bun.lock",
	"bun.lockb",
	"node_modules",
	".npmrc",
	"bunfig.toml",
];

export interface JsInstallReceipt {
	readonly installer: "bun" | "npm";
	readonly mode: EnvironmentMode;
	readonly revision: number | undefined;
	readonly added: readonly string[];
	readonly shadowed: readonly string[];
}

export interface JsEnvironmentsOptions {
	readonly artifactsDir: string;
	readonly cwd: string;
	readonly runtime: string;
	readonly env: NodeJS.ProcessEnv;
	readonly settings: Pick<ResolvedCodemodeSettings, "environments">;
}

export class JsEnvironments {
	readonly #options: JsEnvironmentsOptions;
	#mode: EnvironmentMode = "managed";
	#packageRoot: string | undefined;

	constructor(options: JsEnvironmentsOptions) {
		this.#options = options;
	}

	get mode(): EnvironmentMode {
		return this.#mode;
	}

	get packageRoot(): string | undefined {
		return this.#mode === "managed" ? this.#packageRoot : undefined;
	}

	async setMode(mode: EnvironmentMode): Promise<string> {
		this.#mode = mode;
		if (mode === "project") return this.#options.cwd;
		this.#packageRoot = (await readActiveRevision(this.#managedBase()))?.dir;
		return this.#managedBase();
	}

	async install(
		requested: string,
		signal: AbortSignal,
		onOutput?: (stream: "stdout" | "stderr", data: string) => void,
		requestedInstaller?: "bun" | "npm",
	): Promise<JsInstallReceipt> {
		const environments = this.#options.settings.environments;
		if (environments?.autoProvision === false) {
			throw new EnvironmentError(
				"environment_installer_unavailable",
				"installs are turned off for this project (environments.autoProvision is false)",
			);
		}
		const packages = parseJsPackages(requested).map((spec) => absoluteSpec(spec, this.#options.cwd));
		// `%bun add` and `%npm add` name their installer; the setting applies only where the magic does not.
		const choice: JsInstallerChoice = requestedInstaller ?? environments?.js?.installer ?? "auto";
		const { installer, command } = resolveJsInstaller(choice, this.#options.env);
		let recordedSpecs: readonly string[] = [];
		const run = (root: string, remove?: string) =>
			runJsInstall({
				installer,
				command,
				root,
				packages,
				...(remove === undefined ? {} : { remove }),
				recordedSpecs,
				cwd: this.#options.cwd,
				env: this.#options.env,
				signal,
				...(onOutput === undefined ? {} : { onOutput }),
			});
		// The lock and the revision store fail with raw file system errors; they reach the cell redacted.
		const redacted =
			(...roots: string[]) =>
			(error: unknown) => {
				const raw =
					error instanceof EnvironmentError
						? error.message.slice(error.code.length + 2)
						: String(error instanceof Error ? error.message : error);
				const text = roots.reduce(
					(message, root) => withoutHostPaths(message, { root, cwd: this.#options.cwd, packages, recordedSpecs }),
					raw,
				);
				if (error instanceof EnvironmentError) throw new EnvironmentError(error.code, text);
				// An abort while waiting for the lock or before the publish is a cancel, not a failure.
				if (signal.aborted)
					throw new EnvironmentError("environment_install_cancelled", `the install was cancelled: ${text}`);
				throw new EnvironmentError("environment_install_failed", text);
			};
		if (this.#mode === "project") {
			const before = await dependencyNames(this.#options.cwd);
			const lockRoot = join(this.#options.cwd, ".senpi", "js-packages");
			await mkdir(lockRoot, { recursive: true });
			await withRootLock(lockRoot, async () => await run(this.#options.cwd), signal).catch(redacted(lockRoot));
			const added = (await dependencyNames(this.#options.cwd)).filter((name) => !before.includes(name));
			return { installer, mode: "project", revision: undefined, added, shadowed: [] };
		}
		let added: string[] = [];
		const requestedBase = this.#managedBase();
		const base = await canonicalBase(this.#managedRoot(), requestedBase).catch(redacted(requestedBase));
		const { revision } = await publishNextRevision(
			base,
			async (staging) => {
				await carryNpmrcSettings(staging);
				await rm(join(staging, "bunfig.toml"), { recursive: true, force: true });
				await seedPackageJson(staging);
				// Every path the installer writes must be the revision's own, never a link out of it.
				for (const entry of INSTALLER_WRITES) await assertNoLinksBelow(base, join(staging, entry));
				const before = await dependencyNames(staging);
				recordedSpecs = await recordedFileSpecs(staging);
				// A package whose source changes kind (a directory to a tarball or registry version, or back) is removed
				// first: bun keeps its per-file links into the old directory otherwise (#2758).
				for (const name of await sourceKindChanges(staging, packages)) await run(staging, name);
				await run(staging);
				await assertBuiltRevisionLinks(staging);
				added = (await dependencyNames(staging)).filter((name) => !before.includes(name));
			},
			signal,
		).catch(redacted(base, requestedBase));
		this.#packageRoot = revision.dir;
		const shadowed = added.filter((name) => projectResolves(this.#options.cwd, name));
		return { installer, mode: "managed", revision: revision.number, added, shadowed };
	}

	#managedRoot(): string {
		return this.#options.settings.environments?.managedRoot ?? this.#options.artifactsDir;
	}

	#managedBase(): string {
		return join(this.#managedRoot(), "environments", "js", this.#options.runtime);
	}
}

async function dependencyNames(root: string): Promise<string[]> {
	try {
		const manifest: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
		if (typeof manifest !== "object" || manifest === null || !("dependencies" in manifest)) return [];
		const dependencies = manifest.dependencies;
		return typeof dependencies === "object" && dependencies !== null ? Object.keys(dependencies) : [];
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
}

/**
 * Creates the managed base, checks that nothing below the managed root is a link, and returns its realpath: npm keys
 * a linked package in its lockfile by a path relative to the prefix, and a prefix under a linked directory (macOS
 * `/var` is a link to `/private/var`) gives keys that stop resolving once the staged revision is renamed.
 */
async function canonicalBase(managedRoot: string, base: string): Promise<string> {
	await assertNoLinksBelow(managedRoot, base);
	await mkdirPrivate(base);
	await assertNoLinksBelow(managedRoot, base);
	return await realpath(base);
}

/** Names among `packages` whose recorded source is a directory and is not the same directory now, or the reverse. */
export async function sourceKindChanges(revision: string, packages: readonly string[]): Promise<string[]> {
	const installed = new Set(await dependencyNames(revision));
	const sources = await recordedInstallSources(revision);
	const changed: string[] = [];
	for (const spec of packages) {
		const name = await requestedPackageName(spec);
		if (name === undefined || !installed.has(name)) continue;
		const directory = await localDirectory(spec);
		if (directory !== sources.get(name)) changed.push(name);
	}
	return changed;
}

async function localDirectory(spec: string): Promise<string | undefined> {
	const path = spec.startsWith("file:") ? spec.slice("file:".length) : spec;
	if (!isAbsolute(path)) return undefined;
	const resolved = await realpath(path).catch(() => undefined);
	return resolved !== undefined && (await stat(resolved)).isDirectory() ? resolved : undefined;
}
