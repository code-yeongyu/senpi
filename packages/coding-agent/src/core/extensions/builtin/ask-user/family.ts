import type { Model } from "@earendil-works/pi-ai";
import { getApplyPatchWireMode } from "../gpt-apply-patch/index.ts";
import type { AskUserVariant } from "./schema.ts";

export function pickVariant(model: Pick<Model<string>, "api" | "id"> | undefined): AskUserVariant {
	return getApplyPatchWireMode(model) !== "none" ? "codex" : "claude";
}
export const TOOL_NAMES = { codex: "request_user_input", claude: "ask_user_question" };
