export type DomainErrorCode =
  | "not_found"
  | "validation_error"
  | "conflict"
  | "stale_revision"
  | "approval_gate_failed"
  | "schedule_gate_failed";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: unknown;

  constructor(code: DomainErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export function notFound(kind: string, id: string): never {
  throw new DomainError("not_found", `${kind} 不存在: ${id}`, { kind, id });
}

export function validation(message: string, details?: unknown): never {
  throw new DomainError("validation_error", message, details);
}

export function conflict(message: string, details?: unknown): never {
  throw new DomainError("conflict", message, details);
}
