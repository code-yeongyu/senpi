import { lstatSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, isAbsolute, join, parse, sep } from "node:path";
import { realpathWithoutOpenStrict } from "../../../../utils/paths.ts";
import { canonicalPathCase, sameLexicalPath } from "./external-pattern.ts";
import type { Rule } from "./types.ts";

type Decision = { readonly action: Rule["action"]; readonly rules: readonly Rule[] };

/**
 * Walk a component queue like the kernel: the position is always physical, and link targets
 * are prepended without normalizing away dots. A .. moves to the physical parent's directory.
 * Keep the absolute request, the physical prefix plus unresolved suffix at each followed link,
 * and the final physical path, with proven case forms. Never combine a relative target with
 * an unresolved lexical parent. Discovery uses only lstat/readlink; case recovery is separate.
 */
export function decideExternalPaths(
	target: string | readonly string[],
	aliases: readonly string[],
	decide: (spelling: string, resolved: string, canonicalCase: (value: string) => string) => Decision,
): Decision {
	const targets = typeof target === "string" ? [target] : target;
	const resolvedPaths = new Map<string, string>();
	const cases = new Map<string, string>();
	const directories = new Map<string, string[]>();
	const canonicalCase = (value: string): string => {
		let result = cases.get(value);
		if (result === undefined) {
			result = canonicalPathCase(value, (directory) => {
				let entries = directories.get(directory);
				if (entries === undefined) {
					entries = readdirSync(directory);
					directories.set(directory, entries);
				}
				return entries;
			});
			cases.set(value, result);
		}
		return result;
	};
	const resolve = (value: string): string => {
		let result = resolvedPaths.get(value);
		if (result === undefined) {
			result = realpathWithoutOpenStrict(isAbsolute(value) ? value : `${process.cwd()}${sep}${value}`);
			resolvedPaths.set(value, result);
		}
		return result;
	};
	const spellings = new Map<string, string>();
	const add = (spelling: string, resolved: string): boolean => {
		if (!spellings.has(spelling) && spellings.size >= 16) return false;
		spellings.set(spelling, resolved);
		const canonical = canonicalCase(spelling);
		if (!spellings.has(canonical) && spellings.size >= 16) return false;
		spellings.set(canonical, resolved);
		return true;
	};
	let hops = 0;
	try {
		const resolvedTargets = targets.map(resolve);
		for (const value of new Set([...targets, ...aliases])) {
			const resolved = resolve(value);
			// A multi-path request's aliases belong only to their own resolved target.
			if (!resolvedTargets.some((candidate) => sameLexicalPath(candidate, resolved))) continue;
			if (!add(resolved, resolved)) return { action: "ask", rules: [] };
			const spelling = isAbsolute(value) ? value : `${process.cwd()}${sep}${value}`;
			if (!add(spelling, resolved)) return { action: "ask", rules: [] };
			let physical = parse(spelling).root;
			const pending = spelling.slice(physical.length).split(sep).filter(Boolean);
			while (pending.length > 0) {
				const part = pending.shift();
				if (part === undefined) break;
				if (part === ".") continue;
				if (part === "..") {
					physical = dirname(physical);
					continue;
				}
				const candidate = join(physical, part);
				let link: string;
				try {
					if (!lstatSync(candidate).isSymbolicLink()) {
						physical = candidate;
						continue;
					}
					if (++hops > 40) return { action: "ask", rules: [] };
					// Concatenate the unresolved suffix verbatim: join would collapse S/..
					// before S was followed and could erase a genuine intermediate deny.
					const intermediate = [candidate, ...pending].join(sep);
					if (!add(intermediate, resolved)) return { action: "ask", rules: [] };
					link = readlinkSync(candidate);
				} catch (error) {
					if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
						// No links can be followed inside a missing tail.
						physical = join(candidate, ...pending);
						break;
					}
					throw error;
				}
				if (isAbsolute(link)) {
					physical = parse(link).root;
					pending.unshift(...link.slice(physical.length).split(sep).filter(Boolean));
				} else {
					pending.unshift(...link.split(sep).filter(Boolean));
				}
			}
			if (!add(physical, resolved)) return { action: "ask", rules: [] };
		}
	} catch (error) {
		// Missing tails are supported by the strict resolver; loops, hop exhaustion and
		// unavailable metadata cannot establish the complete spelling set.
		if (error instanceof Error && "code" in error) return { action: "ask", rules: [] };
		throw error;
	}
	let action: Rule["action"] = "allow";
	const rules: Rule[] = [];
	for (const [spelling, resolved] of spellings) {
		const decision = decide(spelling, resolved, canonicalCase);
		if (decision.action === "deny" || (decision.action === "ask" && action === "allow")) action = decision.action;
		rules.push(...decision.rules);
	}
	return { action, rules };
}
