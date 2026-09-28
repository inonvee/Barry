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
    case "custom-commerce":
      return {
        apiKey: process.env[envName("custom_commerce", refName, "API_KEY")],
      };
    default:
      return {};
  }
}

export function resolveConnectionCredentials(connection: ConnectionRecord): EnvCredentials {
  return resolveCredentials(connection.credentialsRef, connection.provider);
}

const CREDENTIAL_KEYS: Record<string, { envProvider: string; keys: { key: string; required: boolean }[] }> = {
  stripe: { envProvider: "stripe", keys: [{ key: "SECRET_KEY", required: true }, { key: "WEBHOOK_SECRET", required: true }] },
  payplus: {
    envProvider: "payplus",
    keys: [
      { key: "API_KEY", required: true },
      { key: "SECRET_KEY", required: true },
      { key: "PAYMENT_PAGE_UID", required: true },
      { key: "ENVIRONMENT", required: false },
      { key: "CALLBACK_URL", required: false },
    ],
  },
  "google-calendar": { envProvider: "google_calendar", keys: [{ key: "CALENDAR_ID", required: true }] },
  "custom-commerce": { envProvider: "custom_commerce", keys: [{ key: "API_KEY", required: true }] },
};

export type CredentialRequirement = { envVar: string; required: boolean; present: boolean };

/**
 * Setup requirements for a connection: the NAMES of the environment
 * variables it reads and whether each is set. Never returns a value.
 */
export function describeCredentialRequirements(credentialsRef: string, provider: string): CredentialRequirement[] {
  const spec = CREDENTIAL_KEYS[provider];
  if (!spec) return [];
  const [, , refName] = credentialsRef.split(":");
  return spec.keys.map(({ key, required }) => {
    const envVar =
      provider === "google-calendar" && !refName ? "GOOGLE_CALENDAR_ID" : envName(spec.envProvider, refName, key);
    const value = process.env[envVar];
    return { envVar, required, present: typeof value === "string" && value.length > 0 };
  });
}
