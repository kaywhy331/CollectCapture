export class ApplicationError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApplicationError";
  }
}

export function notFound(resource: string): ApplicationError {
  return new ApplicationError(404, "not_found", `${resource} was not found`);
}

export function forbidden(
  message = "You do not have access to this household",
): ApplicationError {
  return new ApplicationError(403, "forbidden", message);
}
