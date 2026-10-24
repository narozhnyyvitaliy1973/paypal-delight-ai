export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export class PayPalError extends Error {
  constructor(
    public httpStatus: number,
    public issue = "UNAVAILABLE",
  ) {
    super("PayPal Sandbox request failed");
  }
}
