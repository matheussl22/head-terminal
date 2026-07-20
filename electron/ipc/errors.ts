export class IpcError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "IpcError";
  }
}

export function unsupported(capability: string): never {
  throw new IpcError(
    "CAPABILITY_UNAVAILABLE",
    `${capability} is not available in this build`,
  );
}
