import { bashToolSystemPromptContribution } from "../../src/core/tools/bash.ts";
import type { ToolDeclaration } from "../../src/modes/hand/tool-catalog.ts";

/**
 * The one intended difference between a hand's declaration and the fused engine's: a hand runs the core `bash` without
 * the session's PI_* environment (senpi#5433, `exposeSessionEnvironment: false`, the hand knowing nothing of the
 * session), so that tool does not advertise the guideline about those variables. The fused declaration is compared with
 * exactly that guideline removed, and only when the hand's core `bash` really lacks it.
 */
export function expectedOnHand(fused: ToolDeclaration, hand: ToolDeclaration): ToolDeclaration {
	const sessionEnvironment: readonly string[] = bashToolSystemPromptContribution.guidelines;
	const onlySessionEnvironment =
		fused.name === "bash" &&
		hand.promptGuidelines === undefined &&
		JSON.stringify(fused.promptGuidelines) === JSON.stringify(sessionEnvironment);
	return onlySessionEnvironment ? { ...fused, promptGuidelines: undefined } : fused;
}
