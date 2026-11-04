// The runtime-gated prompt parts the Z1.n Node smoke (scenarios/node-smoke-qa.mjs) removes before comparing a Node run
// with a Bun run. They are the two designed Node/Bun differences in today's prompt; every removal is counted, and a
// designed difference that matched nothing fails the smoke, so a rename (senpi#5158: the codemode skill `bun-1-4` became
// `bun`) breaks it loudly instead of leaving the unstripped difference to read as a Node/Bun regression.
// - senpi-codemode contributes its Bun skill only when the process itself runs on Bun >= 1.4
//   (packages/senpi-codemode/src/extension/skill-contribution.ts): that skill root and skill entry;
// - the eval tool's description carries one line naming the runtime its js kernel runs on (`JS runs under Node.js
//   worker: ...` / `JS runs in-process on Bun <version>: ...`): that one line, on each runtime.

export const RUNTIME_GATED = {
	bun: [
		["removedSkillRoots", /\n {2}<r(\d+)><repo>\/packages\/senpi-codemode\/src\/skill<\/r\1>/g],
		[
			"removedSkillEntries",
			/\n {2}<skill>\n {4}<name>bun<\/name>\n {4}<description>[^<]*<\/description>\n {4}<location>r\d+\/bun\/SKILL\.md<\/location>\n {2}<\/skill>/g,
		],
		["removedKernelRuntimeLines", /\nJS runs in-process on Bun \d+\.\d+\.\d+: [^\n]*/g],
	],
	node: [["removedKernelRuntimeLines", /\nJS runs under Node\.js worker: [^\n]*/g]],
};

/** Removes the runtime's gated parts from every string in `value`, adding each removal to `counts`. */
export function withoutRuntimeGated(value, patterns, counts) {
	if (typeof value === "string") {
		return patterns.reduce((text, [name, pattern]) => {
			const matches = text.match(pattern)?.length ?? 0;
			counts[name] += matches;
			return matches ? text.replace(pattern, "") : text;
		}, value);
	}
	if (Array.isArray(value)) return value.map((item) => withoutRuntimeGated(item, patterns, counts));
	if (value && typeof value === "object")
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutRuntimeGated(v, patterns, counts)]));
	return value;
}

/** `runtime.removal` names whose designed difference matched nothing in that runtime's run. */
export function unmatchedGatedRemovals(runtimeGated) {
	return Object.entries(runtimeGated).flatMap(([runtime, counts]) =>
		Object.entries(counts)
			.filter(([, count]) => count === 0)
			.map(([name]) => `${runtime}.${name}`),
	);
}
