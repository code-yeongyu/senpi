import type { ExtensionAPI } from "../../types.ts";
import { registerTrashTool } from "./tool.ts";

export default function deletePolicyExtension(pi: ExtensionAPI): void {
	registerTrashTool(pi);
}
