import { ZodError } from "zod";

const MAX_VALIDATION_ISSUES = 8;

export function isValidationError(error: unknown): error is ZodError {
  return error instanceof ZodError;
}

export function validationErrorMessage(error: ZodError) {
  const issues = error.issues.slice(0, MAX_VALIDATION_ISSUES).map((issue) => {
    const path = issue.path.length ? issue.path.map(String).join(".") : "request";
    return `${path}: ${issue.message}`;
  });
  const omitted = error.issues.length - issues.length;
  return `Invalid request: ${issues.join("; ")}${omitted > 0 ? `; ${omitted} more validation issue${omitted === 1 ? "" : "s"}` : ""}`;
}

export function validationErrorDetails(error: ZodError) {
  return {
    issues: error.issues.slice(0, MAX_VALIDATION_ISSUES).map((issue) => ({
      path: issue.path.map(String),
      message: issue.message,
      code: issue.code,
    })),
    omittedIssues: Math.max(0, error.issues.length - MAX_VALIDATION_ISSUES),
  };
}
