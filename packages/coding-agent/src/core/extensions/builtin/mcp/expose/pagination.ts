export interface McpListPage<TItem> {
	items?: TItem[];
	tools?: TItem[];
	resources?: TItem[];
	prompts?: TItem[];
	nextCursor?: string;
}

export interface McpPaginationResult<TItem> {
	items: TItem[];
	warnings: string[];
	pages: number;
}

const MAX_MCP_PAGES = 1000;

export async function collectAllPages<TItem>(
	listFn: (cursor: string | undefined) => Promise<McpListPage<TItem>>,
): Promise<McpPaginationResult<TItem>> {
	const items: TItem[] = [];
	const warnings: string[] = [];
	const seenCursors = new Set<string>();
	let cursor: string | undefined;
	let pages = 0;

	while (pages < MAX_MCP_PAGES) {
		const page = await listFn(cursor);
		pages += 1;
		items.push(...getPageItems(page));

		const nextCursor = page.nextCursor;
		if (!nextCursor) {
			return { items, warnings, pages };
		}
		if (seenCursors.has(nextCursor)) {
			warnings.push(`Stopped MCP pagination after duplicate cursor '${nextCursor}'.`);
			return { items, warnings, pages };
		}
		seenCursors.add(nextCursor);
		cursor = nextCursor;
	}

	warnings.push(`Stopped MCP pagination after ${MAX_MCP_PAGES} pages.`);
	return { items, warnings, pages };
}

function getPageItems<TItem>(page: McpListPage<TItem>): TItem[] {
	return page.items ?? page.tools ?? page.resources ?? page.prompts ?? [];
}
