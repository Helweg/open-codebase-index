export class UnsupportedIndexOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedIndexOperationError";
  }
}
