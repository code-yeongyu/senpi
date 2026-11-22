import type { CellSourceAtStart, EvalKernelRunInput } from "../../tool/types.ts";

/** The run input with its turn-time source applied, or the refusal to settle the cell with. */
export function inputAtStart<T extends EvalKernelRunInput>(input: T): T | { readonly refused: string } {
	if (input.resolveAtStart === undefined) return input;
	let source: CellSourceAtStart;
	try {
		source = input.resolveAtStart();
	} catch (error) {
		return { refused: error instanceof Error ? error.message : String(error) };
	}
	if (!source.ok) return { refused: source.message };
	return {
		...input,
		code: source.code,
		...(source.sourceFile === undefined ? {} : { sourceFile: source.sourceFile }),
	};
}
