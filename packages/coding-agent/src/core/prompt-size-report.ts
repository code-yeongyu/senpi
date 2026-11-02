import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import type { Tool } from "@earendil-works/pi-ai";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { DynamicSystemPromptPart } from "./dynamic-prompt/build.ts";
import type { BuildSystemPromptOptions } from "./extensions/types.ts";
import type { PromptSizeStartupNotes } from "./prompt-size-startup.ts";
import {
	COMPACT_SKILL_CATALOG_COUNT,
	COMPACT_SKILL_CATALOG_DESCRIPTION_BYTES,
	MAX_SKILL_CATALOG_BYTES,
} from "./skills-prompt.ts";

export interface PromptSizeEntry {
	readonly name: string;
	readonly source: string;
	readonly bytes: number;
	readonly estimatedTokens: number;
	readonly boundingSettings: readonly string[] | null;
	readonly count?: number;
	readonly rewritten?: boolean;
	readonly files?: readonly PromptSizeEntry[];
	readonly topTools?: readonly { readonly name: string; readonly bytes: number }[];
}

export interface PromptSizeReport extends Partial<PromptSizeStartupNotes> {
	readonly sections: readonly PromptSizeEntry[];
	readonly total: { readonly bytes: number; readonly estimatedTokens: number };
	readonly presetPartsMismatch?: { readonly names: readonly string[]; readonly note: string };
}

function entry(part: DynamicSystemPromptPart): PromptSizeEntry {
	const source = part.source ?? part.name;
	const home = [homedir(), realpathSync(homedir())].find((path) => source === path || source.startsWith(`${path}/`));
	return {
		name: part.name,
		source: home === undefined ? source : source === home ? "~" : `~/${source.slice(home.length + 1)}`,
		bytes: Buffer.byteLength(part.text, "utf8"),
		estimatedTokens: estimateTextTokens(part.text),
		boundingSettings:
			part.name === "project_context" ? ["contextFiles.maxBytesPerFile", "contextFiles.maxTotalBytes"] : null,
	};
}

/** Metadata only; prompt text never escapes into the report. */
export class PromptSizeAccounting {
	readonly #entries: PromptSizeEntry[];
	readonly #skillCount: number;
	readonly #extensionNames: ReadonlyMap<string, string>;
	readonly #presetPartsMismatch: string[] = [];

	constructor(input: {
		readonly base: string;
		readonly options: BuildSystemPromptOptions;
		readonly parts: readonly DynamicSystemPromptPart[];
		readonly extensionNames: ReadonlyMap<string, string>;
	}) {
		const { base, options, parts } = input;
		this.#extensionNames = input.extensionNames;
		const rendered = parts.map((part) => part.text).join("");
		// Session policies may append guidance after the dynamic builder. Preserve it as
		// its own contribution; a truly opaque loader/preset stays one opaque component.
		this.#entries =
			parts.length > 0 && base.startsWith(rendered)
				? [
						...parts,
						...(base === rendered ? [] : [{ name: "session_policy", text: base.slice(rendered.length) }]),
					].map(entry)
				: [entry({ name: "core", source: "session", text: base })];
		this.#skillCount = (options.skills ?? []).filter((skill) => !skill.disableModelInvocation).length;
	}

	observe(contribution: {
		readonly path: string;
		readonly before: string;
		readonly after: string;
		readonly parts?: readonly DynamicSystemPromptPart[];
	}): void {
		const { path, before, after, parts } = contribution;
		const name = this.#extensionNames.get(path) ?? path.replace(/^<[^:]+:|>$/g, "");
		if (parts !== undefined) {
			if (parts.map((part) => part.text).join("") === after) {
				this.#entries.splice(0, this.#entries.length, ...parts.map(entry));
				return;
			}
			this.#presetPartsMismatch.push(name);
		}
		if (before === after) return;
		const added = after.startsWith(before)
			? after.slice(before.length)
			: after.endsWith(before)
				? after.slice(0, after.length - before.length)
				: undefined;
		this.#entries.push({
			name: `extension:${name}`,
			source: name,
			bytes: Buffer.byteLength(after) - Buffer.byteLength(before),
			estimatedTokens:
				added === undefined ? estimateTextTokens(after) - estimateTextTokens(before) : estimateTextTokens(added),
			boundingSettings: null,
			...(added === undefined ? { rewritten: true } : {}),
		});
	}

	report(tools: readonly Tool[]): PromptSizeReport {
		const sections: PromptSizeEntry[] = [];
		const project = this.#entries.filter((part) => part.name === "project_context");
		for (const part of this.#entries) {
			if (part.name === "project_context") continue;
			sections.push(
				part.name === "skills"
					? {
							...part,
							count: this.#skillCount,
							boundingSettings: [
								`MAX_SKILL_CATALOG_BYTES (${MAX_SKILL_CATALOG_BYTES})`,
								`COMPACT_SKILL_CATALOG_COUNT (${COMPACT_SKILL_CATALOG_COUNT})`,
								`COMPACT_SKILL_CATALOG_DESCRIPTION_BYTES (${COMPACT_SKILL_CATALOG_DESCRIPTION_BYTES})`,
							],
						}
					: part,
			);
		}
		if (project.length > 0) {
			sections.push({
				name: "project_context",
				source: project[0]?.source.startsWith("prompt-preset:") ? project[0].source : "context files",
				bytes: project.reduce((sum, part) => sum + part.bytes, 0),
				estimatedTokens: project.reduce((sum, part) => sum + part.estimatedTokens, 0),
				boundingSettings: ["contextFiles.maxBytesPerFile", "contextFiles.maxTotalBytes"],
				files: project
					.filter((part) => part.source !== "dynamic-prompt" && !part.source.startsWith("prompt-preset:"))
					.sort((a, b) => b.bytes - a.bytes),
			});
		}
		const serializedTools = JSON.stringify(tools);
		sections.push({
			...entry({ name: "tools", source: "provider declarations", text: serializedTools }),
			count: tools.length,
			topTools: tools
				.map((tool) => ({ name: tool.name, bytes: Buffer.byteLength(JSON.stringify(tool)) }))
				.sort((a, b) => b.bytes - a.bytes)
				.slice(0, 10),
		});
		sections.sort((a, b) => b.bytes - a.bytes);
		return {
			sections,
			total: {
				bytes: sections.reduce((sum, part) => sum + part.bytes, 0),
				estimatedTokens: sections.reduce((sum, part) => sum + part.estimatedTokens, 0),
			},
			...(this.#presetPartsMismatch.length === 0
				? {}
				: {
						presetPartsMismatch: {
							names: [...this.#presetPartsMismatch],
							note: "replacement parts did not join to its prompt; its row is the net delta",
						},
					}),
		};
	}
}
