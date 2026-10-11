import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCampaignLink, buildReferralLink, parseLink } from "../src/link.ts";

test("link de campanha: ida e volta", () => {
  const url = buildCampaignLink({ campaign: "verao-2026", channel: "instagram", clickId: "c1" });
  assert.equal(url, "https://conty.app/a?ct_v=1&ct_type=campaign&ct_campaign=verao-2026&ct_channel=instagram&ct_click=c1");
  const parsed = parseLink(url);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.link, {
    type: "campaign",
    campaign: "verao-2026",
    channel: "instagram",
    clickId: "c1",
    key: "click:c1",
  });
});

test("link de indicação: ida e volta", () => {
  const url = buildReferralLink({ referrer: "MARIA42", channel: "whatsapp" });
  const parsed = parseLink(url);
  assert.ok(parsed.ok);
  assert.equal(parsed.link.type, "referral");
  assert.equal(parsed.link.referrer, "MARIA42");
  assert.equal(parsed.link.key, "static:referral||MARIA42|whatsapp");
});

test("link estático: mesma chave independentemente da ordem dos parâmetros", () => {
  const a = parseLink("https://conty.app/a?ct_v=1&ct_type=referral&ct_ref=ANA");
  const b = parseLink("https://conty.app/a?ct_ref=ANA&ct_type=referral&ct_v=1&utm_source=x");
  assert.ok(a.ok && b.ok);
  assert.equal(a.link.key, b.link.key);
});

test("links inválidos dizem o porquê", () => {
  const cases: Array<[string, RegExp]> = [
    ["não é url", /malformada/],
    ["https://conty.app/a?ct_type=campaign&ct_campaign=x", /ct_v/],
    ["https://conty.app/a?ct_v=1&ct_type=promo", /ct_type/],
    ["https://conty.app/a?ct_v=1&ct_type=campaign", /ct_campaign obrigatório/],
    ["https://conty.app/a?ct_v=1&ct_type=referral&ct_campaign=x", /ct_ref obrigatório/],
    ["https://conty.app/a?ct_v=1&ct_type=referral&ct_ref=a%20b", /ct_ref inválido/],
  ];
  for (const [url, error] of cases) {
    const parsed = parseLink(url);
    assert.equal(parsed.ok, false, url);
    if (!parsed.ok) assert.match(parsed.error, error, url);
  }
});

test("build rejeita ids fora do padrão", () => {
  assert.throws(() => buildCampaignLink({ campaign: "com espaço" }), /ct_campaign inválido/);
});
