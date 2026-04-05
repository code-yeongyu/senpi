import type { ExtensionFactory } from "../types.js";
import diffExtension from "./diff.js";
import filesExtension from "./files.js";
import promptUrlWidgetExtension from "./prompt-url-widget.js";
import redrawsExtension from "./redraws.js";
import todowriteExtension from "./todowrite.js";
import tpsExtension from "./tps.js";

export interface BuiltinExtensionFactory {
	id: string;
	factory: ExtensionFactory;
}

export const builtinExtensions: BuiltinExtensionFactory[] = [
	{ id: "todowrite", factory: todowriteExtension },
	{ id: "diff", factory: diffExtension },
	{ id: "files", factory: filesExtension },
	{ id: "prompt-url-widget", factory: promptUrlWidgetExtension },
	{ id: "redraws", factory: redrawsExtension },
	{ id: "tps", factory: tpsExtension },
];
