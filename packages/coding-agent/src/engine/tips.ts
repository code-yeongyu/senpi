import { collectTips, type ListedTip } from "../cli/list-tips.ts";
import { type EngineOk, engineOk } from "./result.ts";

/** The tip catalog, rendered with the default keybindings. */
export function tips(): EngineOk<readonly ListedTip[]> {
	return engineOk(collectTips());
}
