import { isPresetRule } from "./config.ts";
import { evaluate } from "./evaluate.ts";
import { createLocalEventEmitter, type PermissionEventEmitter } from "./events.ts";
import {
	CorrectedError,
	DeniedError,
	type PendingEntry,
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

	constructor(staticRuleset: Ruleset, approved: Ruleset, emitter: PermissionEventEmitter = createLocalEventEmitter()) {
		this.staticRuleset = [...staticRuleset];
		this.approved = [...approved];
		this.emitter = emitter;
	}

	/** deny > ask > allow. */
	private static readonly RESTRICTIVENESS: Readonly<Record<Rule["action"], number>> = { allow: 0, ask: 1, deny: 2 };

	/**
	 * The one decision for a call, used when it is asked and again whenever an "Always" reply re-checks
	 * the requests still pending. Without `presetBound` it is last-match-wins over every rule. With
	 * `presetBound` the preset's rules and the user's settings and CLI rules are evaluated apart and
	 * the more restrictive wins, so no configured rule, in any order or layer, can widen the preset;
	 * only an "Always" answer given in this or an earlier session (`permissions-approved.jsonl`,
	 * explicit consent for that pattern) can then turn a remaining ask into allow.
	 */
	private decide(permission: string, target: string | readonly string[], options: DecisionOptions): Rule["action"] {
		if (!options.presetBound) return evaluate(permission, target, this.staticRuleset, this.approved).action;
		const presetRules = this.staticRuleset.filter((rule) => isPresetRule(rule));
		const userRules = this.staticRuleset.filter((rule) => !isPresetRule(rule));
		const presetRule = evaluate(permission, target, presetRules);
		const preset = presetRule.action === "ask" && options.approveBlanketAsk ? "allow" : presetRule.action;
		const userRule = evaluate(permission, target, userRules);
		const user = userRules.includes(userRule) ? userRule.action : undefined;
		const combined =
			user === undefined || PermissionService.RESTRICTIVENESS[preset] >= PermissionService.RESTRICTIVENESS[user]
				? preset
				: user;
		if (combined !== "ask") return combined;
		const remembered = evaluate(permission, target, this.approved);
		return this.approved.includes(remembered) && remembered.action === "allow" ? "allow" : "ask";
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

		const options: DecisionOptions = { approveBlanketAsk, presetBound, ruleAliases };
		for (const pattern of info.patterns) {
			const action = this.decide(info.permission, ruleAliases ?? pattern, options);
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

		for (const pattern of existing.info.always) {
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
			metadata: { ...entry.info.metadata },
			tool: entry.info.tool ? { ...entry.info.tool } : undefined,
		}));
	}

	/** Get the current approved ruleset */
	getApproved(): Ruleset {
		return this.approved.map((rule) => ({ ...rule }));
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
				(pattern) => this.decide(entry.info.permission, options.ruleAliases ?? pattern, options) === "allow",
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
