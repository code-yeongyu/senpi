import type { ExtensionAPI } from "../../types.ts";
import { createSessionLivenessWatcher } from "./watcher.ts";

export default function sessionLivenessExtension(pi: ExtensionAPI): void {
	createSessionLivenessWatcher(pi);
}
