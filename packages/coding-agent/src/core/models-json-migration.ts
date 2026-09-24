/**
 * One-shot on-disk migration of legacy provider ids in models.json (senpi#2044).
 *
 * A models.json written before the subscription rename (senpi#1989) keys its
 * overlays and `disabledProviders` by the legacy ids. The read boundary in
 * `model-config.ts` already normalizes them in memory; this module rewrites the
 * file once so the notice never repeats. The file is user-authored JSONC, so
 * only the affected key/element tokens are edited - comments and formatting
 * survive - and the result must re-parse to exactly the migrated document
 * before it replaces the original.
 */

import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { normalizeProviderId } from "@earendil-works/pi-ai";
import { stripJsonComments } from "../utils/json.ts";
import { stripBom } from "../utils/text.ts";

export type ModelsJsonMigration =
	| { readonly kind: "unchanged" }
	| { readonly kind: "migrated"; readonly renamed: readonly string[]; readonly backupPath: string }
	| { readonly kind: "failed"; readonly renamed: readonly string[]; readonly reason: string };

interface Span {
	readonly start: number;
	readonly end: number;
}
interface Member {
	readonly key: string;
	readonly keySpan: Span;
	readonly value: Node;
}
interface Node extends Span {
	readonly members?: readonly Member[];
	readonly elements?: readonly Node[];
}
interface Edit extends Span {
	readonly text: string;
}
type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value);

class JsoncSpanScanner {
	private readonly text: string;

	constructor(text: string) {
		this.text = text;
	}

	skipTrivia(from: number): number {
		let i = from;
		while (i < this.text.length) {
			const c = this.text[i];
			if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\uFEFF") i++;
			else if (this.text.startsWith("//", i)) i = this.lineEnd(i);
			else if (this.text.startsWith("/*", i)) i = this.blockCommentEnd(i);
			else break;
		}
		return i;
	}

	value(from: number): Node {
		const start = this.skipTrivia(from);
		const c = this.text[start];
		if (c === "{") return this.object(start);
		if (c === "[") return this.array(start);
		if (c === '"') return { start, end: this.stringEnd(start) };
		let end = start;
		while (end < this.text.length && !/[\s,\]}/]/.test(this.text[end] ?? "")) end++;
		if (end === start) throw new Error(`unexpected character at offset ${start}`);
		return { start, end };
	}

	private object(start: number): Node {
		const members: Member[] = [];
		let i = start + 1;
		while (true) {
			i = this.skipTrivia(i);
			const c = this.text[i];
			if (c === "}") return { start, end: i + 1, members };
			if (c === ",") {
				i++;
				continue;
			}
			if (c !== '"') throw new Error(`expected a key at offset ${i}`);
			const keySpan = { start: i, end: this.stringEnd(i) };
			const colon = this.skipTrivia(keySpan.end);
			if (this.text[colon] !== ":") throw new Error(`expected ':' at offset ${colon}`);
			const value = this.value(colon + 1);
			members.push({ key: JSON.parse(this.text.slice(keySpan.start, keySpan.end)), keySpan, value });
			i = value.end;
		}
	}

	private array(start: number): Node {
		const elements: Node[] = [];
		let i = start + 1;
		while (true) {
			i = this.skipTrivia(i);
			const c = this.text[i];
			if (c === "]") return { start, end: i + 1, elements };
			if (c === ",") {
				i++;
				continue;
			}
			const element = this.value(i);
			elements.push(element);
			i = element.end;
		}
	}

	private stringEnd(start: number): number {
		for (let i = start + 1; i < this.text.length; i++) {
			if (this.text[i] === "\\") i++;
			else if (this.text[i] === '"') return i + 1;
		}
		throw new Error("unterminated string");
	}

	private blockCommentEnd(from: number): number {
		const close = this.text.indexOf("*/", from + 2);
		if (close < 0) throw new Error("unterminated comment");
		return close + 2;
	}

	private lineEnd(from: number): number {
		const newline = this.text.indexOf("\n", from);
		return newline < 0 ? this.text.length : newline;
	}
}

const parseJsonc = (content: string): unknown => JSON.parse(stripJsonComments(stripBom(content)));

function migratedDocument(document: JsonRecord): { next: JsonRecord; renamed: string[] } {
	const renamed: string[] = [];
	const next: JsonRecord = { ...document };
	if (isRecord(document.providers)) {
		const providers: JsonRecord = {};
		for (const [id, provider] of Object.entries(document.providers)) {
			const canonical = normalizeProviderId(id);
			if (canonical !== id) renamed.push(`${id} -> ${canonical}`);
			if (canonical !== id && canonical in document.providers) continue;
			providers[canonical] = provider;
		}
		next.providers = providers;
	}
	if (Array.isArray(document.disabledProviders)) {
		next.disabledProviders = document.disabledProviders.map((id: unknown) => {
			if (typeof id !== "string" || normalizeProviderId(id) === id) return id;
			renamed.push(`${id} -> ${normalizeProviderId(id)}`);
			return normalizeProviderId(id);
		});
	}
	return { next, renamed: [...new Set(renamed)] };
}

function memberRemovalSpan(text: string, scanner: JsoncSpanScanner, member: Member): Span {
	const after = scanner.skipTrivia(member.value.end);
	if (text[after] === ",") {
		let start = member.keySpan.start;
		while (start > 0 && (text[start - 1] === " " || text[start - 1] === "\t")) start--;
		const ownsLine = start === 0 || text[start - 1] === "\n";
		let end = after + 1;
		while (end < text.length && (text[end] === " " || text[end] === "\t")) end++;
		if (ownsLine && text[end] === "\r") end++;
		if (ownsLine && text[end] === "\n") return { start, end: end + 1 };
		return { start: ownsLine ? start : member.keySpan.start, end: after + 1 };
	}
	let comma = member.keySpan.start - 1;
	while (comma >= 0 && /\s/.test(text[comma] ?? "")) comma--;
	return { start: text[comma] === "," ? comma : member.keySpan.start, end: member.value.end };
}

function rewriteProviderIdTokens(content: string): string {
	const scanner = new JsoncSpanScanner(content);
	const root = scanner.value(0);
	const edits: Edit[] = [];
	for (const member of root.members ?? []) {
		if (member.key === "providers" && member.value.members) {
			const keys = new Set(member.value.members.map((provider) => provider.key));
			for (const provider of member.value.members) {
				const canonical = normalizeProviderId(provider.key);
				if (canonical === provider.key) continue;
				if (keys.has(canonical)) edits.push({ ...memberRemovalSpan(content, scanner, provider), text: "" });
				else edits.push({ ...provider.keySpan, text: JSON.stringify(canonical) });
			}
		}
		if (member.key === "disabledProviders" && member.value.elements) {
			for (const element of member.value.elements) {
				const raw: unknown = JSON.parse(content.slice(element.start, element.end));
				if (typeof raw !== "string" || normalizeProviderId(raw) === raw) continue;
				edits.push({ ...element, text: JSON.stringify(normalizeProviderId(raw)) });
			}
		}
	}
	let next = content;
	for (const edit of edits.sort((a, b) => b.start - a.start)) {
		next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
	}
	return next;
}

function verifiedRewrite(content: string, expected: JsonRecord): string {
	let tokenEdited: string | undefined;
	try {
		tokenEdited = rewriteProviderIdTokens(content);
	} catch {
		tokenEdited = undefined;
	}
	if (tokenEdited !== undefined && isDeepStrictEqual(parseJsonc(tokenEdited), expected)) return tokenEdited;
	return `${JSON.stringify(expected, null, 2)}\n`;
}

function uniqueBackupPath(path: string): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	let backupPath = `${path}.backup-${stamp}`;
	for (let attempt = 1; existsSync(backupPath); attempt++) backupPath = `${path}.backup-${stamp}-${attempt}`;
	return backupPath;
}

/**
 * Rewrite `path` once when its content (already read as `content`) uses a legacy
 * provider id. Keeps a timestamped backup of the original bytes, writes through a
 * temp file with the original mode, and refuses to replace a file that changed
 * since it was read. Never throws: a failure leaves the original untouched.
 */
export function migrateModelsJsonProviderIds(path: string, content: string): ModelsJsonMigration {
	let document: unknown;
	try {
		document = parseJsonc(content);
	} catch {
		return { kind: "unchanged" };
	}
	if (!isRecord(document)) return { kind: "unchanged" };
	const { next, renamed } = migratedDocument(document);
	if (renamed.length === 0) return { kind: "unchanged" };

	const backupPath = uniqueBackupPath(path);
	const temporary = `${path}.${process.pid}.tmp`;
	const created: string[] = [];
	try {
		const mode = statSync(path).mode & 0o777;
		writeFileSync(backupPath, content, { encoding: "utf-8", mode, flag: "wx" });
		created.push(backupPath);
		writeFileSync(temporary, verifiedRewrite(content, next), { encoding: "utf-8", mode, flag: "wx" });
		created.push(temporary);
		chmodSync(temporary, mode);
		if (readFileSync(path, "utf-8") !== content) throw new Error("the file changed while it was being migrated");
		renameSync(temporary, path);
		return { kind: "migrated", renamed, backupPath };
	} catch (error) {
		for (const leftover of created) {
			try {
				rmSync(leftover, { force: true });
			} catch {
				// A leftover backup or temp is harmless; the original file is untouched.
			}
		}
		return { kind: "failed", renamed, reason: error instanceof Error ? error.message : String(error) };
	}
}
