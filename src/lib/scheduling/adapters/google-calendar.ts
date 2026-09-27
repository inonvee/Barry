import crypto from "node:crypto";
import { findOffer, resourcesByType } from "@/lib/business-graph";
import type { BarryBackend, BookingRecord } from "@/lib/store";
import type { CheckAvailabilityInput, CreateBookingInput, SchedulingAdapter, SchedulingBooking, SchedulingSlot } from "./types";

type GoogleCalendarAdapterOptions = {
  calendarId: string;
  fetcher?: typeof fetch;
  accessTokenProvider?: () => Promise<string>;
  backend?: BarryBackend;
};

type GoogleBusyResponse = {
  calendars?: Record<string, { busy?: { start: string; end: string }[] }>;
};

type GoogleEvent = {
  id?: string;
  status?: string;
  extendedProperties?: { private?: Record<string, string> };
};

const GOOGLE_CALENDAR_BASE_URL = "https://www.googleapis.com/calendar/v3";

export function googleCalendarEventIdForSlotLock(value: string): string {
  return `barr${crypto.createHash("sha256").update(value).digest("hex").slice(0, 48)}`;
}

function slotLockKey(input: CreateBookingInput): string {
  return `${input.graph.business.id}:${input.resourceId}:${input.start}:${input.end}`;
}

function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return new Date(aStart) < new Date(bEnd) && new Date(bStart) < new Date(aEnd);
}

function eventToBooking(event: GoogleEvent, fallback: CreateBookingInput, verifiedAt = new Date().toISOString()): SchedulingBooking | undefined {
  if (!event.id || event.status === "cancelled") return undefined;
  const metadata = event.extendedProperties?.private ?? {};
  return {
    bookingId: event.id,
    provider: "google-calendar",
    providerEventId: event.id,
    resourceId: metadata.resourceId ?? fallback.resourceId,
    start: metadata.start ?? fallback.start,
    end: metadata.end ?? fallback.end,
    status: "confirmed",
    idempotencyKey: metadata.idempotencyKey ?? fallback.idempotencyKey,
    verifiedAt,
  };
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function serviceAccountAccessToken(fetcher: typeof fetch): Promise<string | undefined> {
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) return undefined;

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(JSON.stringify({
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/calendar",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claim}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(privateKey);
  const assertion = `${unsigned}.${base64url(signature)}`;
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const response = await fetcher("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new Error("Google Calendar auth invalid");
  const json = (await response.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("Google Calendar auth invalid");
  return json.access_token;
}

async function defaultAccessTokenProvider(fetcher: typeof fetch): Promise<string> {
  if (process.env.GOOGLE_CALENDAR_ACCESS_TOKEN) return process.env.GOOGLE_CALENDAR_ACCESS_TOKEN;
  const serviceToken = await serviceAccountAccessToken(fetcher);
  if (serviceToken) return serviceToken;
  throw new Error("Google Calendar auth invalid");
}

export class GoogleCalendarAdapter implements SchedulingAdapter {
  readonly name = "google-calendar" as const;
  private readonly fetcher: typeof fetch;
  private readonly accessTokenProvider: () => Promise<string>;
  private readonly calendarId: string;
  private readonly backend: BarryBackend | undefined;

  constructor(options: GoogleCalendarAdapterOptions) {
    this.calendarId = options.calendarId;
    this.fetcher = options.fetcher ?? fetch;
    this.accessTokenProvider = options.accessTokenProvider ?? (() => defaultAccessTokenProvider(this.fetcher));
    this.backend = options.backend;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const token = await this.accessTokenProvider();
    const response = await this.fetcher(`${GOOGLE_CALENDAR_BASE_URL}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    if (response.status === 401 || response.status === 403) throw new Error("Google Calendar auth invalid");
    if (response.status === 404) return undefined;
    if (response.status === 409) throw new Error("Google Calendar duplicate request");
    if (!response.ok) throw new Error("Google Calendar provider unavailable");
    return response.json();
  }

  private async busyBlocks(timeMin: string, timeMax: string): Promise<{ start: string; end: string }[]> {
    const body = {
      timeMin,
      timeMax,
      timeZone: "UTC",
      items: [{ id: this.calendarId }],
    };
    const result = (await this.request("/freeBusy", { method: "POST", body: JSON.stringify(body) })) as GoogleBusyResponse;
    return result.calendars?.[this.calendarId]?.busy ?? [];
  }

  async checkAvailability(input: CheckAvailabilityInput): Promise<{ slots: SchedulingSlot[] }> {
    const offer = findOffer(input.graph, input.offerId);
    if (!offer) return { slots: [] };

    const resourceIds = new Set(
      offer.requiredResourceTypes.flatMap((type) => resourcesByType(input.graph, type).map((r) => r.id))
    );
    const latest = input.latest ?? new Date(new Date(input.earliest).getTime() + 3 * 60 * 60 * 1000).toISOString();
    const busy = await this.busyBlocks(input.earliest, latest);

    const slots = input.graph.availability
      .filter((slot) => {
        if (resourceIds.size > 0 && !resourceIds.has(slot.resourceId)) return false;
        if (new Date(slot.start) < new Date(input.earliest)) return false;
        if (new Date(slot.end) > new Date(latest)) return false;
        return !busy.some((b) => overlaps(slot.start, slot.end, b.start, b.end));
      })
      .map(({ resourceId, start, end }) => ({ resourceId, start, end }));

    return { slots };
  }

  async createBooking(input: CreateBookingInput): Promise<SchedulingBooking> {
    const persistedExisting = await this.findPersistedBooking(input);
    if (persistedExisting) return persistedExisting;

    const eventId = googleCalendarEventIdForSlotLock(slotLockKey(input));
    const existing = (await this.getBooking(eventId, input)) as SchedulingBooking | undefined;
    if (existing) {
      if (existing.idempotencyKey === input.idempotencyKey) return existing;
      throw new Error("Slot no longer available");
    }

    const busy = await this.busyBlocks(input.start, input.end);
    if (busy.some((b) => overlaps(input.start, input.end, b.start, b.end))) throw new Error("Slot no longer available");

    const eventBody = {
      id: eventId,
      summary: `BARRY booking: ${input.offerId}`,
      start: { dateTime: input.start, timeZone: input.graph.business.timezone },
      end: { dateTime: input.end, timeZone: input.graph.business.timezone },
      extendedProperties: {
        private: {
          businessId: input.graph.business.id,
          offerId: input.offerId,
          resourceId: input.resourceId,
          customerId: input.customerId,
          conversationId: input.conversationId,
          partySize: String(input.partySize),
          idempotencyKey: input.idempotencyKey,
          start: input.start,
          end: input.end,
          createdBy: "barry",
        },
      },
    };

    let created: GoogleEvent;
    try {
      created = (await this.request(
        `/calendars/${encodeURIComponent(this.calendarId)}/events`,
        { method: "POST", body: JSON.stringify(eventBody) }
      )) as GoogleEvent;
    } catch (err) {
      if (err instanceof Error && /duplicate request/i.test(err.message)) {
        const duplicate = await this.getBooking(eventId, input);
        if (duplicate?.idempotencyKey === input.idempotencyKey) return duplicate;
        throw new Error("Slot no longer available");
      }
      throw err;
    }

    const verified = await this.getBooking(created.id ?? eventId, input);
    if (!verified) throw new Error("Google Calendar malformed response");
    return this.persistVerifiedBooking(input, verified);
  }

  async getBooking(providerEventId: string, fallback?: CreateBookingInput): Promise<SchedulingBooking | undefined> {
    const event = (await this.request(
      `/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(providerEventId)}`
    )) as GoogleEvent | undefined;
    if (!event || !fallback) return undefined;
    return eventToBooking(event, fallback);
  }

  private async findPersistedBooking(input: CreateBookingInput): Promise<SchedulingBooking | undefined> {
    if (!this.backend) return undefined;
    const existing = (await this.backend.listBookings(input.graph.business.id)).find(
      (booking) => booking.idempotencyKey === input.idempotencyKey
    );
    return existing ? this.recordToBooking(existing) : undefined;
  }

  private recordToBooking(record: BookingRecord): SchedulingBooking {
    return {
      bookingId: record.id,
      resourceId: record.resourceId,
      start: record.start,
      end: record.end,
      status: "confirmed",
      provider: record.provider ?? "google-calendar",
      providerEventId: record.providerEventId,
      idempotencyKey: record.idempotencyKey ?? record.id,
      verifiedAt: record.verifiedAt ?? record.createdAt,
    };
  }

  private async persistVerifiedBooking(input: CreateBookingInput, verified: SchedulingBooking): Promise<SchedulingBooking> {
    if (!this.backend) return verified;
    const existing = await this.findPersistedBooking(input);
    if (existing) return existing;

    const record = await this.backend.createBooking({
      businessId: input.graph.business.id,
      offerId: input.offerId,
      resourceId: input.resourceId,
      start: input.start,
      end: input.end,
      customerId: input.customerId,
      conversationId: input.conversationId,
      partySize: input.partySize,
      provider: "google-calendar",
      providerEventId: verified.providerEventId,
      idempotencyKey: input.idempotencyKey,
      verifiedAt: verified.verifiedAt,
    });
    return this.recordToBooking(record);
  }
}
