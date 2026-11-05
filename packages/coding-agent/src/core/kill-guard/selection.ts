import type { BashCommandWord } from "../extensions/builtin/permission-system/bash-command-segments.ts";
import { type OptionSpec, type OptionTable, optionTable, type SelectingTool, signalNumberOrName } from "./options.ts";
import { dynamicVerdict, type Situation } from "./situation.ts";
import type { KillGuardVerdict } from "./types.ts";

/** What one `pkill`/`pgrep`/`killall` call selects, read from its words with the platform's option table. */
export interface Selection {
	readonly tool: SelectingTool;
	readonly patterns: string[];
	/** Arguments for the dry-run `pgrep`, without the patterns. */
	readonly args: string[];
	exact: boolean;
	regex: boolean;
	groups: boolean;
	ancestors: boolean;
	ignoreAncestors: boolean;
	ignoreCase: boolean;
	selectors: number;
	signalZero: boolean;
	sendsNothing: boolean;
	unknownOption?: string;
	/** `-g 0` / `-s 0`, resolved against the caller. */
	readonly callerRelative: { readonly option: string; readonly kind: "pgid" | "sid" }[];
	dynamic?: KillGuardVerdict;
}

const literal = (text: string): BashCommandWord => ({ text, dynamic: false, quoted: false, literalPrefix: text });

/** A cluster of short flags (`-fx`) as separate words, when every letter is a flag of the table. */
function expandClusters(words: readonly BashCommandWord[], table: OptionTable): BashCommandWord[] {
	return words.flatMap((word, index) => {
		const text = word.text;
		if (word.dynamic || !/^-[A-Za-z]{2,}$/.test(text) || table.has(text)) return [word];
		if (index === 0 && signalNumberOrName(text.slice(1)) !== undefined) return [word];
		const letters = text.slice(1).split("");
		const flags = letters.every((letter, position) => {
			const spec = table.get(`-${letter}`);
			return spec !== undefined && (!spec.takesValue || position === letters.length - 1);
		});
		return flags ? letters.map((letter) => literal(`-${letter}`)) : [word];
	});
}

/** `-u501` / `--euid=501`: an option with its value attached. */
function splitOption(text: string, table: OptionTable): [string, string | undefined] {
	if (text.startsWith("--")) {
		const equals = text.indexOf("=");
		return equals < 0 ? [text, undefined] : [text.slice(0, equals), text.slice(equals + 1)];
	}
	if (table.has(text)) return [text, undefined];
	const head = text.slice(0, 2);
	if (table.get(head)?.takesValue) return [head, text.slice(2)];
	return [text, undefined];
}

function forward(selection: Selection, spec: OptionSpec, short: string, value: string | undefined): void {
	if (spec.ignoreAncestors) return;
	if (selection.tool === "killall") {
		// BSD `killall -c NAME` names the process; `-u` and `-t` select like pgrep's own options.
		if (short === "-c" && value !== undefined) selection.patterns.push(value);
		else if (spec.selector && value !== undefined) selection.args.push(short, value);
		return;
	}
	if (spec.callerRelative !== undefined && value !== undefined && value.split(",").includes("0")) {
		selection.callerRelative.push({ option: short, kind: spec.callerRelative });
		return;
	}
	selection.args.push(short, ...(value === undefined ? [] : [value]));
}

function applyOption(selection: Selection, spec: OptionSpec, short: string, value: string | undefined): void {
	if (spec.signal) {
		if (value !== undefined && signalNumberOrName(value)?.zero === true) selection.signalZero = true;
		return;
	}
	if (spec.exact) selection.exact = true;
	if (spec.regex) {
		selection.regex = true;
		selection.exact = false;
	}
	if (spec.groups) selection.groups = true;
	if (spec.ancestors) selection.ancestors = true;
	if (spec.ignoreAncestors) selection.ignoreAncestors = true;
	if (spec.ignoreCase) selection.ignoreCase = true;
	if (spec.selector) selection.selectors += 1;
	switch (spec.action) {
		case "allow":
			selection.sendsNothing = true;
			return;
		case "unknown":
			selection.unknownOption ??= short;
			return;
		case "drop":
		case "skip":
			return;
		case "forward":
			forward(selection, spec, short, value);
			return;
	}
}

export function readSelection(situation: Situation, tool: SelectingTool, platform: string): Selection {
	const table = optionTable(tool, platform);
	const selection: Selection = {
		tool,
		patterns: [],
		args: [],
		exact: tool === "killall",
		regex: false,
		groups: false,
		ancestors: false,
		ignoreAncestors: false,
		ignoreCase: false,
		selectors: 0,
		signalZero: false,
		sendsNothing: false,
		callerRelative: [],
	};
	const words = expandClusters(situation.segment.words, table);
	const noteDynamic = (what: string) => {
		selection.dynamic ??= dynamicVerdict(situation, what);
	};
	let optionsDone = false;
	for (let index = 0; index < words.length; index += 1) {
		const word = words[index];
		if (word === undefined) continue;
		if (optionsDone || !word.literalPrefix.startsWith("-") || word.text === "-") {
			if (word.dynamic) noteDynamic("a dynamic pattern");
			else selection.patterns.push(word.text);
			continue;
		}
		if (word.dynamic) {
			noteDynamic("a dynamic option");
			continue;
		}
		if (word.text === "--") {
			optionsDone = true;
			continue;
		}
		const signal = signalNumberOrName(word.text.slice(1));
		if (signal !== undefined && (index === 0 || tool === "killall")) {
			if (signal.zero) selection.signalZero = true;
			continue;
		}
		const [name, attached] = splitOption(word.text, table);
		const spec = table.get(name);
		if (spec === undefined) {
			selection.unknownOption ??= word.text;
			continue;
		}
		let value: BashCommandWord | undefined;
		if (spec.takesValue) {
			value = attached === undefined ? words[index + 1] : literal(attached);
			if (attached === undefined) index += 1;
		}
		if (value?.dynamic) {
			noteDynamic("a dynamic option value");
			continue;
		}
		applyOption(selection, spec, spec.short ?? name, value?.text);
	}
	return selection;
}
