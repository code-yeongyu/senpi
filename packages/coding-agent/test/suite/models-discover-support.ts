import { createServer, type IncomingHttpHeaders, type Server } from "node:http";

/** A local OpenAI-compatible `/models` endpoint for discovery tests (senpi#2196). */
export interface ListingServer {
	readonly baseUrl: string;
	readonly requests: Array<{ url: string | undefined; headers: IncomingHttpHeaders }>;
	/** Status and JSON body served to every request; replace it to change the listing. */
	listing: { status: number; body: unknown };
	/** When set, requests without this header value are answered 401. */
	requiredHeader?: { name: string; value: string };
	close(): Promise<void>;
}

export async function startListingServer(body: unknown): Promise<ListingServer> {
	const state: Omit<ListingServer, "baseUrl" | "close"> = { requests: [], listing: { status: 200, body } };
	const server: Server = createServer((request, response) => {
		state.requests.push({ url: request.url, headers: request.headers });
		const required = state.requiredHeader;
		const authorized = !required || request.headers[required.name.toLowerCase()] === required.value;
		response.writeHead(authorized ? state.listing.status : 401, { "content-type": "application/json" });
		response.end(JSON.stringify(authorized ? state.listing.body : { error: "missing tenant" }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (typeof address !== "object" || address === null) throw new Error("listing server has no TCP address");
	return Object.assign(state, {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	});
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `models` array models.json holds for one provider, read without trusting its shape. */
export function readProviderModels(content: string, providerId: string): unknown[] {
	const document: unknown = JSON.parse(content);
	const providers = isRecord(document) ? document.providers : undefined;
	const provider = isRecord(providers) ? providers[providerId] : undefined;
	const models = isRecord(provider) ? provider.models : undefined;
	return Array.isArray(models) ? models : [];
}
