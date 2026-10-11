import { test } from "node:test";
import assert from "node:assert/strict";
import { AttributionRecorder, MemoryStorage } from "../src/device.ts";
import { buildCampaignLink, buildReferralLink } from "../src/link.ts";
import { DAY, at, fakeClock } from "./helpers.ts";

const newRecorder = () => {
  const clock = fakeClock();
  const storage = new MemoryStorage();
  let n = 0;
  const recorder = new AttributionRecorder(storage, clock.now, () => `install-${++n}`);
  return { clock, storage, recorder };
};

test("primeira abertura é gravada uma vez e nunca sobrescrita", () => {
  const { clock, storage, recorder } = newRecorder();
  const first = recorder.open();
  assert.equal(first.firstOpenAt, at(0));
  assert.equal(first.installId, "install-1");

  clock.set(3 * DAY);
  const again = new AttributionRecorder(storage, clock.now, () => "outro").open();
  assert.equal(again.firstOpenAt, at(0));
  assert.equal(again.installId, "install-1");
});

test("o mesmo clique entregue duas vezes é gravado uma vez", () => {
  const { clock, recorder } = newRecorder();
  const url = buildCampaignLink({ campaign: "verao", clickId: "k1" });
  assert.equal(recorder.captureLink(url), "recorded");
  clock.set(60_000);
  assert.equal(recorder.captureLink(url), "duplicate");
  assert.equal(recorder.buildSignupPayload().touches.length, 1);
  assert.equal(recorder.buildSignupPayload().touches[0].capturedAt, at(0));
});

test("cliques diferentes são toques diferentes", () => {
  const { clock, recorder } = newRecorder();
  recorder.captureLink(buildCampaignLink({ campaign: "verao", clickId: "k1" }));
  clock.set(1000);
  recorder.captureLink(buildCampaignLink({ campaign: "verao", clickId: "k2" }));
  recorder.captureLink(buildReferralLink({ referrer: "ANA" }));
  assert.equal(recorder.buildSignupPayload().touches.length, 3);
});

test("depois do cadastro o app não grava novos links", () => {
  const { recorder } = newRecorder();
  recorder.markSignedUp();
  assert.equal(recorder.captureLink(buildReferralLink({ referrer: "ANA" })), "ignored_after_signup");
  assert.equal(recorder.buildSignupPayload().touches.length, 0);
});

test("link inválido também é gravado para auditoria", () => {
  const { recorder } = newRecorder();
  assert.equal(recorder.captureLink("https://conty.app/a?foo=bar"), "recorded");
  assert.equal(recorder.captureLink("https://conty.app/a?foo=bar"), "duplicate");
  assert.equal(recorder.buildSignupPayload().touches.length, 1);
});

test("link estático (sem ct_click) reaberto é o mesmo toque; com ct_click, cada clique conta", () => {
  const { clock, recorder } = newRecorder();
  assert.equal(recorder.captureLink("https://conty.app/a?ct_v=1&ct_type=referral&ct_ref=ANA"), "recorded");
  clock.set(DAY);
  assert.equal(recorder.captureLink("https://conty.app/a?ct_ref=ANA&ct_type=referral&ct_v=1"), "duplicate");
  assert.equal(recorder.captureLink(buildReferralLink({ referrer: "ANA", clickId: "k1" })), "recorded");
  assert.equal(recorder.captureLink(buildReferralLink({ referrer: "ANA", clickId: "k2" })), "recorded");
  assert.equal(recorder.buildSignupPayload().touches.length, 3);
});
