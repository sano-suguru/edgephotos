// Pure constant (no DOM) so the unit tests can compare it with the server contract, like ./original-limit.ts.
// Also the `accept` attribute of the file input: a hint for the picker, never the reason a file is taken or
// refused. That is always decided from the bytes (./original-type.ts).
// Same as ORIGINAL_CONTENT_TYPES in src/contracts/schemas.ts (not imported: that module pulls zod into the bundle).
export const SUPPORTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] as const
export type SupportedType = (typeof SUPPORTED_TYPES)[number]
