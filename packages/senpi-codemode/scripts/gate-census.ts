import { readFile } from "node:fs/promises";
import type { EvalLanguage } from "../src/tool/types.ts";

/** Discover public candidates from the installation seam, then witness them inside the initialized kernel. */
export async function helperCandidates(input: {
	readonly target: string;
	readonly language: EvalLanguage;
	readonly golden: readonly string[];
}): Promise<readonly string[]> {
	const files = {
		js: ["js/worker-runtime.js"],
		py: ["py/prelude.py"],
		rb: ["rb/prelude.rb", "rb/workpool.rb"],
		jl: ["jl/prelude.jl"],
	};
	const source = (await Promise.all(files[input.language].map(
		(file) => readFile(`${input.target}/src/kernels/${file}`, "utf8"),
	))).join("\n");
	let candidates: readonly string[];
	switch (input.language) {
		case "js":
			candidates = [...source.matchAll(/globalThis\.([a-zA-Z_]\w*)\s*=/gu)].map((match) => match[1] ?? "");
			break;
		case "py": {
			const exports = source.split("USER_NS.update(")[1]?.split("\n)\n")[0] ?? "";
			candidates = [...exports.matchAll(/"([a-zA-Z_]\w*)"\s*:/gu)].map((match) => match[1] ?? "");
			break;
		}
		case "rb":
			candidates = [...source.matchAll(/^def ([a-zA-Z_]\w*[!?=]?)/gmu)].map((match) => match[1] ?? "");
			break;
		case "jl":
			candidates = [...source.matchAll(/^function ([a-zA-Z_]\w*!?)\s*\(/gmu)].map((match) => match[1] ?? "");
			break;
		default:
			return assertNever(input.language);
	}
	return [...new Set([...input.golden, ...candidates.filter((name) => name && !name.startsWith("_") && !name.startsWith("senpi_"))])].sort();
}

function assertNever(value: never): never {
	throw new TypeError(`Unsupported census language: ${value}`);
}
