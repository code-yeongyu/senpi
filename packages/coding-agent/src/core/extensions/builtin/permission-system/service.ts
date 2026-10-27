import * as fs from "node:fs";
import * as path from "node:path";
import { isPresetRule } from "./config.ts";
import { evaluate, evaluateExternalSpelling } from "./evaluate.ts";
import { createLocalEventEmitter, type PermissionEventEmitter } from "./events.ts";
import { decideExternalPaths } from "./external-spellings.ts";
import { approvedFileVersion, approvedStoreRealPath, loadApproved } from "./storage.ts";
import {
	CorrectedError,
	DeniedError,
	type PendingEntry,
	type PermissionPresetName,
	RejectedError,
	type ReplyInput,
	type Request,
	type Rule,
	type Ruleset,
} from "./types.ts";

type RequestInput = Omit<Request, "id"> & { id?: string };

interface DecisionOptions {
	readonly approveBlanketAsk?: boolean;
	readonly presetBound?: boolean;
	readonly ruleAliases?: readonly string[] | undefined;
	readonly originalPaths?: readonly string[] | undefined;
}

/** Core service for managing permission requests and rule evaluation */
export class PermissionService {
	private pending = new Map<string, PendingEntry>();
	/** How each pending request was decided, so a re-check after an "Always" reply decides it the same way. */
	private pendingOptions = new Map<string, DecisionOptions>();
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
	) {
		this.staticRuleset = [...staticRuleset];
		this.approved = [...approved];
		this.emitter = emitter;
		this.preset = preset;
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

	/** deny > ask > allow. */
	private static readonly RESTRICTIVENESS: Readonly<Record<Rule["action"], number>> = { allow: 0, ask: 1, deny: 2 };

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
	dispatchDecision(
		permission: string,
		target: string | readonly string[],
		options: DecisionOptions = {},
	): { readonly action: Rule["action"]; readonly rules: readonly Rule[] } {
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
	): { readonly action: Rule["action"]; readonly rules: readonly Rule[] } {
		const evaluateTarget = (ruleset: Ruleset) =>
			preserveAncestry
				? evaluateExternalSpelling(target, ruleset, canonicalCase)
				: evaluate(permission, target, ruleset);
		// Defence in depth (HIGH 1): the agent's own tools never touch the approvals store, whatever
		// rules say. The target's real path is compared against the store's real path.
		if (this.protectedStorePath !== undefined && this.targetIsProtectedStore(target)) {
			return { action: "deny", rules: [{ permission, pattern: "*", action: "deny" }] };
		}
		if (!options.presetBound) {
			// HIGH 2: a configured (settings/CLI) decision outranks the preset's wildcard and any
			// approval. Evaluate the user's rules with their own last-match order; when the user's
			// decision is a deny it wins outright, and a preset wildcard-ask never masks it. The preset
			// only fills the gap the user left (no user rule matched, or the user decision is an ask).
			const userRules = this.staticRuleset.filter((rule) => !isPresetRule(rule));
			const userRule = evaluateTarget(userRules);
			if (userRules.includes(userRule) && userRule.action === "deny") {
				return { action: "deny", rules: [{ ...userRule }] };
			}
			const configured = evaluateTarget(this.staticRuleset);
			if (configured.action === "deny") return { action: "deny", rules: [{ ...configured }] };
			const approvedRule = evaluate(permission, approvedTarget, this.approved);
			if (this.approved.includes(approvedRule) && approvedRule.action === "allow") {
				return { action: "allow", rules: [{ ...approvedRule }] };
			}
			// Full access means no prompts: a settings/CLI ask collapses to allow here, while a deny
			// stays denied. This is the one dedicated full-access decision (senpi#2465).
			const action = this.preset === "full-access" && configured.action === "ask" ? "allow" : configured.action;
			return { action, rules: [{ ...configured }] };
		}
		const presetRules = this.staticRuleset.filter((rule) => isPresetRule(rule));
		const userRules = this.staticRuleset.filter((rule) => !isPresetRule(rule));
		const presetRule = evaluateTarget(presetRules);
		const preset = presetRule.action === "ask" && options.approveBlanketAsk ? "allow" : presetRule.action;
		const userRule = evaluateTarget(userRules);
		const user = userRules.includes(userRule) ? userRule.action : undefined;
		const combined =
			user === undefined || PermissionService.RESTRICTIVENESS[preset] >= PermissionService.RESTRICTIVENESS[user]
				? preset
				: user;
		const rules = [presetRule, ...(user === undefined ? [] : [userRule])].map((rule) => ({ ...rule }));
		if (combined !== "ask") return { action: combined, rules };
		const remembered = evaluate(permission, approvedTarget, this.approved);
		if (this.approved.includes(remembered) && remembered.action === "allow") {
			return { action: "allow", rules: [...rules, { ...remembered }] };
		}
		return { action: "ask", rules };
	}

	/** True when any target path resolves (real path, case-folded on macOS) to the approvals store. */
	private targetIsProtectedStore(target: string | readonly string[]): boolean {
		const store = this.protectedStorePath;
		if (store === undefined) return false;
		const targets = typeof target === "string" ? [target] : target;
		for (const value of targets) {
			const resolved = this.canonicalForCompare(value);
			if (resolved !== undefined && resolved === this.canonicalForCompare(store)) return true;
		}
		return false;
	}

	/**
	 * The real path to compare, case-folded on macOS. A path that does not exist yet (the store, and
	 * possibly its directories, before the first answer is written) resolves through its nearest
	 * EXISTING ancestor's real path at any depth, plus the missing tail, so the agent cannot create the
	 * store first. A bare name has no directory part and cannot name the store, which lives outside the
	 * workspace.
	 */
	private canonicalForCompare(value: string): string | undefined {
		if (!value.includes("/") && !value.includes(path.sep)) return undefined;
		const fold = (real: string) => (process.platform === "darwin" ? real.toLowerCase() : real);
		let existing = path.resolve(value);
		const missing: string[] = [];
		for (;;) {
			try {
				return fold(path.join(fs.realpathSync.native(existing), ...missing));
			} catch {
				const parent = path.dirname(existing);
				if (parent === existing) return undefined;
				missing.unshift(path.basename(existing));
				existing = parent;
			}
		}
	}

	/** Request permission for a tool call. Resolves if allowed, throws on denial. */
	async ask(
		request: RequestInput,
		{
			autoApproveAsk = false,
			approveBlanketAsk = false,
			presetBound = false,
			ruleAliases,
		}: {
			readonly autoApproveAsk?: boolean;
			readonly approveBlanketAsk?: boolean;
			/**
			 * Decide as the more restrictive of the preset's decision and the user's (deny > ask > allow),
			 * so no user rule, in any order or layer, can widen the preset.
			 */
			readonly presetBound?: boolean;
			readonly ruleAliases?: readonly string[];
		} = {},
	): Promise<void> {
		const info: Request = {
			...request,
			id: request.id ?? this.nextRequestID(),
		};

		const deniedPatterns: string[] = [];
		let needsAsk = false;

		const options: DecisionOptions = {
			approveBlanketAsk,
			presetBound,
			ruleAliases,
			originalPaths: info.originalPaths,
		};
		for (const pattern of info.patterns) {
			const action = this.decide(info.permission, pattern, options);
			if (action === "deny") {
				deniedPatterns.push(pattern);
				continue;
			}
			if (action === "ask" && !autoApproveAsk) {
				needsAsk = true;
			}
		}

		if (deniedPatterns.length > 0) {
			throw new DeniedError(deniedPatterns);
		}

		if (!needsAsk) {
			this.emitter.emitReplied(info.id, info.sessionID, "allow");
			return;
		}

		const pendingPromise = new Promise<void>((resolve, reject) => {
			const pendingEntry: PendingEntry = {
				info,
				resolve: () => {
					this.pending.delete(info.id);
					this.pendingOptions.delete(info.id);
					resolve();
				},
				reject: (error) => {
					this.pending.delete(info.id);
					this.pendingOptions.delete(info.id);
					reject(error);
				},
			};

			this.pending.set(info.id, pendingEntry);
			this.pendingOptions.set(info.id, options);
		});

		this.emitter.emitAsked(info);

		await pendingPromise;
	}

	/** Reply to a pending permission request */
	reply(input: ReplyInput): void {
		const existing = this.pending.get(input.requestID);
		if (!existing) {
			return;
		}

		this.pending.delete(input.requestID);
		this.pendingOptions.delete(input.requestID);
		this.emitter.emitReplied(existing.info.id, existing.info.sessionID, input.reply);

		if (input.reply === "reject") {
			existing.reject(input.message ? new CorrectedError(input.message) : new RejectedError());
			this.rejectPendingInSession(existing.info.sessionID);
			return;
		}

		existing.resolve();

		if (input.reply === "once") {
			return;
		}

		for (const pattern of input.always ?? existing.info.always) {
			this.approved.push({
				permission: existing.info.permission,
				pattern,
				action: "allow",
			});
		}

		this.resolveCoveredPendingInSession(existing.info.sessionID);
	}

	/** List all pending permission requests */
	list(): Request[] {
		return Array.from(this.pending.values(), (entry) => ({
			...entry.info,
			patterns: [...entry.info.patterns],
			always: [...entry.info.always],
			...(entry.info.originalPaths ? { originalPaths: [...entry.info.originalPaths] } : {}),
			metadata: { ...entry.info.metadata },
			tool: entry.info.tool ? { ...entry.info.tool } : undefined,
		}));
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

	private rejectPendingInSession(sessionID: string): void {
		for (const [requestID, entry] of Array.from(this.pending.entries())) {
			if (entry.info.sessionID !== sessionID) {
				continue;
			}

			this.pending.delete(requestID);
			this.pendingOptions.delete(requestID);
			this.emitter.emitReplied(entry.info.id, entry.info.sessionID, "reject");
			entry.reject(new RejectedError());
		}
	}

	private resolveCoveredPendingInSession(sessionID: string): void {
		for (const [requestID, entry] of Array.from(this.pending.entries())) {
			if (entry.info.sessionID !== sessionID) {
				continue;
			}

			const options = this.pendingOptions.get(requestID) ?? {};
			const isAllowed = entry.info.patterns.every(
				(pattern) => this.decide(entry.info.permission, pattern, options) === "allow",
			);

			if (!isAllowed) {
				continue;
			}

			this.pending.delete(requestID);
			this.pendingOptions.delete(requestID);
			this.emitter.emitReplied(entry.info.id, entry.info.sessionID, "always");
			entry.resolve();
		}
	}
}
