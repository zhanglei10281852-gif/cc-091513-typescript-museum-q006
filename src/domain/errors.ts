/** 领域错误：携带 HTTP 状态码与稳定错误码。 */
export class DomainError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DomainError";
  }

  static notFound(what: string, id: string): DomainError {
    return new DomainError(404, "not_found", `${what} 不存在: ${id}`);
  }

  static badRequest(message: string, details?: Record<string, unknown>): DomainError {
    return new DomainError(400, "bad_request", message, details);
  }

  /** 409：草稿过期等并发冲突、非法状态流转 */
  static conflict(message: string, details?: Record<string, unknown>): DomainError {
    return new DomainError(409, "conflict", message, details);
  }

  /** 422：请求格式正确，但违反领域规则（审核闸口、证据失效等） */
  static unprocessable(message: string, details?: Record<string, unknown>): DomainError {
    return new DomainError(422, "unprocessable", message, details);
  }
}
