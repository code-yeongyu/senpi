import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GoogleAdcFixture {
	/** GOOGLE_APPLICATION_CREDENTIALS path of the generated ADC file. */
	path: string;
	close(): Promise<void>;
}

export interface GoogleAdcFixtureOptions {
	quotaProjectId?: string;
	accessToken?: string;
}

/**
 * Offline Application Default Credentials fixture. The file is a workload-identity
 * `external_account` credential: google-auth-library reads both `token_url` and
 * the subject-token URL from it, so the full token exchange runs against a
 * loopback server. (A `service_account` file cannot be used offline — that flow
 * hardcodes Google's token endpoint.)
 */
export async function createGoogleAdcFixture(options: GoogleAdcFixtureOptions = {}): Promise<GoogleAdcFixture> {
	const dir = mkdtempSync(join(tmpdir(), "senpi-google-adc-"));
	const server: Server = createServer((request, response) => {
		response.writeHead(200, { "content-type": "application/json" });
		if (request.url === "/subject") {
			response.end("fixture-subject-token");
			return;
		}
		response.end(
			JSON.stringify({
				access_token: options.accessToken ?? "adc-access-token",
				issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
				token_type: "Bearer",
				expires_in: 3600,
			}),
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	const path = join(dir, "application_default_credentials.json");
	writeFileSync(
		path,
		JSON.stringify({
			type: "external_account",
			audience:
				"//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/pool/providers/provider",
			subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
			token_url: `http://127.0.0.1:${port}/token`,
			credential_source: { url: `http://127.0.0.1:${port}/subject`, format: { type: "text" } },
			...(options.quotaProjectId === undefined ? {} : { quota_project_id: options.quotaProjectId }),
		}),
	);
	return {
		path,
		close: async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
