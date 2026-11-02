import { pathToFileURL } from "node:url";

import { getCapabilities } from "@earendil-works/pi-tui";

import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import {
	isLocalMessagePath,
	messagePathProjectRoot,
	type ResolvedMessagePath,
	resolveMessagePath,
} from "../../../core/message-path-resolution.ts";

/**
 * Links in a message whose target is a path (`[plan](docs/plan.md)`) become `file://` links to the
 * file the engine's one rule finds (`resolveMessagePath`), so the terminal opens the same file the
 * desktop app and RPC clients do (#3415). Only when the terminal shows hyperlinks: otherwise the
 * link text would print a long absolute path. URLs, anchors, images, fenced and indented code and
 * inline code are left alone; a path that resolves to nothing keeps its text; a network or device
 * path is never resolved (#3419 review). Each answer, found or not, is remembered per working
 * directory, so a streaming message re-renders without touching the disk again.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const INDENTED_CODE = /^(?: {4}|\t)/;
const LINK = /(!?)\[([^\]]*)\]\(\s*([^)\s]+)((?:\s+"[^"]*")?)\s*\)/g;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const DRIVE = /^[A-Za-z]:[\\/]/;
const CACHE_LIMIT = 256;

export interface MessagePathLinkOptions {
	readonly hyperlinks?: () => boolean;
	readonly resolve?: (input: { path: string; cwd: string; projectRoot?: string }) => ResolvedMessagePath;
}

export function createMessagePathLinkTransformer(
	getCwd: () => string,
	options: MessagePathLinkOptions = {},
): MarkdownTransformer {
	const hyperlinks = options.hyperlinks ?? (() => getCapabilities().hyperlinks);
	const resolvePath = options.resolve ?? resolveMessagePath;
	const answers = new Map<string, string | null>();
	const projectRoots = new Map<string, string | undefined>();

	const remember = (key: string, url: string | null) => {
		answers.delete(key);
		if (answers.size >= CACHE_LIMIT) answers.delete(answers.keys().next().value ?? "");
		answers.set(key, url);
	};

	const projectRootOf = (cwd: string) => {
		if (!projectRoots.has(cwd)) projectRoots.set(cwd, messagePathProjectRoot(cwd));
		return projectRoots.get(cwd);
	};

	const urlFor = (rawPath: string, cwd: string): string | null => {
		const key = `${cwd}\0${rawPath}`;
		const known = answers.get(key);
		if (known !== undefined) {
			remember(key, known);
			return known;
		}
		let path: string;
		try {
			path = decodeURI(rawPath);
		} catch {
			remember(key, null);
			return null;
		}
		if (/^[\\/]{2}/.test(path) || (/^[\\/]/.test(path) && !isLocalMessagePath(path))) {
			remember(key, null);
			return null;
		}
		const projectRoot = projectRootOf(cwd);
		const answer = resolvePath({ path, cwd, ...(projectRoot === undefined ? {} : { projectRoot }) });
		const url = answer.status === "found" ? pathToFileURL(answer.realpath).href : null;
		remember(key, url);
		return url;
	};

	const rewriteLink = (cwd: string) => (whole: string, bang: string, text: string, target: string, title: string) => {
		if (bang === "!" || target.startsWith("#") || target.startsWith("<")) return whole;
		if (SCHEME.test(target) && !DRIVE.test(target)) return whole;
		const hashAt = target.indexOf("#");
		const path = hashAt === -1 ? target : target.slice(0, hashAt);
		const url = path.length === 0 ? null : urlFor(path, cwd);
		return url === null ? whole : `[${text}](${url}${hashAt === -1 ? "" : target.slice(hashAt)}${title})`;
	};

	const rewriteOutsideInlineCode = (line: string, cwd: string): string =>
		line
			.split(/(`+[^`]*`+)/)
			.map((part, index) => (index % 2 === 1 ? part : part.replace(LINK, rewriteLink(cwd))))
			.join("");

	return (markdown) => {
		if (!markdown.includes("](") || !hyperlinks()) return markdown;
		const cwd = getCwd();
		let fence: string | undefined;
		return markdown
			.split("\n")
			.map((line) => {
				const marker = FENCE.exec(line)?.[1];
				if (fence !== undefined) {
					if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
					return line;
				}
				if (marker !== undefined) {
					fence = marker;
					return line;
				}
				return INDENTED_CODE.test(line) ? line : rewriteOutsideInlineCode(line, cwd);
			})
			.join("\n");
	};
}
