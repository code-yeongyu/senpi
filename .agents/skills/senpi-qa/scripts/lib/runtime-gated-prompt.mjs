// The designed Node/Bun differences in a Z1.n smoke prompt, removed per runtime before the comparison. Every removal is
// counted for the receipt and nothing else is touched:
// - senpi-codemode contributes its bundled skill only when the process itself runs on Bun >= 1.4
//   (packages/senpi-codemode/src/extension/skill-contribution.ts activeBunSkillPath). The skill is found by the root it
//   lives under, the codemode skill directory, never by its name: a rename (senpi#5158 bun-1-4 -> bun, senpi#5396)
//   must not turn the gated entry into a runtime difference;
// - the eval tool's description carries one line naming the runtime its js kernel runs on (`JS runs under Node.js
//   worker: ...` / `JS runs in-process on Bun <version>: ...`): that one line, on each runtime.

const CODEMODE_SKILL_ROOT = /\n {2}<r(\d+)><repo>\/packages\/senpi-codemode\/src\/skill<\/r\1>/g;
const KERNEL_RUNTIME_LINE = {
	bun: /\nJS runs in-process on Bun \d+\.\d+\.\d+: [^\n]*/g,
	node: /\nJS runs under Node\.js worker: [^\n]*/g,
};

const RUNTIME_GATED_COUNTS = {
	bun: ["removedSkillRoots", "removedSkillEntries", "removedKernelRuntimeLines"],
	node: ["removedKernelRuntimeLines"],
};

/** Every catalog entry located under root alias `rN`: the XML `<skill>` block and the compact `- name [rN...]` line. */
function skillEntriesUnder(alias) {
	return [
		new RegExp(
			String.raw`\n {2}<skill>\n {4}<name>[^<]*</name>\n(?: {4}<description>[^<]*</description>\n)? {4}<location>${alias}/[^<]*</location>\n {2}</skill>`,
			"g",
		),
		new RegExp(String.raw`\n- [^\n\[]+ \[${alias}(?:/[^\]]*)?\][^\n]*`, "g"),
	];
}

function removeAll(text, pattern) {
	const matches = text.match(pattern)?.length ?? 0;
	return { text: matches ? text.replace(pattern, "") : text, matches };
}

function withoutCodemodeSkills(text, counts) {
	const aliases = [...text.matchAll(CODEMODE_SKILL_ROOT)].map((match) => `r${match[1]}`);
	let rest = removeAll(text, CODEMODE_SKILL_ROOT);
	counts.removedSkillRoots += rest.matches;
	for (const alias of aliases) {
		let entries = 0;
		for (const pattern of skillEntriesUnder(alias)) {
			rest = removeAll(rest.text, pattern);
			entries += rest.matches;
		}
		// A root listed with no entry under it means the catalog format moved: fail here rather than diff silently.
		if (entries === 0)
			throw new Error(`codemode skill root ${alias} is in the prompt but no skill entry under ${alias}/ was found`);
		counts.removedSkillEntries += entries;
	}
	return rest.text;
}

function withoutGatedText(text, runtime, counts) {
	const withoutSkills = runtime === "bun" ? withoutCodemodeSkills(text, counts) : text;
	const rest = removeAll(withoutSkills, KERNEL_RUNTIME_LINE[runtime]);
	counts.removedKernelRuntimeLines += rest.matches;
	return rest.text;
}

function walk(value, runtime, counts) {
	if (typeof value === "string") return withoutGatedText(value, runtime, counts);
	if (Array.isArray(value)) return value.map((item) => walk(item, runtime, counts));
	if (value && typeof value === "object")
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, runtime, counts)]));
	return value;
}

/** `value` with `runtime`'s designed differences removed, and how many of each were removed. */
export function withoutRuntimeGated(value, runtime) {
	const counts = Object.fromEntries(RUNTIME_GATED_COUNTS[runtime].map((name) => [name, 0]));
	return { value: walk(value, runtime, counts), counts };
}
