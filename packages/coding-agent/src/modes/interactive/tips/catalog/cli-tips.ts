import { APP_NAME } from "../../../../config.ts";
import type { TipDefinition } from "./types.ts";

export const CLI_TIPS = [
	{
		id: "print-mode",
		bindings: [],
		render: () => `${APP_NAME} -p "question" answers without the TUI, and piped stdin is merged into the prompt.`,
	},
	{
		id: "tool-flags",
		bindings: [],
		render: () => "Limit a run's tools with -t read,bash, or drop a few with -xt write,edit.",
	},
] satisfies readonly TipDefinition[];
