import picomatch from "picomatch";

import type { TtsrRule, TtsrSettings, TtsrStreamSource, TtsrToolScope } from "./types.ts";

export interface TtsrMatchContext {
	readonly source: TtsrStreamSource;
	readonly streamKey: string;
	readonly toolName?: string;
	readonly filePaths?: readonly string[];
}

export type TtsrCompileCondition = (pattern: string) => RegExp | null;

type PathMatcher = (path: string) => boolean;

interface TtsrEntry {
	readonly rule: TtsrRule;
	readonly conditions: readonly RegExp[];
	readonly globalPathMatchers: readonly PathMatcher[];
	readonly toolPathMatchers: ReadonlyMap<TtsrToolScope, PathMatcher>;
}

interface InjectionRecord {
	lastInjectedAt: number;
}

const PICOMATCH_OPTIONS = { dot: true };
/**
 * Floor for the per-stream tail window. Long enough that even untracked
 * short patterns survive window slides with margin to spare.
 */
const MIN_STREAM_BUFFER_TAIL_CHARS = 1024;
/**
 * A regex can match text longer than its source (quantifiers like `\d{20}`),
 * so the tail window scales past the longest pattern text rather than
 * equaling it.
 */
const STREAM_BUFFER_TAIL_SAFETY_FACTOR = 4;

export class TtsrManager {
	readonly #settings: TtsrSettings;
	readonly #compileCondition: TtsrCompileCondition;
	readonly #rules = new Map<string, TtsrEntry>();
	readonly #injectionRecords = new Map<string, InjectionRecord>();
	readonly #buffers = new Map<string, string>();
	#maxConditionLength = 0;
	#messageCount = 0;
	#canMatchText = false;
	#canMatchThinking = false;

	constructor(settings: TtsrSettings, compileCondition: TtsrCompileCondition) {
		this.#settings = settings;
		this.#compileCondition = compileCondition;
	}

	#canTrigger(ruleName: string): boolean {
		const record = this.#injectionRecords.get(ruleName);
		if (record === undefined) {
			return true;
		}
		if (this.#settings.repeatMode === "once") {
			return false;
		}
		return this.#messageCount - record.lastInjectedAt >= this.#settings.repeatGap;
	}

	#compileGlob(pattern: string, ruleName: string): PathMatcher | undefined {
		try {
			return picomatch(pattern, PICOMATCH_OPTIONS);
		} catch (error) {
			console.warn("TTSR glob pattern is invalid, skipping glob", {
				ruleName,
				pattern,
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	}

	#normalizePath(pathValue: string): string {
		return pathValue.replaceAll("\\", "/");
	}

	#matchesGlob(matcher: PathMatcher, filePaths: readonly string[] | undefined): boolean {
		if (filePaths === undefined || filePaths.length === 0) {
			return false;
		}
		for (const filePath of filePaths) {
			const normalized = this.#normalizePath(filePath);
			if (matcher(normalized)) {
				return true;
			}
			const slashIndex = normalized.lastIndexOf("/");
			const basename = slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
			if (basename !== normalized && matcher(basename)) {
				return true;
			}
		}
		return false;
	}

	#matchesGlobalPaths(entry: TtsrEntry, context: TtsrMatchContext): boolean {
		for (const matcher of entry.globalPathMatchers) {
			if (this.#matchesGlob(matcher, context.filePaths)) {
				return true;
			}
		}
		return entry.globalPathMatchers.length === 0;
	}

	#matchesScope(entry: TtsrEntry, context: TtsrMatchContext): boolean {
		const scope = entry.rule.scope;
		if (context.source === "text") {
			return scope.allowText;
		}
		if (context.source === "thinking") {
			return scope.allowThinking;
		}
		const toolName = context.toolName?.trim().toLowerCase();
		for (const toolScope of scope.toolScopes) {
			if (toolScope.toolName !== "*" && toolScope.toolName.toLowerCase() !== toolName) {
				continue;
			}
			const pathMatcher = entry.toolPathMatchers.get(toolScope);
			if (pathMatcher !== undefined && !this.#matchesGlob(pathMatcher, context.filePaths)) {
				continue;
			}
			return true;
		}
		return false;
	}

	#matchesCondition(entry: TtsrEntry, streamBuffer: string): boolean {
		for (const condition of entry.conditions) {
			condition.lastIndex = 0;
			if (condition.test(streamBuffer)) {
				return true;
			}
		}
		return false;
	}

	addRule(rule: TtsrRule): boolean {
		if (!this.#settings.enabled || this.#settings.disabledRules.includes(rule.name)) {
			return false;
		}
		if (this.#rules.has(rule.name)) {
			return false;
		}
		const conditions: RegExp[] = [];
		for (const pattern of rule.condition) {
			const compiled = this.#compileCondition(pattern);
			if (compiled === null) {
				console.warn("TTSR condition has invalid regex pattern, skipping condition", {
					ruleName: rule.name,
					pattern,
				});
				continue;
			}
			conditions.push(compiled);
			if (pattern.length > this.#maxConditionLength) this.#maxConditionLength = pattern.length;
		}
		if (conditions.length === 0) {
			console.warn("TTSR rule has no valid condition, skipping rule", { ruleName: rule.name });
			return false;
		}
		const scope = rule.scope;
		if (!scope.allowText && !scope.allowThinking && scope.toolScopes.length === 0) {
			console.warn("TTSR scope excludes all streams, skipping rule", { ruleName: rule.name });
			return false;
		}
		const globalPathMatchers: PathMatcher[] = [];
		for (const glob of rule.globs ?? []) {
			const matcher = this.#compileGlob(glob, rule.name);
			if (matcher !== undefined) {
				globalPathMatchers.push(matcher);
			}
		}
		const toolPathMatchers = new Map<TtsrToolScope, PathMatcher>();
		for (const toolScope of scope.toolScopes) {
			if (toolScope.pathGlob === undefined) {
				continue;
			}
			const matcher = this.#compileGlob(toolScope.pathGlob, rule.name);
			if (matcher !== undefined) {
				toolPathMatchers.set(toolScope, matcher);
			}
		}
		this.#rules.set(rule.name, { rule, conditions, globalPathMatchers, toolPathMatchers });
		if (scope.allowText) {
			this.#canMatchText = true;
		}
		if (scope.allowThinking) {
			this.#canMatchThinking = true;
		}
		return true;
	}

	checkDelta(delta: string, context: TtsrMatchContext): TtsrRule[] {
		if (context.source === "text" && !this.#canMatchText) {
			return [];
		}
		if (context.source === "thinking" && !this.#canMatchThinking) {
			return [];
		}
		const bufferKey = `${context.source}:${context.streamKey}`;
		let nextBuffer = `${this.#buffers.get(bufferKey) ?? ""}${delta}`;
		// Keep only a tail window: rules match against recent output, and an
		// unbounded buffer would retain the whole turn's stream (and pay O(n^2)
		// concat garbage per delta) until the next turn reset.
		const cap = this.#streamBufferCapChars();
		if (nextBuffer.length > cap) nextBuffer = nextBuffer.slice(-cap);
		this.#buffers.set(bufferKey, nextBuffer);
		return this.#matchBuffer(nextBuffer, context);
	}

	#streamBufferCapChars(): number {
		return Math.max(MIN_STREAM_BUFFER_TAIL_CHARS, this.#maxConditionLength * STREAM_BUFFER_TAIL_SAFETY_FACTOR);
	}

	/** Buffered chars per stream key (diagnostics; buffer-bound verification). */
	getStreamBufferLengths(): Map<string, number> {
		return new Map(Array.from(this.#buffers, ([key, buffer]) => [key, buffer.length]));
	}

	#matchBuffer(buffer: string, context: TtsrMatchContext): TtsrRule[] {
		if (!this.#settings.enabled) {
			return [];
		}
		const matches: TtsrRule[] = [];
		for (const [name, entry] of this.#rules) {
			if (!this.#canTrigger(name)) {
				continue;
			}
			if (!this.#matchesScope(entry, context)) {
				continue;
			}
			if (!this.#matchesGlobalPaths(entry, context)) {
				continue;
			}
			if (!this.#matchesCondition(entry, buffer)) {
				continue;
			}
			matches.push(entry.rule);
		}
		return matches;
	}

	markInjected(rulesToMark: readonly TtsrRule[]): void {
		this.markInjectedByNames(rulesToMark.map((rule) => rule.name));
	}

	markInjectedByNames(ruleNames: readonly string[]): void {
		for (const rawName of ruleNames) {
			const ruleName = rawName.trim();
			if (ruleName.length === 0) {
				continue;
			}
			this.#injectionRecords.set(ruleName, { lastInjectedAt: this.#messageCount });
		}
	}

	getInjectedRuleNames(): string[] {
		return Array.from(this.#injectionRecords.keys());
	}

	restoreInjected(ruleNames: readonly string[]): void {
		for (const name of ruleNames) {
			this.#injectionRecords.set(name, { lastInjectedAt: 0 });
		}
	}

	resetBuffers(): void {
		this.#buffers.clear();
	}

	hasRules(): boolean {
		if (!this.#settings.enabled) {
			return false;
		}
		return this.#rules.size > 0;
	}

	getRules(): TtsrRule[] {
		return Array.from(this.#rules.values(), (entry) => entry.rule);
	}

	incrementMessageCount(): void {
		this.#messageCount += 1;
	}

	getMessageCount(): number {
		return this.#messageCount;
	}

	getSettings(): TtsrSettings {
		return this.#settings;
	}
}
