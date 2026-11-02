/**
 * The environment names an ensure uses to hand a spawned host its identity.
 *
 * They live in their own dependency-free module because the lifecycle supervisor needs them and
 * nothing else from `protocol-identity.ts`, whose launch-profile parsing imports the CLI argument
 * parser and, through it, the whole provider catalog. A supervisor runs once per task shard and
 * Desktop thread host, so that graph was resident in every one of them.
 */

/**
 * Generation of this host within its daemon directory, handed to it by the ensure call
 * that spawned it (the daemon settings travel to the host through its environment).
 * Absent - a bare host nobody ensured - is generation 0.
 */
export const HOST_GENERATION_ENV = "SENPI_RPC_HOST_GENERATION";

/**
 * Identity of the host being spawned, chosen by the ensure that spawns it so the daemon directory
 * can hold that generation's state before the process exists. A host nobody ensured names itself.
 */
export const HOST_INSTANCE_ID_ENV = "SENPI_RPC_HOST_INSTANCE_ID";

/**
 * Namespace of the internal-key hand-off a supervisor gives the host child it spawns. It belongs in
 * this module for the same reason the two names above do: the supervisor's launch writes it, and a
 * module of its own would be one more module in the supervisor's graph, which is a budget
 * (`test/supervisor-import-graph.test.ts`). `internal-bootstrap.ts` cannot own it either - importing
 * that module CONSUMES the sentinel at load, reading stdin and arming a SIGKILL deadline - so the
 * dependency-free hand-off module owns it and the bootstrap imports it from here.
 */
export const INTERNAL_KEY_ENV_PREFIX = "SENPI_RPC_INTERNAL_KEY";

/** Set to `1` when the child must read its 32-byte internal key from stdin before anything else. */
export const INTERNAL_KEY_STDIN_ENV = `${INTERNAL_KEY_ENV_PREFIX}_STDIN`;
