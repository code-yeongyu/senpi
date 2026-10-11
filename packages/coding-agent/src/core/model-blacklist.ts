/**
 * Native model blacklist: a saved, ordered list of `provider/model` glob rules.
 *
 * The saved file (`<agentDir>/model-blacklist.json`) is `{ "models": [...] }`.
 * Rules are evaluated in order against `provider/id`; the last matching rule decides. A rule
 * starting with `!` is an exception that unblocks what an earlier rule blocked. `*` matches any
 * run of characters (including `/`), `?` one character, and `\` escapes the next character.
 * A model matching no rule is allowed.
 *
 * A saved file that cannot be read or parsed fails closed: every model is blocked until the
 * file is fixed or removed.
 */
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelBlacklistAdapter, ModelBlacklistState } from "./extensions/types.ts";

export const MODEL_BLACKLIST_FILE_NAME = "model-blacklist.json";
const MALFORMED_RULE = "malformed model blacklist (fails closed)";

interface ModelRef {
	provider: string;
	id: string;
}

export interface ModelBlacklistDecision {
	blocked: boolean;
	/** The rule that decided, when one matched. */
	rule?: string;
}

function escapeGlobLiteral(text: string): string {
	return text.replace(/[\\*?]/g, "\\$&");
}

/** The rule text that matches exactly one model. */
export function exactModelRule(model: ModelRef): string {
	return escapeGlobLiteral(`${model.provider}/${model.id}`);
}

function compileGlob(glob: string): RegExp {
	let source = "";
	for (let index = 0; index < glob.length; index++) {
		const char = glob.charAt(index);
		if (char === "*") source += "[\\s\\S]*";
		else if (char === "?") source += "[\\s\\S]";
		else if (char === "\\" && index + 1 < glob.length) {
			index++;
			source += glob.charAt(index).replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
		} else source += char.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
	}
	return new RegExp(`^${source}$`);
}

interface CompiledRule {
	text: string;
	allow: boolean;
	matcher: RegExp;
}

function compileRule(text: string): CompiledRule {
	const allow = text.startsWith("!");
	return { text, allow, matcher: compileGlob(allow ? text.slice(1) : text) };
}

/** Immutable parsed policy. */
export class ModelBlacklistPolicy {
	readonly rules: readonly string[];
	/** Set when the saved policy could not be loaded; every model is then blocked. */
	readonly error: string | undefined;
	private readonly compiled: readonly CompiledRule[];

	private constructor(rules: readonly string[], error?: string) {
		this.rules = rules;
		this.error = error;
		this.compiled = rules.map(compileRule);
	}

	static empty(): ModelBlacklistPolicy {
		return new ModelBlacklistPolicy([]);
	}

	static fromRules(rules: readonly string[]): ModelBlacklistPolicy {
		for (const rule of rules) {
			if (typeof rule !== "string" || rule.trim() === "" || rule.trim() === "!") {
				throw new Error(`Invalid model blacklist rule: ${JSON.stringify(rule)}`);
			}
		}
		return new ModelBlacklistPolicy(rules.map((rule) => rule.trim()));
	}

	static failClosed(reason: string): ModelBlacklistPolicy {
		return new ModelBlacklistPolicy([], reason);
	}

	static parse(text: string): ModelBlacklistPolicy {
		let data: unknown;
		try {
			data = JSON.parse(text);
		} catch (error) {
			return ModelBlacklistPolicy.failClosed(
				`invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (typeof data !== "object" || data === null || Array.isArray(data)) {
			return ModelBlacklistPolicy.failClosed("expected a JSON object");
		}
		const { models: rules } = data as { models?: unknown };
		if (!Array.isArray(rules)) return ModelBlacklistPolicy.failClosed('"models" must be an array of strings');
		try {
			return ModelBlacklistPolicy.fromRules(rules);
		} catch (error) {
			return ModelBlacklistPolicy.failClosed(error instanceof Error ? error.message : String(error));
		}
	}

	get isEmpty(): boolean {
		return this.error === undefined && this.rules.length === 0;
	}

	decide(model: ModelRef): ModelBlacklistDecision {
		if (this.error !== undefined) return { blocked: true, rule: MALFORMED_RULE };
		const name = `${model.provider}/${model.id}`;
		let decision: ModelBlacklistDecision = { blocked: false };
		for (const rule of this.compiled) {
			if (rule.matcher.test(name)) decision = { blocked: !rule.allow, rule: rule.text };
		}
		return decision;
	}

	isBlocked(model: ModelRef): boolean {
		return this.decide(model).blocked;
	}

	/** Rules that save the opposite of this policy's decision for `model`, using exact-match rules. */
	toggledRules(model: ModelRef): string[] {
		if (this.error !== undefined) throw new Error(`Cannot edit a malformed model blacklist: ${this.error}`);
		const target = !this.isBlocked(model);
		const exact = exactModelRule(model);
		let rules = this.rules.filter((rule) => rule !== exact && rule !== `!${exact}`);
		if (ModelBlacklistPolicy.fromRules(rules).isBlocked(model) !== target) {
			rules = [...rules, target ? exact : `!${exact}`];
		}
		return rules;
	}

	serialize(): string {
		return `${JSON.stringify({ models: this.rules }, null, 2)}\n`;
	}
}

async function readPolicy(path: string): Promise<ModelBlacklistPolicy> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return ModelBlacklistPolicy.empty();
		return ModelBlacklistPolicy.failClosed(
			`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const policy = ModelBlacklistPolicy.parse(text);
	return policy.error === undefined ? policy : ModelBlacklistPolicy.failClosed(`${path}: ${policy.error}`);
}

/** Atomic 0600 write: temp file in the same directory, fsync, rename. */
async function writePolicyAtomic(path: string, policy: ModelBlacklistPolicy): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temp = join(
		dirname(path),
		`.${MODEL_BLACKLIST_FILE_NAME}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
	);
	try {
		const handle = await open(temp, "wx", 0o600);
		try {
			await handle.writeFile(policy.serialize(), "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temp, path);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

/**
 * The saved policy file plus the policy the running process loaded. Existing files
 * fail closed until their first async read; a missing file is immediately a no-op.
 * After initialization `active` never changes;
 * `saved` is refreshed asynchronously, so picker reads never perform I/O. A toggle shows
 * up as saved-vs-active drift until restart.
 */
export class ModelBlacklistStore {
	readonly path: string;
	private activePolicy = ModelBlacklistPolicy.failClosed("model blacklist not loaded; await runtime.refresh()");
	private initialized = false;
	private cached = this.activePolicy;
	private writeQueue: Promise<unknown> = Promise.resolve();

	constructor(path: string) {
		this.path = path;
		// Bootstrap may establish absence from metadata, but never reads policy bytes.
		// Existing or inaccessible files stay fail-closed until asynchronous initialization.
		try {
			statSync(path);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") {
				this.activePolicy = ModelBlacklistPolicy.empty();
				this.cached = this.activePolicy;
				this.initialized = true;
			}
		}
	}

	get active(): ModelBlacklistPolicy {
		return this.activePolicy;
	}

	static forDirectory(directory: string): ModelBlacklistStore {
		return new ModelBlacklistStore(join(directory, MODEL_BLACKLIST_FILE_NAME));
	}

	/** Last saved snapshot, updated by refreshSaved() or a completed toggle. */
	saved(): ModelBlacklistPolicy {
		return this.cached;
	}

	/** Refresh saved state without changing active enforcement; ordered with local writes. */
	refreshSaved(): Promise<void> {
		const run = async () => {
			this.cached = await readPolicy(this.path);
			if (!this.initialized) {
				this.activePolicy = this.cached;
				this.initialized = true;
			}
		};
		const result = this.writeQueue.then(run, run);
		this.writeQueue = result.catch(() => undefined);
		return result;
	}

	/** Persist the opposite of the model's saved state. Rejects on a malformed saved file. */
	toggle(model: ModelRef): Promise<void> {
		const run = async () => {
			// Re-read: another process may have edited the file since the cache filled.
			this.cached = await readPolicy(this.path);
			if (!this.initialized) {
				this.activePolicy = this.cached;
				this.initialized = true;
			}
			const next = ModelBlacklistPolicy.fromRules(this.cached.toggledRules(model));
			await writePolicyAtomic(this.path, next);
			this.cached = next;
		};
		const result = this.writeQueue.then(run, run);
		this.writeQueue = result.catch(() => undefined);
		return result;
	}
}

/**
 * Adapter for the model picker. `getModels` returns the pre-filter available rows so a
 * blocked model stays listed and can be unblocked.
 */
export function createModelBlacklistAdapter(
	store: ModelBlacklistStore,
	getUnfilteredModels: () => readonly Model<any>[],
): ModelBlacklistAdapter {
	return {
		getModels: getUnfilteredModels,
		getState: (model): ModelBlacklistState => {
			const saved = store.saved().decide(model);
			const state: ModelBlacklistState = { blocked: saved.blocked, activeBlocked: store.active.isBlocked(model) };
			if (saved.rule !== undefined) state.rule = saved.rule;
			return state;
		},
		toggle: (model) => store.toggle(model),
	};
}
