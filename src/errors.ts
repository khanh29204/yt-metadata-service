/** Lỗi có HTTP status — route handler map thẳng ra response. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
