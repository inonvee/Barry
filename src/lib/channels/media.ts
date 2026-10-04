import type { BusinessGraph } from "@/lib/business-graph";
import { getConversationStore, type ConversationState } from "@/lib/state";
import { INBOUND_TURNS_KEY, readInboundTurns } from "@/lib/runtime/engine";
import { humanHolds } from "@/lib/runtime/control";
import { resolveReplyLanguage } from "@/lib/reasoner/language";
import { SCRATCH_KEYS } from "@/lib/runtime/compiler";

/**
 * UNSUPPORTED MEDIA — a customer sent something BARRY can't read (voice note, image, video, file, sticker,
 * location, contact card). BARRY has no multimodal understanding, so it never pretends: the message is kept
 * (a placeholder in the transcript, with any caption the customer typed), BARRY answers once, plainly, that it
 * can't open that kind of message and asks them to type it, and the owner is told. It goes through the same
 * inbox / send-at-most-once path as every other inbound message; no model call is made for it.
 */

export const MEDIA_KEY = "__unsupportedMedia";
export type MediaEvent = { inboundId: string; type: string; at: string; caption?: string; answered: boolean };

const LABEL: Record<string, { en: string; he: string; plural: { en: string; he: string } }> = {
  audio: { en: "voice message", he: "הודעה קולית", plural: { en: "voice messages", he: "הודעות קוליות" } },
  voice: { en: "voice message", he: "הודעה קולית", plural: { en: "voice messages", he: "הודעות קוליות" } },
  image: { en: "image", he: "תמונה", plural: { en: "images", he: "תמונות" } },
  video: { en: "video", he: "סרטון", plural: { en: "videos", he: "סרטונים" } },
  document: { en: "file", he: "קובץ", plural: { en: "files", he: "קבצים" } },
  sticker: { en: "sticker", he: "מדבקה", plural: { en: "stickers", he: "מדבקות" } },
  location: { en: "location", he: "מיקום", plural: { en: "locations", he: "מיקומים" } },
  contacts: { en: "contact card", he: "איש קשר", plural: { en: "contact cards", he: "אנשי קשר" } },
};
const label = (type: string) => LABEL[type] ?? { en: "attachment", he: "קובץ מצורף", plural: { en: "attachments", he: "קבצים מצורפים" } };

/** What the transcript shows for it: the kind, marked as not opened, and the customer's own caption. */
export function mediaPlaceholder(type: string, caption?: string): string {
  const c = caption?.trim().slice(0, 1000);
  return `[${label(type).en} — not opened]${c ? ` ${c}` : ""}`;
}

export function mediaReply(type: string, lang: string): string {
  const l = label(type);
  return lang.startsWith("he")
    ? `מצטער, אני עדיין לא יכול לפתוח ${l.plural.he} כאן. אפשר לכתוב לי במילים מה צריך? עדכנתי גם את הצוות.`
    : `Sorry, I can't open ${l.plural.en} here yet. Could you type what you need? I've also let the team know.`;
}

export function readMediaEvents(state: Pick<ConversationState, "knownFields">): MediaEvent[] {
  try {
    const v = JSON.parse(state.knownFields[MEDIA_KEY] ?? "[]") as MediaEvent[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * Record the media message and (unless a person holds the conversation) BARRY's honest reply, stamped with
 * the inbound id IN THE SAME SAVE — so a retry never records or answers it twice. The caller holds the lock.
 */
export async function recordUnsupportedMedia(graph: BusinessGraph, input: { conversationId: string; customerId: string; inboundId: string; type: string; caption?: string; receivedAt: string }): Promise<{ held: boolean; reply?: string; replyAt?: string }> {
  const store = getConversationStore();
  const state = await store.getOrCreate(input.conversationId, graph.business.id, input.customerId);
  const stamps = readInboundTurns(state.knownFields);
  const prior = stamps[input.inboundId];
  if (prior) {
    const reply = prior.replyAt ? state.messages.find((m) => m.role === "barry" && Date.parse(m.at) === Date.parse(prior.replyAt!)) : undefined;
    return reply ? { held: false, reply: reply.content, replyAt: reply.at } : { held: true };
  }
  const now = new Date().toISOString();
  state.messages.push({ role: "customer", content: mediaPlaceholder(input.type, input.caption), at: now });
  const held = humanHolds(state);
  let reply: string | undefined;
  if (!held) {
    const lang = resolveReplyLanguage({ customerMessages: [...state.messages.filter((m) => m.role === "customer" && !m.content.startsWith("[")).map((m) => m.content), ...(input.caption ? [input.caption] : [])], stored: state.knownFields[SCRATCH_KEYS.conversationLanguage], businessLocale: graph.business.locale }).code;
    reply = mediaReply(input.type, lang);
    state.messages.push({ role: "barry", content: reply, at: new Date(Date.parse(now) + 1).toISOString() });
  }
  const replyAt = reply ? state.messages.at(-1)!.at : undefined;
  stamps[input.inboundId] = { turnId: `media:${input.inboundId}`, ...(replyAt ? { replyAt } : {}), ...(held ? { held: true } : {}) };
  state.knownFields[INBOUND_TURNS_KEY] = JSON.stringify(Object.fromEntries(Object.entries(stamps).slice(-200)));
  const event: MediaEvent = { inboundId: input.inboundId, type: input.type, at: now, ...(input.caption ? { caption: input.caption.slice(0, 300) } : {}), answered: !held };
  state.knownFields[MEDIA_KEY] = JSON.stringify([...readMediaEvents(state), event].slice(-50));
  await store.save(state);
  return { held, ...(reply ? { reply, replyAt } : {}) };
}

/** The owner's alert text (owner line / attention). Never says what the media contains. */
export function mediaAlertText(customer: string, type: string, caption?: string): string {
  return `${customer} sent a ${label(type).en} BARRY can't open${caption ? ` (with the text: “${caption.slice(0, 120)}”)` : ""}. BARRY asked them to type it — you may want to look.`;
}
