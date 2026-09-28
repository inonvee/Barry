import type { ConnectionRecord } from "@/lib/store";

export type EnvCredentials = Record<string, string | undefined>;

function envToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
}

function envName(provider: string, refName: string | undefined, key: string): string {
  const providerToken = envToken(provider);
  return refName ? `${providerToken}_${envToken(refName)}_${key}` : `${providerToken}_${key}`;
}

export function resolveCredentials(credentialsRef: string, provider: string): EnvCredentials {
  const [scheme, refProvider, refName] = credentialsRef.split(":");
  if (scheme !== "env") throw new Error(`Unsupported credentials reference ${credentialsRef}`);
  if (refProvider && refProvider !== provider) {
    throw new Error(`Credentials reference provider mismatch for ${provider}`);
  }

  switch (provider) {
    case "stripe":
      return {
        secretKey: process.env[envName("stripe", refName, "SECRET_KEY")],
        webhookSecret: process.env[envName("stripe", refName, "WEBHOOK_SECRET")],
        successUrl: process.env[envName("stripe", refName, "SUCCESS_URL")],
        cancelUrl: process.env[envName("stripe", refName, "CANCEL_URL")],
      };
    case "payplus":
      return {
        apiKey: process.env[envName("payplus", refName, "API_KEY")],
        secretKey: process.env[envName("payplus", refName, "SECRET_KEY")],
        paymentPageUid: process.env[envName("payplus", refName, "PAYMENT_PAGE_UID")],
        environment: process.env[envName("payplus", refName, "ENVIRONMENT")],
        successUrl: process.env[envName("payplus", refName, "SUCCESS_URL")],
        failureUrl: process.env[envName("payplus", refName, "FAILURE_URL")],
        cancelUrl: process.env[envName("payplus", refName, "CANCEL_URL")],
        callbackUrl: process.env[envName("payplus", refName, "CALLBACK_URL")],
      };
    case "google-calendar":
      return {
        calendarId: refName
          ? process.env[envName("google_calendar", refName, "CALENDAR_ID")]
          : process.env.GOOGLE_CALENDAR_ID,
      };
    default:
      return {};
  }
}

export function resolveConnectionCredentials(connection: ConnectionRecord): EnvCredentials {
  return resolveCredentials(connection.credentialsRef, connection.provider);
}
