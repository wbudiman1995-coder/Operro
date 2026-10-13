import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { WhatsAppProviderPanel } from "../src/components/whatsapp-provider-panel";
import {
  answerMetaChallenge, buildMetaTemplatePayload, disabledProvider, getWhatsAppProvider, MAX_PARAM_LENGTH, MAX_TEMPLATE_PARAMS, parseMetaStatusEvents,
  ProviderDisabledError, verifyMetaSignature,
} from "../src/lib/whatsapp-provider";
import { describeProviderError, loadProviderState, parseProviderState, PROVIDER_REQUIREMENTS, validateProviderForm } from "../src/lib/whatsapp-provider-settings";

const root = path.resolve(import.meta.dirname, "../../..");
const sign = (body: string, secret: string) => `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;

test("the only wired provider is the disabled one and it refuses every send", async () => {
  assert.equal(getWhatsAppProvider(), disabledProvider);
  assert.equal(getWhatsAppProvider().id, "disabled");
  await assert.rejects(() => getWhatsAppProvider().sendTemplate({ to: "628123456789", templateName: "invoice_reminder", languageCode: "id", bodyParams: ["a"] }), ProviderDisabledError);
});

test("a template payload is built only from validated input and matches the official request shape", () => {
  const payload = buildMetaTemplatePayload({ to: "628123456789", templateName: "invoice_reminder", languageCode: "id", bodyParams: ["Budi", "Rp150.000"] });
  assert.deepEqual(payload, {
    messaging_product: "whatsapp", to: "628123456789", type: "template",
    template: { name: "invoice_reminder", language: { code: "id" }, components: [{ type: "body", parameters: [{ type: "text", text: "Budi" }, { type: "text", text: "Rp150.000" }] }] },
  });
  assert.equal("components" in (buildMetaTemplatePayload({ to: "628123456789", templateName: "hello", languageCode: "en_US", bodyParams: [] }).template as object), false);
  const bad: Array<[Parameters<typeof buildMetaTemplatePayload>[0], string]> = [
    [{ to: "+628123456789", templateName: "t", languageCode: "id", bodyParams: [] }, "invalid_recipient"],
    [{ to: "0812345", templateName: "t", languageCode: "id", bodyParams: [] }, "invalid_recipient"],
    [{ to: "628123456789", templateName: "Bad Name", languageCode: "id", bodyParams: [] }, "invalid_template_name"],
    [{ to: "628123456789", templateName: "t", languageCode: "indonesian", bodyParams: [] }, "invalid_language"],
    [{ to: "628123456789", templateName: "t", languageCode: "id", bodyParams: Array.from({ length: MAX_TEMPLATE_PARAMS + 1 }, () => "x") }, "too_many_parameters"],
    [{ to: "628123456789", templateName: "t", languageCode: "id", bodyParams: [""] }, "invalid_parameter"],
    [{ to: "628123456789", templateName: "t", languageCode: "id", bodyParams: ["x".repeat(MAX_PARAM_LENGTH + 1)] }, "invalid_parameter"],
    [{ to: "628123456789", templateName: "t", languageCode: "id", bodyParams: ["bad\u0001"] }, "invalid_parameter"],
  ];
  for (const [request, message] of bad) assert.throws(() => buildMetaTemplatePayload(request), new RegExp(message));
});

test("webhook signatures verify only for the exact body and secret", () => {
  const body = JSON.stringify({ entry: [] });
  const header = sign(body, "app-secret-for-tests");
  assert.equal(verifyMetaSignature(body, header, "app-secret-for-tests"), true);
  assert.equal(verifyMetaSignature(body, header.toUpperCase().replace("SHA256=", "sha256="), "app-secret-for-tests"), true, "hex case does not matter");
  assert.equal(verifyMetaSignature(`${body} `, header, "app-secret-for-tests"), false, "a tampered body fails");
  assert.equal(verifyMetaSignature(body, header, "another-secret"), false, "a wrong secret fails");
  assert.equal(verifyMetaSignature(body, null, "app-secret-for-tests"), false, "a missing header fails");
  assert.equal(verifyMetaSignature(body, header, ""), false, "an unset secret never verifies");
  assert.equal(verifyMetaSignature(body, "sha256=abc", "app-secret-for-tests"), false, "a short signature fails");
  assert.equal(verifyMetaSignature(body, header.replace("sha256=", "sha1="), "app-secret-for-tests"), false, "a different scheme fails");
});

test("the verification handshake echoes the challenge only for the expected token", () => {
  assert.equal(answerMetaChallenge({ mode: "subscribe", token: "secret-token", challenge: "1158201444" }, "secret-token"), "1158201444");
  assert.equal(answerMetaChallenge({ mode: "subscribe", token: "wrong", challenge: "1158201444" }, "secret-token"), null);
  assert.equal(answerMetaChallenge({ mode: "unsubscribe", token: "secret-token", challenge: "1" }, "secret-token"), null);
  assert.equal(answerMetaChallenge({ mode: "subscribe", token: "secret-token", challenge: "<script>" }, "secret-token"), null, "a challenge is echoed only if it is harmless");
  assert.equal(answerMetaChallenge({ mode: "subscribe", token: "", challenge: "1" }, ""), null, "an unset expected token never verifies");
  assert.equal(answerMetaChallenge({ mode: "subscribe", challenge: "1" }, "secret-token"), null);
});

test("status events are normalized, bounded and carry no recipient number", () => {
  const payload = {
    entry: [{ changes: [{ value: { statuses: [
      { id: "wamid.A", status: "sent", timestamp: "1760000000", recipient_id: "628123456789" },
      { id: "wamid.A", status: "delivered", timestamp: 1760000005, recipient_id: "628123456789" },
      { id: "wamid.A", status: "read", timestamp: "1760000010" },
      { id: "wamid.B", status: "failed", timestamp: "1760000020", errors: [{ code: 131026, title: "Message undeliverable" }] },
      { id: "wamid.C", status: "deleted", timestamp: "1760000030" },
      { id: "", status: "sent", timestamp: "1760000030" },
      { id: "wamid.D", status: "sent", timestamp: "not-a-number" },
      { id: "wamid.E", status: "sent", timestamp: "99999999999" },
      { status: "sent", timestamp: "1760000030" },
    ] } }] }],
  };
  const events = parseMetaStatusEvents(payload);
  assert.deepEqual(events.map((event) => [event.providerMessageId, event.status]), [["wamid.A", "sent"], ["wamid.A", "delivered"], ["wamid.A", "read"], ["wamid.B", "failed"]]);
  assert.equal(events[0].occurredAt, "2025-10-09T08:53:20.000Z");
  assert.equal(events[3].errorCode, 131026);
  assert.equal(events[0].errorCode, null);
  assert.doesNotMatch(JSON.stringify(events), /628123456789|recipient/);
  for (const junk of [null, undefined, 5, "x", {}, { entry: "x" }, { entry: [null] }, { entry: [{ changes: [{}] }] }, { entry: [{ changes: [{ value: { statuses: "x" } }] }] }]) assert.deepEqual(parseMetaStatusEvents(junk), []);
});

test("the boundary module is pure: no environment, network, filesystem or database access", () => {
  const source = fs.readFileSync(path.join(root, "apps/web/src/lib/whatsapp-provider.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(source, /process\.env|\bfetch\s*\(|XMLHttpRequest|node:fs|node:net|node:http|child_process|supabase|createClient|service_role/i);
  // And nothing else in the application calls the provider to send.
  const callers = [] as string[];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && fs.readFileSync(full, "utf8").match(/getWhatsAppProvider|sendTemplate\s*\(/) && !full.endsWith("whatsapp-provider.ts")) callers.push(path.relative(root, full));
    }
  };
  walk(path.join(root, "apps/web/src"));
  assert.deepEqual(callers, [], "no application code sends through the provider boundary");
});

test("provider state: enabled is only ever true while the platform allows it", () => {
  const base = { platform_available: false, provider: "meta_cloud", phone_number_id: "123456789", business_account_id: null, consent_attested: true, consent_attested_at: "2026-10-13T00:00:00Z", enabled: true, version: 2 };
  assert.equal(parseProviderState([base])?.enabled, false, "even if the server says enabled, a closed platform gate wins");
  assert.equal(parseProviderState([{ ...base, platform_available: true }])?.enabled, true);
  assert.equal(parseProviderState([{ ...base, provider: "twilio" }])?.provider, "none");
  assert.equal(parseProviderState(null), null);
  assert.equal(parseProviderState([{ ...base, version: "x" }])?.version, 0);
});

test("the form refuses anything that looks like a credential and requires a provider for ids", () => {
  const ok = { provider: "meta_cloud", phoneNumberId: " 123456789012345 ", businessAccountId: "", consentAttested: true, version: "0" };
  assert.deepEqual(validateProviderForm(ok), { ok: true, version: 0 });
  for (const bad of [
    { ...ok, phoneNumberId: "EAAB-token" }, { ...ok, phoneNumberId: "123" }, { ...ok, businessAccountId: "abc12345" }, { ...ok, provider: "twilio" },
    { ...ok, provider: "none" }, { ...ok, version: "-1" }, { ...ok, version: "x" },
  ]) assert.equal(validateProviderForm(bad).ok, false, JSON.stringify(bad));
  assert.deepEqual(validateProviderForm({ provider: "none", phoneNumberId: "", businessAccountId: "", consentAttested: false, version: "3" }), { ok: true, version: 3 });
  assert.match(describeProviderError({ code: "22023", message: "provider_not_available" }), /pemilik platform/);
  assert.doesNotMatch(describeProviderError({ code: "XX000", message: "relation whatsapp_provider_settings" }), /relation|whatsapp_provider_settings/);
});

test("the settings page states it is unavailable, offers no way to enable, and lists the real prerequisites", () => {
  const html = renderToStaticMarkup(<WhatsAppProviderPanel error={null} state={{ platformAvailable: false, provider: "none", phoneNumberId: null, businessAccountId: null, consentAttested: false, consentAttestedAt: null, enabled: false, version: 0 }} />);
  assert.match(html, /Belum tersedia/);
  assert.match(html, /Operro tidak mengirim pesan WhatsApp/);
  assert.match(html, /<input type="checkbox" disabled/, "the enable box exists only as a disabled control");
  assert.match(html, /database menolak pengaktifan/);
  for (const line of PROVIDER_REQUIREMENTS) assert.ok(html.includes(line), line.slice(0, 40));
  assert.doesNotMatch(html, /type="password"|name="token"|name="secret"|apiKey/i);
  assert.doesNotMatch(html, /terkirim otomatis|status dibaca aktif/i);
  const failed = renderToStaticMarkup(<WhatsAppProviderPanel state={null} error="Pengaturan penyedia belum dapat dimuat." />);
  assert.match(failed, /role="alert"/);
  assert.doesNotMatch(failed, /Persiapan penyedia resmi/);
});

test("loadProviderState reads one RPC with no argument and reports a refusal with its code", async () => {
  const calls: Array<{ name: string; args: unknown }> = [];
  const ok = { schema: () => ({ rpc: async (name: string, args?: unknown) => { calls.push({ name, args }); return { data: [{ platform_available: false, provider: "none", consent_attested: false, enabled: false, version: 0 }], error: null }; } }) } as never;
  const state = await loadProviderState(ok);
  assert.deepEqual(calls, [{ name: "whatsapp_provider_state", args: undefined }]);
  assert.equal(state?.provider, "none");
  const denied = { schema: () => ({ rpc: async () => ({ data: null, error: { code: "42501", message: "not_authorized" } }) }) } as never;
  await assert.rejects(() => loadProviderState(denied), (error: Error & { code?: string }) => error.code === "42501");
});

test("the action cannot enable a provider and sends no organization", () => {
  const actions = fs.readFileSync(path.join(root, "apps/web/src/app/settings/whatsapp-provider/actions.ts"), "utf8");
  assert.match(actions, /p_enabled: false/);
  assert.doesNotMatch(actions, /p_enabled: (true|input)|p_org\b|organization_id/);
});
