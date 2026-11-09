export class RpcError extends Error {
  readonly code: string;
  readonly detail: unknown;

  constructor(code: string, detail?: unknown) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}
