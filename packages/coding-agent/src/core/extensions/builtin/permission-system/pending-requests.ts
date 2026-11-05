import type { DecisionOptions } from "./decide-target.ts";
import type { PermissionEventEmitter } from "./events.ts";
import { CorrectedError, type PendingEntry, RejectedError, type ReplyInput, type Request, type Rule } from "./types.ts";

export interface PendingRequestsDeps {
	readonly emitter: PermissionEventEmitter;
	/** Remembers an "Always" answer as an approved rule. */
	approve(rule: Rule): void;
	decide(permission: string, pattern: string, options: DecisionOptions): Rule["action"];
}

/** The requests waiting on a user reply, with the options each was decided with. */
export class PendingRequests {
	private pending = new Map<string, PendingEntry>();
	/** How each pending request was decided, so a re-check after an "Always" reply decides it the same way. */
	private pendingOptions = new Map<string, DecisionOptions>();
	private readonly deps: PendingRequestsDeps;

	constructor(deps: PendingRequestsDeps) {
		this.deps = deps;
	}

	register(info: Request, options: DecisionOptions): Promise<void> {
		return new Promise<void>((resolve, reject) => {
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
	}

	/** Reply to a pending permission request */
	reply(input: ReplyInput): void {
		const existing = this.pending.get(input.requestID);
		if (!existing) {
			return;
		}

		this.pending.delete(input.requestID);
		this.pendingOptions.delete(input.requestID);
		this.deps.emitter.emitReplied(existing.info.id, existing.info.sessionID, input.reply);

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
			this.deps.approve({
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

	private rejectPendingInSession(sessionID: string): void {
		for (const [requestID, entry] of Array.from(this.pending.entries())) {
			if (entry.info.sessionID !== sessionID) {
				continue;
			}

			this.pending.delete(requestID);
			this.pendingOptions.delete(requestID);
			this.deps.emitter.emitReplied(entry.info.id, entry.info.sessionID, "reject");
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
				(pattern) => this.deps.decide(entry.info.permission, pattern, options) === "allow",
			);

			if (!isAllowed) {
				continue;
			}

			this.pending.delete(requestID);
			this.pendingOptions.delete(requestID);
			this.deps.emitter.emitReplied(entry.info.id, entry.info.sessionID, "always");
			entry.resolve();
		}
	}
}
