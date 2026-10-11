import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { AttributionRecorder, MemoryStorage } from "../src/device.ts";
import { buildCampaignLink, buildReferralLink } from "../src/link.ts";
import { createServer } from "../src/server.ts";
import { DAY, fakeClock } from "./helpers.ts";

async function withServer(fn: (base: string, clock: ReturnType<typeof fakeClock>) => Promise<void>) {
  const clock = fakeClock();
  const server = createServer({ now: clock.now });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, clock);
  } finally {
    server.close();
  }
}

const call = async (url: string, method: string, body?: unknown) => {
  const res = await fetch(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
};

test("fluxo completo: app grava, cadastro consome, auditoria mostra todos os toques", async () => {
  await withServer(async (base, clock) => {
    const recorder = new AttributionRecorder(new MemoryStorage(), clock.now);
    recorder.open();
    clock.set(DAY);
    recorder.captureLink(buildReferralLink({ referrer: "ANA", clickId: "r1" }));
    clock.set(2 * DAY);
    recorder.captureLink(buildCampaignLink({ campaign: "verao", channel: "tiktok", clickId: "c1" }));
    recorder.captureLink(buildCampaignLink({ campaign: "verao", channel: "tiktok", clickId: "c1" }));
    clock.set(3 * DAY);

    const created = await call(`${base}/signups`, "POST", { userId: "u1", attribution: recorder.buildSignupPayload() });
    assert.equal(created.status, 201);
    assert.deepEqual(created.json.attribution.origin, { kind: "campaign", campaign: "verao", channel: "tiktok" });
    assert.deepEqual(
      created.json.attribution.touches.map((t: any) => t.status),
      ["lost_to_newer", "won"],
    );
    recorder.markSignedUp();

    const audit = await call(`${base}/signups/u1/attribution`, "GET");
    assert.equal(audit.status, 200);
    assert.deepEqual(audit.json.attribution, created.json.attribution);
  });
});

test("payload enviado depois do cadastro: toque posterior não vence", async () => {
  await withServer(async (base, clock) => {
    const recorder = new AttributionRecorder(new MemoryStorage(), clock.now);
    recorder.open();
    clock.set(DAY);
    // cadastro feito sem payload (ex.: pela web)
    const created = await call(`${base}/signups`, "POST", { userId: "u2" });
    assert.equal(created.json.attribution.organicReason, "no_attribution_payload");

    clock.set(2 * DAY);
    recorder.captureLink(buildReferralLink({ referrer: "ANA" }));
    const updated = await call(`${base}/signups/u2/attribution`, "PUT", { attribution: recorder.buildSignupPayload() });
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.json.attribution.origin, { kind: "organic" });
    assert.equal(updated.json.attribution.organicReason, "no_valid_touches");
    assert.equal(updated.json.attribution.touches[0].status, "after_signup");
  });
});

test("erros de entrada", async () => {
  await withServer(async (base) => {
    assert.equal((await call(`${base}/signups`, "POST", {})).status, 400);
    assert.equal((await call(`${base}/signups`, "POST", { userId: "u" })).status, 201);
    assert.equal((await call(`${base}/signups`, "POST", { userId: "u" })).status, 409);
    assert.equal((await call(`${base}/signups/x/attribution`, "GET")).status, 404);
    const bad = await fetch(`${base}/signups`, { method: "POST", body: "{" });
    assert.equal(bad.status, 400);
  });
});
