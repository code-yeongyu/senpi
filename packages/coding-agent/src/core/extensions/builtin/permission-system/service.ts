import { decideTarget, type Decision, type DecisionOptions } from "./decide-target.ts";
import { createLocalEventEmitter, type PermissionEventEmitter } from "./events.ts";
import { decideExternalPaths } from "./external-spellings.ts";
import {
	type IdentityContext,
	type IdentityInput,
	identityMatcher,
	identityWanted,
	type KernelCanonical,
	pathRulesOf,
	prepareIdentity,
} from "./identity-decision.ts";
import type { IdentityMatcher } from "./evaluate.ts";
import { createMountRewrite, readFirmlinks } from "./alias-detector.ts";
import type { PathIdentityResolver } from "./path-identity-host.ts";
import { PendingRequests } from "./pending-requests.ts";
import { RuleIdentityCache, type RuleIdentityEntry } from "./rule-identity-cache.ts";
import { approvedFileVersion, approvedStoreRealPath, loadApproved } from "./storage.ts";
import {
	DeniedError,
	type PermissionPresetName,
	type ReplyInput,
	type Request,
	type Rule,
	type Ruleset,
} from "./types.ts";

export type { IdentityInput, KernelCanonical } from "./identity-decision.ts";

type RequestInput = Omit<Request, "id"> & { id?: string };

/** Classes whose non-deny decision may have mutated the filesystem (M3): everything but the read-only ones. */
const READ_ONLY_PERMISSIONS: ReadonlySet<string> = new Set(["read", "list", "grep", "external_directory", "eval"]);

function uniq(values: readonly string[]): string[] {
	return [...new Set(values)];
}

/** Core service for managing permission requests and rule evaluation */
export class PermissionService {
	private readonly pendingRequests: PendingRequests;
	private approved: Ruleset;
	private staticRuleset: Ruleset;
	private emitter: PermissionEventEmitter;
	private idCounter = 0;

	constructor(
		staticRuleset: Ruleset,
		approved: Ruleset,
		emitter: PermissionEventEmitter = createLocalEventEmitter(),
		preset?: PermissionPresetName,
		projectDir?: string,
		agentDir?: string,
		resolver?: PathIdentityResolver,
	) {
		this.staticRuleset = [...staticRuleset];
		this.approved = [...approved];
		this.emitter = emitter;
		this.preset = preset;
		this.resolver = resolver;
		this.mountRewrite = createMountRewrite(readFirmlinks());
		// The resolver is shared by every session of the process and outlives this service, so the
		// subscription is released by dispose(); an unreleased one keeps the service's emitter and
		// its extension generation reachable across every reload.
		this.releaseResolverState = resolver?.onState((event) => this.emitter.emitResolverState(event)) ?? (() => {});
		this.ruleIdentities = new RuleIdentityCache(resolver, projectDir, () => this.pathRules(), emitter);
		this.ruleIdentities.fillAll();
		this.pendingRequests = new PendingRequests({
			emitter,
			approve: (rule) => this.approved.push(rule),
			decide: (permission, pattern, options) => this.decide(permission, pattern, options),
		});
		// The approved rules this service was seeded with are the persisted prefix; anything after
		// is this session's own (unsaved or just-saved) answers and survives a re-read.
		this.persistedApprovedCount = approved.length;
		this.projectDir = projectDir;
		this.agentDir = agentDir;
		this.protectedStorePath =
			agentDir !== undefined && projectDir !== undefined ? approvedStoreRealPath(agentDir, projectDir) : undefined;
		this.approvedVersion =
			agentDir === undefined || projectDir === undefined ? undefined : approvedFileVersion(agentDir, projectDir);
	}

	private readonly preset?: PermissionPresetName;
	private readonly projectDir?: string;
	private readonly agentDir?: string;
	private readonly protectedStorePath?: string;
	private persistedApprovedCount: number;
	private approvedVersion: string | undefined;
	private readonly resolver?: PathIdentityResolver;
	private readonly mountRewrite: (value: string) => string;
	private readonly ruleIdentities: RuleIdentityCache;
	private readonly releaseResolverState: () => void;

	/** Stops forwarding resolver state to this service's emitter; decisions keep working. */
	dispose(): void {
		this.releaseResolverState();
	}

	identityWanted(permission: string, kernel?: KernelCanonical): boolean {
		return identityWanted(this.resolver, [...this.staticRuleset, ...this.approved], permission, kernel);
	}

	private pathRules(): Rule[] {
		return pathRulesOf([...this.staticRuleset, ...this.approved]);
	}

	ruleIdentityState(pattern: string): RuleIdentityEntry {
		return this.ruleIdentities.stateOf(pattern);
	}

	ruleAliasBearing(pattern: string): boolean {
		return this.ruleIdentities.aliasBearing(pattern);
	}

	noteMutation(mutated?: string): void {
		this.ruleIdentities.noteMutation(mutated);
	}

	identitySettled(): Promise<void> {
		return this.ruleIdentities.settled();
	}

	prepareIdentity(
		permission: string,
		executed: readonly string[],
		cwd?: string,
		kernel?: KernelCanonical,
	): IdentityInput | Promise<IdentityInput> {
		return prepareIdentity(this.identityContext, permission, executed, cwd, kernel);
	}

	private get identityContext(): IdentityContext {
		return {
			resolver: this.resolver,
			cache: this.ruleIdentities,
			mountRewrite: this.mountRewrite,
			identityWanted: (candidate, kernel) => this.identityWanted(candidate, kernel),
		};
	}

	/** Identity inputs by request id, so a refusal can name the layer of an identity-matched deny. */
	private readonly requestIdentities = new Map<string, IdentityInput>();

	requestIdentity(requestID: string): IdentityInput | undefined {
		return this.requestIdentities.get(requestID);
	}

	identityMatcher(permission: string, identity: IdentityInput | undefined): IdentityMatcher | undefined {
		const unavailable = this.resolver?.unavailable !== undefined;
		return identityMatcher(this.ruleIdentities, permission, identity, this.mountRewrite, unavailable);
	}

	/**
	 * An "Always" answer another open session just persisted is honored on this session's very next
	 * decision (senpi#2465): the approved store is re-read only when its mtime+size changed, and the
	 * re-read replaces the persisted prefix while keeping this session's own answers.
	 */
	private refreshApproved(): void {
		if (this.projectDir === undefined || this.agentDir === undefined) return;
		const version = approvedFileVersion(this.agentDir, this.projectDir);
		if (version === this.approvedVersion) return;
		const fresh = loadApproved(this.agentDir, this.projectDir);
		this.approved = [...fresh, ...this.approved.slice(this.persistedApprovedCount)];
		this.persistedApprovedCount = fresh.length;
		this.approvedVersion = version;
	}

	/**
	 * The one decision for a call, used when it is asked and again whenever an "Always" reply re-checks
	 * the requests still pending. External paths use last-match-wins separately for the absolute
	 * lexical path, physical-prefix spellings from the component walk and their proven on-disk case; the most restrictive
	 * decision wins (deny > ask > allow). More than 16 spellings or 40 hops asks instead.
	 * Raw originalPaths are display-only. Remembered approvals
	 * match the resolved target and cannot override a deny from any spelling.
	 * Without `presetBound` it is last-match-wins over every rule. With
	 * `presetBound` the preset's rules and the user's settings and CLI rules are evaluated apart and
	 * the more restrictive wins, so no configured rule, in any order or layer, can widen the preset;
	 * only an "Always" answer given in this or an earlier session (`permissions-approved.jsonl`,
	 * explicit consent for that pattern) can then turn a remaining ask into allow.
	 */
	private decide(permission: string, target: string | readonly string[], options: DecisionOptions): Rule["action"] {
		return this.dispatchDecision(permission, target, options).action;
	}

	/** Share the decision and its relevant rules with the final dispatch fence. */
	dispatchDecision(permission: string, target: string | readonly string[], options: DecisionOptions = {}): Decision {
		this.refreshApproved();
		if (permission === "external_directory") {
			return decideExternalPaths(target, options.ruleAliases ?? [], (spelling, resolved, canonicalCase) =>
				this.decideTarget(permission, spelling, options, resolved, spelling !== resolved, canonicalCase),
			);
		}
		return this.decideTarget(permission, options.ruleAliases ?? target, options);
	}

	private decideTarget(
		permission: string,
		target: string | readonly string[],
		options: DecisionOptions,
		approvedTarget = target,
		preserveAncestry = false,
		canonicalCase?: (value: string) => string,
	): Decision {
		const context = {
			staticRuleset: this.staticRuleset,
			approved: this.approved,
			preset: this.preset,
			protectedStorePath: this.protectedStorePath,
			identityMatcher: (candidate: string, identity: IdentityInput | undefined) =>
				this.identityMatcher(candidate, identity),
		};
		return decideTarget(context, permission, target, options, approvedTarget, preserveAncestry, canonicalCase);
	}

	/** Request permission for a tool call. Resolves if allowed, throws on denial. */
	async ask(
		request: RequestInput,
		{
			autoApproveAsk = false,
			approveBlanketAsk = false,
			presetBound = false,
			ruleAliases,
			executed,
		}: {
			readonly autoApproveAsk?: boolean;
			readonly approveBlanketAsk?: boolean;
			/**
			 * Decide as the more restrictive of the preset's decision and the user's (deny > ask > allow),
			 * so no user rule, in any order or layer, can widen the preset.
			 */
			readonly presetBound?: boolean;
			readonly ruleAliases?: readonly string[];
			/** The strings the tool opens (design 6.2): matched literally as aliases and by identity. */
			readonly executed?: readonly string[];
		} = {},
	): Promise<void> {
		const info: Request = {
			...request,
			id: request.id ?? this.nextRequestID(),
		};

		const deniedPatterns: string[] = [];
		let needsAsk = false;

		// The identity route is taken only with a path-class rule present (R3-H2); every resolver failure
		// becomes `unresolvable` here and never a thrown error. Executed strings travel as ruleAliases only,
		// so the written pattern stays the displayed and denied one (N8, N9).
		let identity: IdentityInput | undefined;
		if (executed && executed.length > 0 && this.identityWanted(info.permission)) {
			try {
				identity = await this.prepareIdentity(info.permission, executed, this.projectDir);
			} catch (error) {
				identity = { canonical: [], unresolvable: (error as { code?: string }).code ?? "EUNKNOWN" };
			}
		}
		if (identity) this.requestIdentities.set(info.id, identity);
		const options: DecisionOptions = {
			approveBlanketAsk,
			presetBound,
			ruleAliases,
			originalPaths: info.originalPaths,
			...(identity ? { identity } : {}),
		};
		for (const pattern of info.patterns) {
			const aliases =
				executed && executed.length > 0 ? uniq([...(ruleAliases ?? [pattern]), ...executed]) : ruleAliases;
			const action = this.decide(info.permission, pattern, { ...options, ruleAliases: aliases });
			if (action === "deny") {
				deniedPatterns.push(pattern);
				continue;
			}
			if (action === "ask" && !autoApproveAsk) {
				needsAsk = true;
			}
		}

		if (deniedPatterns.length > 0) {
			this.requestIdentities.delete(info.id);
			throw new DeniedError(deniedPatterns, identity);
		}

		if (!READ_ONLY_PERMISSIONS.has(info.permission)) {
			if (executed && executed.length > 0) for (const value of executed) this.noteMutation(value);
			else this.noteMutation();
		}

		if (!needsAsk) {
			this.requestIdentities.delete(info.id);
			this.emitter.emitReplied(info.id, info.sessionID, "allow");
			return;
		}

		const pendingPromise = this.pendingRequests
			.register(info, options)
			.finally(() => this.requestIdentities.delete(info.id));

		this.emitter.emitAsked(info);

		await pendingPromise;
	}

	/** Reply to a pending permission request */
	reply(input: ReplyInput): void {
		this.pendingRequests.reply(input);
	}

	/** List all pending permission requests */
	list(): Request[] {
		return this.pendingRequests.list();
	}

	/** Get the current approved ruleset */
	getApproved(): Ruleset {
		return this.approved.map((rule) => ({ ...rule }));
	}

	/**
	 * This session's own approved rules (its answers), identified by permission+pattern+action, not
	 * by index: a refresh that grows or shrinks the persisted prefix never duplicates or drops them.
	 */
	getSessionApproved(): Ruleset {
		return this.approved.slice(this.persistedApprovedCount).map((rule) => ({ ...rule }));
	}

	private nextRequestID(): string {
		this.idCounter += 1;
		return `permission-${this.idCounter}`;
	}
}
