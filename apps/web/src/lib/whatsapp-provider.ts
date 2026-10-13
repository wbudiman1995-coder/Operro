/**
 * Function index:
 * - WhatsAppProvider / ProviderDisabledError / disabledProvider / getWhatsAppProvider: the boundary a sender would sit behind. Only the
 *   disabled provider is wired, and it refuses every send. Nothing in the application calls getWhatsAppProvider to send.
 * - buildMetaTemplatePayload: validates a template-message request and builds the body the official Meta WhatsApp Cloud API expects.
 *   It makes no request.
 * - verifyMetaSignature: checks the X-Hub-Signature-256 header of a webhook delivery against a secret PASSED IN by the caller.
 * - answerMetaChallenge: answers the webhook verification handshake (hub.mode / hub.verify_token / hub.challenge).
 * - parseMetaStatusEvents: turns a webhook payload into normalized sent / delivered / read / failed events, dropping recipient numbers.
 *
 * This module is pure by design: it reads no environment variable, holds no credential, opens no connection and writes nothing. It is
 * the reviewed shape of the official-provider boundary, with the decisions an owner must still take listed in
 * docs/runbooks/WHATSAPP_PROVIDER_SETUP.md. Until the platform makes the provider available (public.platform_flags,
 * migration 20261101120000) and a service identity exists to receive webhooks, Operro sends nothing and stores no delivered or read
 * state; a status after "draft" in the draft center stays a person's report.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type ProviderMessageStatus = "sent" | "delivered" | "read" | "failed";
export interface ProviderStatusEvent { providerMessageId: string; status: ProviderMessageStatus; occurredAt: string; errorCode: number | null }
export interface TemplateMessageRequest { to: string; templateName: string; languageCode: string; bodyParams: readonly string[] }
export interface WhatsAppProvider {
  readonly id: "disabled" | "meta_cloud";
  sendTemplate(request: TemplateMessageRequest): Promise<{ providerMessageId: string }>;
}

export class ProviderDisabledError extends Error {
  constructor() {
    super("whatsapp_provider_disabled");
    this.name = "ProviderDisabledError";
  }
}

export const disabledProvider: WhatsAppProvider = {
  id: "disabled",
  async sendTemplate() { throw new ProviderDisabledError(); },
};

/** The single wiring point. It returns the disabled provider; a real adapter needs the decisions in the runbook first. */
export function getWhatsAppProvider(): WhatsAppProvider {
  return disabledProvider;
}

const E164 = /^[1-9][0-9]{7,14}$/;
const TEMPLATE_NAME = /^[a-z][a-z0-9_]{0,511}$/;
const LANGUAGE = /^[a-z]{2}(_[A-Z]{2})?$/;
export const MAX_TEMPLATE_PARAMS = 10;
export const MAX_PARAM_LENGTH = 1024;

/** The body of POST /{phone-number-id}/messages for a template message. Throws on anything the official API would reject. */
export function buildMetaTemplatePayload(request: TemplateMessageRequest): Record<string, unknown> {
  if (!E164.test(request.to)) throw new Error("invalid_recipient");
  if (!TEMPLATE_NAME.test(request.templateName)) throw new Error("invalid_template_name");
  if (!LANGUAGE.test(request.languageCode)) throw new Error("invalid_language");
  if (request.bodyParams.length > MAX_TEMPLATE_PARAMS) throw new Error("too_many_parameters");
  for (const value of request.bodyParams) {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_PARAM_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error("invalid_parameter");
  }
  return {
    messaging_product: "whatsapp",
    to: request.to,
    type: "template",
    template: {
      name: request.templateName,
      language: { code: request.languageCode },
      ...(request.bodyParams.length > 0 ? { components: [{ type: "body", parameters: request.bodyParams.map((text) => ({ type: "text", text })) }] } : {}),
    },
  };
}

/** True only for a well-formed `sha256=<64 hex>` header that matches HMAC-SHA256(rawBody, appSecret). An empty secret never verifies. */
export function verifyMetaSignature(rawBody: string, signatureHeader: string | null, appSecret: string): boolean {
  if (!appSecret || typeof signatureHeader !== "string") return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader.trim());
  if (!match) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest();
  const given = Buffer.from(match[1], "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The challenge to echo for a valid verification request, else null. An unset expected token never verifies. */
export function answerMetaChallenge(query: { mode?: string | null; token?: string | null; challenge?: string | null }, expectedToken: string): string | null {
  if (!expectedToken || query.mode !== "subscribe" || typeof query.token !== "string" || typeof query.challenge !== "string") return null;
  const given = Buffer.from(query.token);
  const wanted = Buffer.from(expectedToken);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;
  return /^[0-9A-Za-z_-]{1,200}$/.test(query.challenge) ? query.challenge : null;
}

const STATUSES: ReadonlySet<string> = new Set(["sent", "delivered", "read", "failed"]);

/** Normalized status events of a webhook payload. Unknown shapes and statuses are dropped; recipient numbers are never carried over. */
export function parseMetaStatusEvents(payload: unknown): ProviderStatusEvent[] {
  const events: ProviderStatusEvent[] = [];
  const entries = (payload as { entry?: unknown })?.entry;
  if (!Array.isArray(entries)) return events;
  for (const entry of entries.slice(0, 100)) {
    const changes = (entry as { changes?: unknown })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes.slice(0, 100)) {
      const statuses = (change as { value?: { statuses?: unknown } })?.value?.statuses;
      if (!Array.isArray(statuses)) continue;
      for (const item of statuses.slice(0, 1000)) {
        const record = item as { id?: unknown; status?: unknown; timestamp?: unknown; errors?: unknown };
        if (typeof record.id !== "string" || record.id.length === 0 || record.id.length > 200 || typeof record.status !== "string" || !STATUSES.has(record.status)) continue;
        const seconds = typeof record.timestamp === "string" || typeof record.timestamp === "number" ? Number(record.timestamp) : Number.NaN;
        if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 4_102_444_800) continue;
        const firstError = Array.isArray(record.errors) ? (record.errors[0] as { code?: unknown } | undefined) : undefined;
        events.push({
          providerMessageId: record.id,
          status: record.status as ProviderMessageStatus,
          occurredAt: new Date(seconds * 1000).toISOString(),
          errorCode: typeof firstError?.code === "number" && Number.isInteger(firstError.code) ? firstError.code : null,
        });
      }
    }
  }
  return events;
}
