// 200 MB default cap on any single upload, overridable via MAX_UPLOAD_BYTES.
// Kept as a plain constant (not ConfigService-driven) so it can be imported
// by class-validator decorators, which are evaluated before DI exists.
export const MAX_UPLOAD_BYTES = Number(
  process.env.MAX_UPLOAD_BYTES ?? 200 * 1024 * 1024,
);
