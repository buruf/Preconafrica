export class ServiceError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'NOT_FOUND'
      | 'CONFLICT'
      | 'VALIDATION'
      | 'FORBIDDEN'
      /**
       * A dependency outside this system is down or refusing us — today, the
       * Blob store an upload writes to. Distinct from VALIDATION, because
       * nothing the admin typed is wrong and "try again" is the right advice;
       * distinct from an unhandled throw, because a storage outage has to reach
       * the form as a sentence rather than as a 500.
       */
      | 'UNAVAILABLE' = 'VALIDATION'
  ) {
    super(message)
    this.name = 'ServiceError'
  }
}
