/**
 * The name a supervisor sets so its host child reads the internal key from stdin.
 *
 * It lives in this leaf of its own because `internal-bootstrap.ts` CONSUMES it at module load: the
 * import performs the read and arms a deadline that SIGKILLs the process when no key arrives. Any
 * other module that only needs to recognise - or drop - the name imports it from here instead.
 */
export const INTERNAL_KEY_STDIN_ENV = "SENPI_RPC_INTERNAL_KEY_STDIN";
