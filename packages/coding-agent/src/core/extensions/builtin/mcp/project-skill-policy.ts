import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { getMcpGrantPresentation, selectMcpGrant } from "../../../mcp-grant-presentations.ts";
import { skillProjectRoot } from "../../../skill-access.ts";
import { hashConfig, normalizeServer } from "./config.ts";
import { plainMcpDeclaration, plainMcpServerConfig } from "./config-references.ts";
import type { McpServerConfig, McpServerDeclaredConfig, ResolvedMcpServer } from "./config-schema.ts";
import {
	addGrant,
	type DeclarationIdentity,
	declarationDigest,
	type GrantSnapshot,
	read,
	resolveGrantsStorePath,
} from "./env-grants-store.ts";
import { ConnectError } from "./errors.ts";
import { projectMcpEnvironment } from "./project-env.ts";
import type { McpSessionContext, McpSessionOptions } from "./service-types.ts";
import { inheritMcpSharingScope } from "./sharing-policy.ts";
import { parseSkillMcpDeclarations, type SkillServerRegistration } from "./skills.ts";

export interface ProjectMcpMaterialization {
	readonly config: McpServerConfig;
	readonly env: Record<string, string>;
	readonly grantedNames: readonly string[];
}
export interface ProjectMcpAuthority {
	readonly identity: string;
	readonly storePath: string;
	readonly policyDigest: string;
	readonly provenanceDigest: string;
	readonly initial: ProjectMcpMaterialization;
	resolve(signal: AbortSignal, allowDecision?: boolean): Promise<ProjectMcpMaterialization>;
}
const policies = new WeakMap<McpServerConfig | McpServerDeclaredConfig, ProjectMcpAuthority>();
const decisions = new Map<string, Promise<void>>();
export const getProjectMcpAuthority = (
	config: McpServerConfig | McpServerDeclaredConfig,
): ProjectMcpAuthority | undefined => policies.get(config);
export function effectiveGrantNames(snapshot: GrantSnapshot, identity: string): readonly string[] {
	return snapshot.grants[identity]?.names ?? [];
}
interface PolicyOwner {
	readonly context: McpSessionContext;
	readonly options: McpSessionOptions;
	readonly ui: () =>
		| { select: Parameters<typeof selectMcpGrant>[0]; notify?: (message: string, kind: "info" | "error") => void }
		| undefined;
	readonly notice: (identity: string, names: readonly string[]) => void;
}
function currentRegistration(name: string, declaration: SkillServerRegistration): SkillServerRegistration {
	if (declaration.skillPath === undefined) return declaration;
	const current = parseSkillMcpDeclarations([
		{
			name: declaration.skillName,
			filePath: declaration.skillPath,
			baseDir: dirname(declaration.skillPath),
			provenance: declaration.provenance,
			allowedSet: declaration.allowedSet,
			sourceInfo: declaration.scope === undefined ? undefined : { scope: declaration.scope },
		},
	]).servers.get(name);
	if (current !== undefined) return current;
	throw new ConnectError("Project MCP declaration is no longer available; reload its skills", {
		serverName: name,
		phase: "create",
		retriable: true,
	});
}
function identityFor(name: string, declaration: SkillServerRegistration, cwd: string): string {
	return declarationDigest({
		sourcePath: realpathSync.native(declaration.sourcePath),
		sourceKind: basename(declaration.sourcePath) === "mcp.json" ? "sidecar" : "frontmatter",
		projectRoot: realpathSync.native(declaration.provenance?.projectRoot ?? skillProjectRoot(cwd)),
		serverName: name,
		raw: declaration.raw,
		cwdBase: realpathSync.native(cwd),
	} satisfies DeclarationIdentity);
}
export async function prepareProjectSkillServer(
	name: string,
	original: SkillServerRegistration,
	owner: PolicyOwner,
	existing?: ResolvedMcpServer,
): Promise<ResolvedMcpServer> {
	const storePath = resolveGrantsStorePath(owner.options.agentDir);
	const trusted = owner.options.projectTrusted ?? owner.context.isProjectTrusted();
	let declaration = currentRegistration(name, original);
	let identity = identityFor(name, declaration, owner.context.cwd);
	const previous = existing?.config === undefined ? undefined : policies.get(existing.config);
	const provenanceDigest = declarationDigest({
		provenance: declaration.provenance,
		allowedSet: declaration.allowedSet?.digest,
	});
	if (
		previous?.identity === identity &&
		previous.storePath === storePath &&
		previous.provenanceDigest === provenanceDigest &&
		existing !== undefined
	) {
		const snapshot = await read(storePath);
		owner.notice(
			identity,
			projectMcpEnvironment(
				plainMcpDeclaration(name, declaration.raw),
				trusted,
				effectiveGrantNames(snapshot, identity),
				owner.options.env,
			).withheld,
		);
		return existing;
	}
	const project = declaration.provenance?.projectRoot ?? skillProjectRoot(owner.context.cwd);
	const select = () =>
		owner.context.mode === "tui"
			? owner.ui()?.select
			: getMcpGrantPresentation(owner.context.sessionManager?.getSessionId?.());
	const calculate = (raw: SkillServerRegistration["raw"], names: readonly string[]) =>
		projectMcpEnvironment(plainMcpDeclaration(name, raw), trusted, names, owner.options.env);
	const decide = async (current: SkillServerRegistration, digest: string, signal?: AbortSignal) => {
		const key = `${storePath}\0${digest}`;
		let pending = decisions.get(key);
		if (pending === undefined) {
			pending = (async () => {
				const snapshot = await read(storePath);
				const { withheld } = calculate(current.raw, effectiveGrantNames(snapshot, digest));
				if (withheld.length === 0 || signal?.aborted) return;
				owner.notice(digest, withheld);
				const granted = await selectMcpGrant(
					select(),
					`Project MCP server ${name} (skill ${current.skillName}) wants: ${withheld.join(", ")}`,
					signal,
				);
				if (!granted || signal?.aborted) return;
				const latest = currentRegistration(name, current);
				if (identityFor(name, latest, owner.context.cwd) !== digest) return;
				try {
					await addGrant(storePath, digest, { project, skill: current.skillName, server: name }, withheld);
					owner.ui()?.notify?.(`Saved MCP environment grant for ${name}: ${withheld.join(", ")}`, "info");
				} catch {
					owner
						.ui()
						?.notify?.(
							`Could not save MCP environment grant for ${name}; starting without ${withheld.join(", ")}`,
							"error",
						);
				}
			})();
			decisions.set(key, pending);
			void pending
				.finally(() => {
					if (decisions.get(key) === pending) decisions.delete(key);
				})
				.catch(() => {});
		}
		await pending;
	};
	for (;;) {
		await decide(declaration, identity);
		const latest = currentRegistration(name, declaration);
		const latestIdentity = identityFor(name, latest, owner.context.cwd);
		declaration = latest;
		if (latestIdentity === identity) break;
		identity = latestIdentity;
	}
	const snapshot = await read(storePath);
	const names = effectiveGrantNames(snapshot, identity);
	const materialize = (currentNames: readonly string[]): ProjectMcpMaterialization => {
		const policy = calculate(declaration.raw, currentNames);
		owner.notice(identity, policy.withheld);
		const config: McpServerConfig = {
			...plainMcpServerConfig(name, normalizeServer(policy.declaration)),
			env: {},
			directTools: [],
			exposure: "search",
		};
		if (config.type === "stdio") config.cwd = resolve(owner.context.cwd, config.cwd ?? ".");
		inheritMcpSharingScope(declaration.raw, config);
		return { config, env: policy.env, grantedNames: currentNames };
	};
	const initial = materialize(names);
	let first = true;
	const authority: ProjectMcpAuthority = {
		identity,
		storePath,
		initial,
		provenanceDigest: declarationDigest({
			provenance: declaration.provenance,
			allowedSet: declaration.allowedSet?.digest,
		}),
		policyDigest: declarationDigest({ names, generation: snapshot.generation }),
		resolve: async (signal, allowDecision = true) => {
			signal.throwIfAborted();
			const latest = currentRegistration(name, declaration);
			if (identityFor(name, latest, owner.context.cwd) !== identity) {
				throw new ConnectError("Project MCP declaration changed; reload its skills", {
					serverName: name,
					phase: "create",
					retriable: true,
				});
			}
			if (allowDecision) {
				if (!first) await decide(latest, identity, signal);
				first = false;
			}
			signal.throwIfAborted();
			const current = await read(storePath);
			signal.throwIfAborted();
			if (identityFor(name, currentRegistration(name, declaration), owner.context.cwd) !== identity) {
				throw new ConnectError("Project MCP declaration changed; reload its skills", {
					serverName: name,
					phase: "create",
					retriable: true,
				});
			}
			return materialize(effectiveGrantNames(current, identity));
		},
	};
	policies.set(initial.config, authority);
	return {
		name,
		source: "skill",
		sourcePath: declaration.sourcePath,
		config: initial.config,
		configHash: declarationDigest({
			config: hashConfig(initial.config),
			identity,
			policy: authority.policyDigest,
			provenance: authority.provenanceDigest,
		}),
		state: initial.config.enabled ? "enabled" : "disabled",
		transport: initial.config.type,
	};
}
