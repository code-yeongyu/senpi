import type { SessionInfo } from "../../../core/session-manager.ts";
import { canonicalizePath } from "../../../utils/paths.ts";

/** A session tree node for hierarchical display */
export interface SessionTreeNode {
	session: SessionInfo;
	children: SessionTreeNode[];
	latestActivity: number;
}

/** Flattened node for display with tree structure info */
export interface FlatSessionNode {
	session: SessionInfo;
	depth: number;
	isLast: boolean;
	/** For each ancestor level, whether there are more siblings after it */
	ancestorContinues: boolean[];
}

export type CanonicalPathResolver = (path: string | undefined) => string | undefined;

/**
 * {@link canonicalizePath} memoized per path. Create one per sessions array: a rebuilt list gets a
 * fresh resolver, so its answers are as current as the listing they belong to, while tree
 * rebuilds and per-row current-session checks on the same list stop hitting the filesystem.
 */
export function createCanonicalPathResolver(): CanonicalPathResolver {
	const cache = new Map<string, string>();
	return (path) => {
		if (!path) return path;
		let canonical = cache.get(path);
		if (canonical === undefined) {
			canonical = canonicalizePath(path);
			cache.set(path, canonical);
		}
		return canonical;
	};
}

/**
 * Build a tree structure from sessions based on parentSessionPath.
 * Returns root nodes sorted by modified date (descending).
 */
export function buildSessionTree(sessions: SessionInfo[], canonicalize: CanonicalPathResolver): SessionTreeNode[] {
	const byPath = new Map<string, SessionTreeNode>();

	for (const session of sessions) {
		const sessionPath = canonicalize(session.path) ?? session.path;
		byPath.set(sessionPath, { session, children: [], latestActivity: session.modified.getTime() });
	}

	const roots: SessionTreeNode[] = [];

	for (const session of sessions) {
		const sessionPath = canonicalize(session.path) ?? session.path;
		const node = byPath.get(sessionPath)!;
		const parentPath = canonicalize(session.parentSessionPath);

		if (parentPath && byPath.has(parentPath)) {
			byPath.get(parentPath)!.children.push(node);
		} else {
			roots.push(node);
		}
	}

	const updateLatestActivity = (node: SessionTreeNode): number => {
		let latestActivity = node.session.modified.getTime();
		for (const child of node.children) {
			latestActivity = Math.max(latestActivity, updateLatestActivity(child));
		}
		node.latestActivity = latestActivity;
		return latestActivity;
	};

	for (const root of roots) {
		updateLatestActivity(root);
	}

	// Sort children and roots by latest activity in each subtree (descending)
	const sortNodes = (nodes: SessionTreeNode[]): void => {
		nodes.sort((a, b) => b.latestActivity - a.latestActivity);
		for (const node of nodes) {
			sortNodes(node.children);
		}
	};
	sortNodes(roots);

	return roots;
}

/**
 * Flatten tree into display list with tree structure metadata.
 */
export function flattenSessionTree(roots: SessionTreeNode[]): FlatSessionNode[] {
	const result: FlatSessionNode[] = [];

	const walk = (node: SessionTreeNode, depth: number, ancestorContinues: boolean[], isLast: boolean): void => {
		result.push({ session: node.session, depth, isLast, ancestorContinues });

		for (let i = 0; i < node.children.length; i++) {
			const childIsLast = i === node.children.length - 1;
			// Only show continuation line for non-root ancestors
			const continues = depth > 0 ? !isLast : false;
			walk(node.children[i]!, depth + 1, [...ancestorContinues, continues], childIsLast);
		}
	};

	for (let i = 0; i < roots.length; i++) {
		walk(roots[i]!, 0, [], i === roots.length - 1);
	}

	return result;
}
