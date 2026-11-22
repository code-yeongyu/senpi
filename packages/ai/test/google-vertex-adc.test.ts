import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoogleAuth } from "google-auth-library";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getVertexAdcAccess } from "../src/api/google-vertex-adc.ts";

/**
 * The real ADC path, offline. The fixture is a workload-identity
 * `external_account` file: google-auth-library reads both `token_url` and the
 * subject-token URL from the file, so the whole exchange runs against a
 * loopback server and nothing leaves the machine. (A `service_account` file
 * cannot be used here: that flow hardcodes Google's token endpoint.)
 */
let fixtureDir: string;
let tokenUrl: string;
let subjectUrl: string;
let server: Server;
let tokenRequests = 0;

beforeAll(async () => {
	fixtureDir = mkdtempSync(join(tmpdir(), "senpi-vertex-adc-"));
	server = createServer((request, response) => {
		response.writeHead(200, { "content-type": "application/json" });
		if (request.url === "/subject") {
			response.end("fixture-subject-token");
			return;
		}
		tokenRequests += 1;
		response.end(
			JSON.stringify({
				access_token: "fixture-adc-token",
				issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
				token_type: "Bearer",
				expires_in: 3600,
			}),
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	tokenUrl = `http://127.0.0.1:${port}/token`;
	subjectUrl = `http://127.0.0.1:${port}/subject`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	rmSync(fixtureDir, { recursive: true, force: true });
});

afterEach(() => {
	vi.unstubAllEnvs();
});

let fixtureSequence = 0;

/** Writes one ADC file and points GOOGLE_APPLICATION_CREDENTIALS at it. */
function useAdcFixture(options: { quotaProjectId?: string } = {}): void {
	fixtureSequence += 1;
	const path = join(fixtureDir, `application_default_credentials_${fixtureSequence}.json`);
	writeFileSync(
		path,
		JSON.stringify({
			type: "external_account",
			audience:
				"//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/pool/providers/provider",
			subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
			token_url: tokenUrl,
			credential_source: { url: subjectUrl, format: { type: "text" } },
			...(options.quotaProjectId === undefined ? {} : { quota_project_id: options.quotaProjectId }),
		}),
	);
	vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", path);
	vi.stubEnv("GOOGLE_CLOUD_PROJECT", undefined);
	vi.stubEnv("GCLOUD_PROJECT", undefined);
	vi.stubEnv("GOOGLE_CLOUD_QUOTA_PROJECT", undefined);
}

describe("getVertexAdcAccess over the real ADC path", () => {
	it("#given an ADC fixture #when no project is named #then the token comes from the file's token endpoint", async () => {
		useAdcFixture({ quotaProjectId: "adc-quota-project" });
		const before = tokenRequests;

		const access = await getVertexAdcAccess();

		expect(access.accessToken).toBe("fixture-adc-token");
		expect(tokenRequests).toBeGreaterThan(before);
	});

	it("#given GOOGLE_CLOUD_PROJECT or GCLOUD_PROJECT #when ADC is present #then the named project outranks the ADC quota project", async () => {
		useAdcFixture({ quotaProjectId: "adc-quota-project" });
		vi.stubEnv("GOOGLE_CLOUD_PROJECT", "env-project");
		expect(await getVertexAdcAccess()).toMatchObject({
			project: "env-project",
			quotaProject: "adc-quota-project",
		});

		useAdcFixture({ quotaProjectId: "adc-quota-project" });
		vi.stubEnv("GCLOUD_PROJECT", "gcloud-project");
		expect(await getVertexAdcAccess()).toMatchObject({ project: "gcloud-project" });
	});

	it("#given an explicit project option #when ADC is present #then the option outranks every environment source", async () => {
		useAdcFixture({ quotaProjectId: "adc-quota-project" });
		vi.stubEnv("GOOGLE_CLOUD_PROJECT", "env-project");

		expect(await getVertexAdcAccess({ project: "option-project" })).toMatchObject({ project: "option-project" });
	});

	it("#given no project env var #when ADC carries a quota project #then the quota project is the target project", async () => {
		useAdcFixture({ quotaProjectId: "adc-quota-project" });

		expect(await getVertexAdcAccess()).toMatchObject({
			project: "adc-quota-project",
			quotaProject: "adc-quota-project",
		});
	});

	it("#given a credential source that answers without a token #then resolution fails with its own error", async () => {
		// A credential source outside google-auth-library's per-type guarantees (for
		// example an empty metadata answer) can surface an empty token instead of
		// throwing; the wrapper must reject loudly rather than hand out an unusable
		// credential.
		useAdcFixture({});
		const getClient = vi.spyOn(GoogleAuth.prototype, "getClient").mockResolvedValue({
			getAccessToken: async () => ({ token: null }),
			quotaProjectId: undefined,
		} as unknown as Awaited<ReturnType<GoogleAuth["getClient"]>>);

		try {
			await expect(getVertexAdcAccess()).rejects.toThrow("returned no access token");
		} finally {
			getClient.mockRestore();
		}
	});
});
