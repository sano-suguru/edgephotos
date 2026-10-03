// Pure constant (no DOM) so the unit tests can compare it with the server contract.
// Same as LIMITS.originalMaxBytes in src/contracts/schemas.ts (not imported: that module pulls zod into the bundle).
export const ORIGINAL_MAX_BYTES = 100 * 1024 * 1024

// Same as LIMITS.serverDerivativeMaxBytes: up to this size the server renders the thumbnail / preview (D-042).
export const SERVER_DERIVATIVE_MAX_BYTES = 20_000_000
