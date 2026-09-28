import type { ConnectionRecord } from "@/lib/store";

export type EnvCredentials = Record<string, string | undefined>;

export function resolveEnvCredentials(connection: ConnectionRecord): EnvCredentials {
  if (!connection.credentialsRef.startsWith("env:")) {
    throw new Error(`Unsupported credentials reference for ${connection.capability}`);
  }

  switch (connection.provider) {
    case "stripe":
      return {
        secretKey: process.env.STRIPE_SECRET_KEY,
        webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
        successUrl: process.env.STRIPE_SUCCESS_URL,
        cancelUrl: process.env.STRIPE_CANCEL_URL,
      };
    case "payplus":
      return {
        apiKey: process.env.PAYPLUS_API_KEY,
        secretKey: process.env.PAYPLUS_SECRET_KEY,
        paymentPageUid: process.env.PAYPLUS_PAYMENT_PAGE_UID,
        environment: process.env.PAYPLUS_ENVIRONMENT,
        successUrl: process.env.PAYPLUS_SUCCESS_URL,
        failureUrl: process.env.PAYPLUS_FAILURE_URL,
        cancelUrl: process.env.PAYPLUS_CANCEL_URL,
        callbackUrl: process.env.PAYPLUS_CALLBACK_URL,
      };
    case "google-calendar":
      return {
        calendarId: process.env.GOOGLE_CALENDAR_ID,
      };
    default:
      return {};
  }
}
