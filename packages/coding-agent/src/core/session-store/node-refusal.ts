/**
 * The Node refusal's stable literals, in a module with no imports: the test setup reads them before any source module
 * loads, and importing `node-guard.ts` there evaluates `config.ts` early (measured: it turned
 * test/extension-system-migration and test/permission/4351-case-sensitive-links red, senpi#6036). Keep this file import-free.
 */

/** The stable code every Node refusal carries: the SDK's typed error, and the test run's refusal log. */
export const NODE_HOST_REFUSED = "NODE_HOST_REFUSED";

/** Test seam (senpi#6036): only the coding-agent Node test run sets this, to a per-test-file refusal log. */
export const NODE_HOST_REFUSAL_LOG_ENV = "SENPI_TEST_NODE_HOST_REFUSAL_LOG";
