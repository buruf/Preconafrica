export class ServiceError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'NOT_FOUND'
      | 'CONFLICT'
      | 'VALIDATION'
      | 'FORBIDDEN' = 'VALIDATION'
  ) {
    super(message)
    this.name = 'ServiceError'
  }
}
