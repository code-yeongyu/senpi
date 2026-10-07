import * as path from "node:path";
import { resolveReadPathAsync, resolveToCwd } from "../../../tools/path-utils.ts";
import { normalizeApplyPatchArguments } from "../gpt-apply-patch/params.ts";
import { parsePatch } from "../gpt-apply-patch/parser.ts";
import { resolvePatchPath } from "../gpt-apply-patch/workspace.ts";
import { isCredentialPath } from "./auto-credentials.ts";
import { existsAtName, isApprovableTarget, isProjectSession, type TargetKind, targetKind } from "./auto-paths.ts";
import { PROGRAM_RULES } from "./auto-program-rules.ts";
import type { ClassifiedWord } from "./auto-shell-grammar.ts";
import { splitShellSegments } from "./auto-shell-segments.ts";
import type { PermissionRequest } from "./parsers.ts";

export type AutoCommandVerdict = "allow" | "ask";

export interface AutoDecision {
	/** Approve an ask that comes only from the preset's own rule (a user's rules still win). */
	readonly approveBlanketAsk: boolean;
}

const WRITE_TOOLS = new Set(["write", "edit"]);
const LIST_TOOLS = new Set(["ls", "find"]);
const NO: AutoDecision = { approveBlanketAsk: false };
const YES: AutoDecision = { approveBlanketAsk: true };

const approvedTarget = (target: string, cwd: string, kinds: readonly TargetKind[]): boolean =>
	isApprovableTarget(target, cwd) && kinds.includes(targetKind(target));

function shellWordAllowed(entry: ClassifiedWord, cwd: string): boolean {
	if (entry.role === "text") return true;
	const text = entry.word.text;
	if (text === "" || text === "-" || text.split("/").includes("..")) return false;
	const target = path.resolve(cwd, text);
	if (entry.role === "read-file") return approvedTarget(target, cwd, ["file"]);
	if (entry.role === "list") return approvedTarget(target, cwd, ["file", "directory"]);
	if (entry.role === "ref-or-path") {
		if (isCredentialPath(target)) return false;
		return !existsAtName(target) || approvedTarget(target, cwd, ["file", "directory"]);
	}
	return false;
}

/**
 * Judges a shell command for the `auto` preset: every simple command must be a listed read-only
 * program run in the project root, whose every word the program grammar classifies, and every
 * path word must name an approvable project file or directory. Anything else asks.
 */
export function judgeAutoCommand(command: string, cwd: string): AutoCommandVerdict {
	const segments = splitShellSegments(command);
	if (!segments || segments.length === 0) return "ask";
	for (const segment of segments) {
		const [program, ...args] = segment;
		if (!program || program.text.includes("/") || program.text.includes("=")) return "ask";
		const classified = PROGRAM_RULES.get(program.text)?.(args);
		if (classified === undefined || !classified.every((entry) => shellWordAllowed(entry, cwd))) return "ask";
	}
	return "allow";
}

const stringPaths = (value: unknown): string[] | undefined => {
	if (value === undefined) return ["."];
	if (typeof value === "string") return [value];
	if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value as string[];
	return undefined;
};

/** The paths an `apply_patch` call will write, resolved by the patch tool's own parser and resolver. */
function patchTargets(input: Record<string, unknown>, cwd: string): string[] | undefined {
	const { input: patchText } = normalizeApplyPatchArguments(input);
	if (!patchText) return undefined;
	try {
		const hunks = parsePatch(patchText);
		// A delete asks, the same as `rm` in the shell.
		if (hunks.length === 0 || hunks.some((hunk) => hunk.type === "delete")) return undefined;
		return hunks.flatMap((hunk) => {
			const targets = [resolvePatchPath(cwd, hunk.filePath)];
			if (hunk.type === "update" && hunk.movePath) targets.push(resolvePatchPath(cwd, hunk.movePath));
			return targets;
		});
	} catch {
		return undefined;
	}
}

/**
 * The `auto` preset's allowlist (decision table on senpi#2614). Each decision is made on the exact
 * target the tool will open, obtained from the tool's own resolver (`resolveReadPathAsync` for `read`,
 * `resolveToCwd` for `write`, `edit`, `ls`, `find` and `grep`, `parsePatch` + `resolvePatchPath` for `apply_patch`).
 * Every other call keeps the preset's ask.
 */
export async function decideAuto(
	toolName: string,
	input: Record<string, unknown>,
	request: PermissionRequest,
	cwd: string,
): Promise<AutoDecision> {
	if (!isProjectSession(cwd)) return NO;
	if (toolName === "bash" || (toolName === "monitor" && typeof input.command === "string")) {
		if (request.permission !== "bash" || typeof input.command !== "string") return NO;
		return judgeAutoCommand(input.command, cwd) === "allow" ? YES : NO;
	}
	if (toolName === "read") {
		const raw = input.path ?? input.file_path;
		if (typeof raw !== "string") return NO;
		return approvedTarget(await resolveReadPathAsync(raw, cwd), cwd, ["file", "missing"]) ? YES : NO;
	}
	if (toolName === "grep") {
		const raws = stringPaths(input.path);
		if (raws?.length === 0) return NO;
		return raws?.every((raw) => approvedTarget(resolveToCwd(raw, cwd), cwd, ["file"])) ? YES : NO;
	}
	if (LIST_TOOLS.has(toolName)) {
		const raw = input.path ?? ".";
		if (typeof raw !== "string") return NO;
		return approvedTarget(resolveToCwd(raw || ".", cwd), cwd, ["directory"]) ? YES : NO;
	}
	if (WRITE_TOOLS.has(toolName)) {
		const raw = input.path ?? input.file_path;
		if (typeof raw !== "string") return NO;
		return approvedTarget(resolveToCwd(raw, cwd), cwd, ["file", "missing"]) ? YES : NO;
	}
	if (toolName === "apply_patch") {
		const targets = patchTargets(input, cwd);
		return targets?.every((target) => approvedTarget(target, cwd, ["file", "missing"])) ? YES : NO;
	}
	return NO;
}
