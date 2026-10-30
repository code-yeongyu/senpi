import { homedir } from "node:os";
import { existsSync, readdirSync, realpathSync, type Stats, statSync } from "fs";
import ignore from "ignore";
import { basename, dirname, join, relative, resolve, sep } from "path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import {
	authorizeSkillPath,
	BlockedSkillLinkError,
	buildSkillAllowedSet,
	insideSkillRoot,
	readSkillFileCheckedSync,
	type SkillAllowedSet,
	type SkillProvenance,
	skillProjectRoot,
} from "./skill-access.ts";
import { addIgnoreRules, shouldSkipSkillWalkDirectoryName } from "./skill-discovery.ts";
import { readUserSkillSource } from "./skill-source-cache.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";

export { formatSkillsForPrompt } from "./skills-prompt.ts";

/** Max name length per spec */
const MAX_NAME_LENGTH = 64;

/** Max description length per spec */
const MAX_DESCRIPTION_LENGTH = 1024;

type IgnoreMatcher = ReturnType<typeof ignore>;

function toPosixPath(p: string): string {
	return p.split(sep).join("/");
}

export interface SkillFrontmatter {
	name?: string;
	description?: string;
	"disable-model-invocation"?: boolean;
	"argument-hint"?: string;
	"requires-arguments"?: boolean;
	[key: string]: unknown;
}

export interface Skill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	sourceInfo: SourceInfo;
	disableModelInvocation: boolean;
	/** Usage hint from the `argument-hint` frontmatter. */
	argumentHint?: string;
	/** `requires-arguments` frontmatter; defaults to true when a hint is declared, else false. */
	requiresArguments?: boolean;
	/** Root authority is retained for invocation and sidecar reads. */
	provenance?: SkillProvenance;
	allowedSet?: SkillAllowedSet;
}

export interface LoadSkillsResult {
	skills: Skill[];
	diagnostics: ResourceDiagnostic[];
}

/**
 * Validate skill name per Agent Skills spec.
 * Returns array of validation error messages (empty if valid).
 */
function validateName(name: string): string[] {
	const errors: string[] = [];

	if (name.length > MAX_NAME_LENGTH) {
		errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	}

	if (!/^[a-z0-9-]+$/.test(name)) {
		errors.push(`name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)`);
	}

	if (name.startsWith("-") || name.endsWith("-")) {
		errors.push(`name must not start or end with a hyphen`);
	}

	if (name.includes("--")) {
		errors.push(`name must not contain consecutive hyphens`);
	}

	return errors;
}

/**
 * Validate description per Agent Skills spec.
 */
function validateDescription(description: unknown): string[] {
	const errors: string[] = [];

	if (typeof description !== "string" || description.trim() === "") {
		errors.push("description is required");
	} else if (description.length > MAX_DESCRIPTION_LENGTH) {
		errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
	}

	return errors;
}

export interface LoadSkillsFromDirOptions {
	/** Directory to scan for skills */
	dir: string;
	/** Source identifier for these skills */
	source: string;
	provenance?: SkillProvenance;
	allowedSet?: SkillAllowedSet;
}

function createSkillSourceInfo(filePath: string, baseDir: string, source: string): SourceInfo {
	switch (source) {
		case "user":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "user",
				baseDir,
			});
		case "project":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "project",
				baseDir,
			});
		case "path":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				baseDir,
			});
		default:
			return createSyntheticSourceInfo(filePath, { source, baseDir });
	}
}

/**
 * Load skills from a directory.
 *
 * Discovery rules:
 * - if a directory contains SKILL.md, treat it as a skill root and do not recurse further
 * - otherwise, load direct .md children in the root
 * - recurse into subdirectories to find SKILL.md
 */
export function loadSkillsFromDir(options: LoadSkillsFromDirOptions): LoadSkillsResult {
	const { dir, source } = options;
	const provenance = options.provenance ?? {
		kind: source === "project" ? "project-auto" : "user",
		selectedRoot: dir,
		projectRoot: skillProjectRoot(dir),
	};
	return loadSkillsFromDirInternal(dir, source, true, undefined, undefined, provenance, options.allowedSet);
}

function loadSkillsFromDirInternal(
	dir: string,
	source: string,
	includeRootFiles: boolean,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
	provenance?: SkillProvenance,
	allowedSet?: SkillAllowedSet,
	ancestry: ReadonlySet<string> = new Set(),
): LoadSkillsResult {
	const skills: Skill[] = [];
	const diagnostics: ResourceDiagnostic[] = [];

	if (!existsSync(dir)) {
		return { skills, diagnostics };
	}
	let canonical: string;
	try {
		authorizeSkillPath(dir, provenance, allowedSet, true);
		canonical = realpathSync.native(dir);
	} catch (error) {
		if (error instanceof BlockedSkillLinkError) return { skills, diagnostics: [error.diagnostic] };
		canonical = resolve(dir);
	}
	if (ancestry.has(canonical)) return { skills, diagnostics };
	const descendants = new Set(ancestry);
	descendants.add(canonical);

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();

	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		addIgnoreRules(ig, dir, root, entries);

		for (const entry of entries) {
			if (entry.name !== "SKILL.md") {
				continue;
			}

			const fullPath = join(dir, entry.name);

			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			if (!isFile || ig.ignores(relPath)) {
				continue;
			}

			const result = loadSkillFromFile(fullPath, source, provenance, allowedSet);
			if (result.skill) {
				skills.push(result.skill);
			}
			diagnostics.push(...result.diagnostics);
			return { skills, diagnostics };
		}

		for (const entry of entries) {
			if (shouldSkipSkillWalkDirectoryName(entry.name)) {
				continue;
			}

			const fullPath = join(dir, entry.name);

			// For symlinks, check if they point to a directory and follow them
			let isDirectory = entry.isDirectory();
			let isFile = entry.isFile();
			const isLink = entry.isSymbolicLink();
			if (isLink) {
				try {
					const stats = statSync(fullPath);
					isDirectory = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					// Broken symlink, skip it
					continue;
				}
			}

			// A linked directory gets its own ignore context, as in collectSkillEntries (senpi#5060).
			const linkedDirectory = isLink && isDirectory;
			const relPath = toPosixPath(relative(root, fullPath));
			const ignorePath = isDirectory ? `${relPath}/` : relPath;
			if (!linkedDirectory && ig.ignores(ignorePath)) {
				continue;
			}

			if (isDirectory) {
				const subResult = loadSkillsFromDirInternal(
					fullPath,
					source,
					false,
					linkedDirectory ? ignore() : ig,
					root,
					provenance,
					allowedSet,
					descendants,
				);
				skills.push(...subResult.skills);
				diagnostics.push(...subResult.diagnostics);
				continue;
			}

			if (!isFile || !includeRootFiles || !entry.name.endsWith(".md")) {
				continue;
			}

			const result = loadSkillFromFile(fullPath, source, provenance, allowedSet);
			if (result.skill) {
				skills.push(result.skill);
			}
			diagnostics.push(...result.diagnostics);
		}
	} catch {}

	return { skills, diagnostics };
}

function loadSkillFromFile(
	filePath: string,
	source: string,
	provenance?: SkillProvenance,
	allowedSet?: SkillAllowedSet,
	stats?: Stats,
): { skill: Skill | null; diagnostics: ResourceDiagnostic[] } {
	const diagnostics: ResourceDiagnostic[] = [];
	const isDeclaredSkill = basename(filePath) === "SKILL.md";

	let rawContent: string;
	try {
		rawContent =
			provenance === undefined || provenance.kind === "user"
				? readUserSkillSource(filePath, stats ?? statSync(filePath))
				: readSkillFileCheckedSync(filePath, provenance, allowedSet);
	} catch (error) {
		if (error instanceof BlockedSkillLinkError) return { skill: null, diagnostics: [error.diagnostic] };
		const message = error instanceof Error ? error.message : "failed to read skill file";
		diagnostics.push({ type: "warning", message, path: filePath });
		return { skill: null, diagnostics };
	}

	let frontmatter: SkillFrontmatter;
	try {
		({ frontmatter } = parseFrontmatter<SkillFrontmatter>(rawContent));
	} catch (error) {
		if (isDeclaredSkill) {
			const message = error instanceof Error ? error.message : "failed to parse skill file";
			diagnostics.push({ type: "warning", message, path: filePath });
		}
		return { skill: null, diagnostics };
	}

	const description = frontmatter.description;
	const hasDescription = typeof description === "string" && description.trim() !== "";
	if (!isDeclaredSkill && !hasDescription) {
		return { skill: null, diagnostics };
	}

	const skillDir = dirname(filePath);
	const parentDirName = basename(skillDir);

	// Validate description
	const descErrors = validateDescription(description);
	for (const error of descErrors) {
		diagnostics.push({ type: "warning", message: error, path: filePath });
	}

	// Use name from frontmatter, or fall back to parent directory name
	const frontmatterName = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
	const name = frontmatterName || parentDirName;

	// Validate name
	const nameErrors = validateName(name);
	for (const error of nameErrors) {
		diagnostics.push({ type: "warning", message: error, path: filePath });
	}

	// Still load the skill even with warnings, unless description is missing or empty.
	if (!hasDescription) {
		return { skill: null, diagnostics };
	}
	const argumentHint = frontmatter["argument-hint"];
	const hasArgumentHint = typeof argumentHint === "string" && argumentHint.trim() !== "";
	const requiresArguments = frontmatter["requires-arguments"];

	return {
		skill: {
			name,
			provenance,
			allowedSet,
			description,
			filePath,
			baseDir: skillDir,
			sourceInfo: createSkillSourceInfo(filePath, skillDir, source),
			disableModelInvocation: frontmatter["disable-model-invocation"] === true,
			requiresArguments: typeof requiresArguments === "boolean" ? requiresArguments : hasArgumentHint,
			...(hasArgumentHint && { argumentHint: argumentHint.trim() }),
		},
		diagnostics,
	};
}

export interface LoadSkillsOptions {
	/** Working directory for project-local skills. */
	cwd: string;
	/** Agent config directory for global skills. Default: ~/.senpi/agent */
	agentDir: string;
	/** Explicit skill paths (files or directories) */
	skillPaths: string[];
	/** Include default skills directories. */
	includeDefaults: boolean;
	provenanceByPath?: ReadonlyMap<string, SkillProvenance>;
	userSkillRoots?: readonly string[];
}

/**
 * Load skills from all configured locations.
 * Returns skills and any validation diagnostics.
 */
export function loadSkills(options: LoadSkillsOptions): LoadSkillsResult {
	const { agentDir, skillPaths, includeDefaults } = options;

	// Resolve agentDir - if not provided, use default from config
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(agentDir ?? getAgentDir());
	const projectRoot = skillProjectRoot(resolvedCwd);
	const projectSkillsPath = resolve(resolvedCwd, CONFIG_DIR_NAME, "skills");
	const allowedSet = buildSkillAllowedSet([
		join(resolvedAgentDir, "skills"),
		join(homedir(), ".agents", "skills"),
		...(options.userSkillRoots ?? []),
		...skillPaths
			.map((path) => resolvePath(path, resolvedCwd, { trim: true }))
			.filter((path) => {
				const provenance = options.provenanceByPath?.get(path);
				return (
					provenance?.kind === "user" ||
					(provenance === undefined && (includeDefaults || !insideSkillRoot(path, projectSkillsPath)))
				);
			}),
	]);

	const skillMap = new Map<string, Skill>();
	const realPathSet = new Set<string>();
	const allDiagnostics: ResourceDiagnostic[] = [];
	const collisionDiagnostics: ResourceDiagnostic[] = [];

	function addSkills(result: LoadSkillsResult) {
		allDiagnostics.push(...result.diagnostics);
		for (const skill of result.skills) {
			// Resolve symlinks to detect duplicate files
			const realPath = canonicalizePath(skill.filePath);

			// Skip silently if we've already loaded this exact file (via symlink)
			if (realPathSet.has(realPath)) {
				continue;
			}

			const existing = skillMap.get(skill.name);
			if (existing) {
				collisionDiagnostics.push({
					type: "collision",
					message: `name "${skill.name}" collision`,
					path: skill.filePath,
					collision: {
						resourceType: "skill",
						name: skill.name,
						winnerPath: existing.filePath,
						loserPath: skill.filePath,
					},
				});
			} else {
				skillMap.set(skill.name, skill);
				realPathSet.add(realPath);
			}
		}
	}

	if (includeDefaults) {
		const userRoot = join(resolvedAgentDir, "skills");
		addSkills(
			loadSkillsFromDirInternal(
				userRoot,
				"user",
				true,
				undefined,
				undefined,
				{ kind: "user", selectedRoot: userRoot },
				allowedSet,
			),
		);
		addSkills(
			loadSkillsFromDirInternal(
				projectSkillsPath,
				"project",
				true,
				undefined,
				undefined,
				{ kind: "project-auto", selectedRoot: projectSkillsPath, projectRoot },
				allowedSet,
			),
		);
	}

	const userSkillsDir = join(resolvedAgentDir, "skills");
	const projectSkillsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "skills");

	const isUnderPath = (target: string, root: string): boolean => {
		const normalizedRoot = resolve(root);
		if (target === normalizedRoot) {
			return true;
		}
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		return target.startsWith(prefix);
	};

	const getSource = (resolvedPath: string): "user" | "project" | "path" => {
		if (!includeDefaults) {
			if (isUnderPath(resolvedPath, userSkillsDir)) return "user";
			if (isUnderPath(resolvedPath, projectSkillsDir)) return "project";
		}
		return "path";
	};

	for (const rawPath of skillPaths) {
		const resolvedPath = resolvePath(rawPath, resolvedCwd, { trim: true });
		let stats: Stats;
		try {
			stats = statSync(resolvedPath);
		} catch {
			allDiagnostics.push({ type: "warning", message: "skill path does not exist", path: resolvedPath });
			continue;
		}

		try {
			const source = getSource(resolvedPath);
			const provenance = options.provenanceByPath?.get(resolvedPath) ?? {
				kind: source === "project" ? ("project-auto" as const) : ("user" as const),
				selectedRoot: resolvedPath,
				projectRoot,
			};
			if (stats.isDirectory()) {
				addSkills(
					loadSkillsFromDirInternal(resolvedPath, source, true, undefined, undefined, provenance, allowedSet),
				);
			} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
				const result = loadSkillFromFile(resolvedPath, source, provenance, allowedSet, stats);
				if (result.skill) {
					addSkills({ skills: [result.skill], diagnostics: result.diagnostics });
				} else {
					allDiagnostics.push(...result.diagnostics);
				}
			} else {
				allDiagnostics.push({ type: "warning", message: "skill path is not a markdown file", path: resolvedPath });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to read skill path";
			allDiagnostics.push({ type: "warning", message, path: resolvedPath });
		}
	}

	return {
		skills: Array.from(skillMap.values()),
		diagnostics: [...allDiagnostics, ...collisionDiagnostics],
	};
}
