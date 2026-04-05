import type { ExtensionFactory } from "../types.js";
import diffExtension from "./diff.js";
import filesExtension from "./files.js";
import promptUrlWidgetExtension from "./prompt-url-widget.js";
import redrawsExtension from "./redraws.js";
import todowriteExtension from "./todowrite.js";
import tpsExtension from "./tps.js";

export const builtinExtensions: ExtensionFactory[] = [
	todowriteExtension,
	diffExtension,
	filesExtension,
	promptUrlWidgetExtension,
	redrawsExtension,
	tpsExtension,
];
