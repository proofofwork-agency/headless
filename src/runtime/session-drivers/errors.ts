export type SessionDriverErrorCode =
  | "INVALID_REQUEST"
  | "BACKEND_UNAVAILABLE"
  | "BACKEND_UNSUPPORTED"
  | "NATIVE_AUTH_UNAVAILABLE"
  | "NATIVE_SESSION_LOST"
  | "RATE_LIMITED"
  | "SESSION_BUSY"
  | "SESSION_CLOSED"
  | "CANCELLED"
  | "TIMED_OUT"
  | "OUTPUT_OVERFLOW"
  | "PROCESS_ERROR";

export class SessionDriverError extends Error {
  readonly name = "SessionDriverError";

  constructor(
    readonly code: SessionDriverErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export function sessionDriverError(error: unknown, fallback: SessionDriverErrorCode = "PROCESS_ERROR") {
  if (error instanceof SessionDriverError) return error;
  return new SessionDriverError(fallback, error instanceof Error ? error.message : String(error));
}
