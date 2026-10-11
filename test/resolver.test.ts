import { test } from "node:test";
import assert from "node:assert/strict";
import type { AttributionPayload, CapturedTouch } from "../src/device.ts";
import { buildCampaignLink, buildReferralLink } from "../src/link.ts";
import { DEFAULT_WINDOW_MS, resolveAttribution } from "../src/resolver.ts";
import { DAY, T0, at } from "./helpers.ts";

const campaign = (id: string, clickId?: string) => buildCampaignLink({ campaign: id, clickId });
const referral = (code: string, clickId?: string) => buildReferralLink({ referrer: code, clickId });

/** Payload com primeira abertura em T0 e relógio do app igual ao do servidor. */
function payload(touches: CapturedTouch[], sentAtMs = 0): AttributionPayload {
  return { installId: "inst-1", firstOpenAt: at(0), clientSentAt: at(sentAtMs), touches };
}

function resolve(touches: CapturedTouch[], signupMs: number) {
  return resolveAttribution({ signupAt: new Date(T0 + signupMs), payload: payload(touches, signupMs) });
}

const statuses = (r: ReturnType<typeof resolve>) => r.touches.map((t) => t.status);

test("janela padrão é explícita: 7 dias a partir da primeira abertura", () => {
  assert.equal(DEFAULT_WINDOW_MS, 7 * DAY);
  const r = resolve([], DAY);
  assert.deepEqual(r.window, { start: at(0), end: at(7 * DAY), durationMs: 7 * DAY });
});

test("cadastro sem payload é orgânico com motivo", () => {
  const r = resolveAttribution({ signupAt: new Date(T0), payload: null });
  assert.deepEqual(r.origin, { kind: "organic" });
  assert.equal(r.organicReason, "no_attribution_payload");
  assert.match(r.reason, /sem payload/);
});

test("cadastro sem nenhum toque é orgânico com motivo", () => {
  const r = resolve([], DAY);
  assert.deepEqual(r.origin, { kind: "organic" });
  assert.equal(r.organicReason, "no_touches");
  assert.match(r.reason, /Nenhum link/);
});

test("dois links diferentes antes do cadastro: o mais recente vence", () => {
  const r = resolve(
    [
      { url: referral("ANA", "r1"), capturedAt: at(1 * DAY) },
      { url: campaign("verao", "c1"), capturedAt: at(2 * DAY) },
    ],
    3 * DAY,
  );
  assert.deepEqual(r.origin, { kind: "campaign", campaign: "verao", channel: null });
  assert.deepEqual(statuses(r), ["lost_to_newer", "won"]);
  assert.deepEqual(r.winner, { index: 1, key: "click:c1" });
  assert.match(r.touches[0].reason, /mais recente \(#1/);
});

test("empate de horário: indicação vence campanha, em qualquer ordem do payload", () => {
  const touches = [
    { url: campaign("verao", "c1"), capturedAt: at(DAY) },
    { url: referral("ANA", "r1"), capturedAt: at(DAY) },
  ];
  for (const order of [touches, [...touches].reverse()]) {
    const r = resolve(order, 2 * DAY);
    assert.deepEqual(r.origin, { kind: "referral", referrer: "ANA", channel: null });
    const loser = r.touches.find((t) => t.type === "campaign")!;
    assert.equal(loser.status, "lost_tie_break");
    assert.match(loser.reason, /referral tem prioridade sobre campaign/);
    assert.match(r.reason, /desempate/);
  }
});

test("empate de horário entre dois do mesmo tipo: menor chave vence (determinístico)", () => {
  const touches = [
    { url: campaign("inverno", "zz"), capturedAt: at(DAY) },
    { url: campaign("verao", "aa"), capturedAt: at(DAY) },
  ];
  for (const order of [touches, [...touches].reverse()]) {
    const r = resolve(order, 2 * DAY);
    assert.deepEqual(r.origin, { kind: "campaign", campaign: "verao", channel: null });
    assert.equal(r.winner!.key, "click:aa");
  }
});

test("o mesmo clique repetido não cria duas origens", () => {
  const url = campaign("verao", "c1");
  const r = resolve(
    [
      { url, capturedAt: at(DAY) },
      { url, capturedAt: at(2 * DAY) },
    ],
    3 * DAY,
  );
  assert.deepEqual(statuses(r), ["won", "duplicate"]);
  assert.match(r.touches[1].reason, /Mesmo clique \(click:c1\).*#0/);
  // O horário que conta é o da primeira ocorrência.
  assert.equal(r.touches.filter((t) => t.status === "won").length, 1);
});

test("clique repetido não rouba a vitória de outro link mais recente", () => {
  const url = campaign("verao", "c1");
  const r = resolve(
    [
      { url, capturedAt: at(1 * DAY) },
      { url: referral("ANA", "r1"), capturedAt: at(2 * DAY) },
      { url, capturedAt: at(3 * DAY) },
    ],
    4 * DAY,
  );
  assert.deepEqual(r.origin, { kind: "referral", referrer: "ANA", channel: null });
  assert.deepEqual(statuses(r), ["lost_to_newer", "won", "duplicate"]);
});

test("toque fora da janela não vence, mesmo sendo o mais recente", () => {
  const r = resolve(
    [
      { url: referral("ANA", "r1"), capturedAt: at(1 * DAY) },
      { url: campaign("verao", "c1"), capturedAt: at(8 * DAY) },
    ],
    9 * DAY,
  );
  assert.deepEqual(r.origin, { kind: "referral", referrer: "ANA", channel: null });
  assert.deepEqual(statuses(r), ["won", "outside_window"]);
  assert.match(r.touches[1].reason, /após o fim da janela \(2026-10-08T12:00:00.000Z\)/);
});

test("janela conta da primeira abertura: limite exato ainda vale, 1 ms depois não", () => {
  const ok = resolve([{ url: campaign("verao"), capturedAt: at(7 * DAY) }], 8 * DAY);
  assert.equal(ok.touches[0].status, "won");
  const late = resolve([{ url: campaign("verao"), capturedAt: at(7 * DAY + 1) }], 8 * DAY);
  assert.equal(late.touches[0].status, "outside_window");
  assert.deepEqual(late.origin, { kind: "organic" });
  assert.equal(late.organicReason, "no_valid_touches");
});

test("janela configurável aparece no resultado", () => {
  const r = resolveAttribution({
    signupAt: new Date(T0 + 3 * DAY),
    payload: payload([{ url: campaign("verao"), capturedAt: at(2 * DAY) }], 3 * DAY),
    windowMs: DAY,
  });
  assert.equal(r.window.durationMs, DAY);
  assert.equal(r.touches[0].status, "outside_window");
});

test("toque posterior ao cadastro não vence, mesmo dentro da janela", () => {
  const r = resolveAttribution({
    signupAt: new Date(T0 + 2 * DAY),
    // payload chegou depois do cadastro (ex.: cadastro feito na web, app enviou depois)
    payloadReceivedAt: new Date(T0 + 4 * DAY),
    payload: payload(
      [
        { url: campaign("verao", "c1"), capturedAt: at(1 * DAY) },
        { url: referral("ANA", "r1"), capturedAt: at(3 * DAY) },
      ],
      4 * DAY,
    ),
  });
  assert.deepEqual(r.origin, { kind: "campaign", campaign: "verao", channel: null });
  assert.deepEqual(statuses(r), ["won", "after_signup"]);
  assert.match(r.touches[1].reason, /depois do cadastro/);
});

test("só toques posteriores ao cadastro: orgânico com motivo", () => {
  const r = resolveAttribution({
    signupAt: new Date(T0),
    payloadReceivedAt: new Date(T0 + DAY),
    payload: payload([{ url: referral("ANA"), capturedAt: at(DAY / 2) }], DAY),
  });
  assert.equal(r.organicReason, "no_valid_touches");
  assert.match(r.reason, /Nenhum dos 1 toque/);
});

test("toque anterior à primeira abertura é rejeitado", () => {
  const r = resolve([{ url: campaign("verao"), capturedAt: at(-1000) }], DAY);
  assert.equal(r.touches[0].status, "before_first_open");
});

test("link inválido é listado com motivo e não vence", () => {
  const r = resolve(
    [
      { url: "https://conty.app/a?ct_v=1&ct_type=campaign", capturedAt: at(DAY) },
      { url: campaign("verao"), capturedAt: at(DAY / 2) },
    ],
    2 * DAY,
  );
  assert.deepEqual(statuses(r), ["invalid", "won"]);
  assert.match(r.touches[0].reason, /ct_campaign obrigatório/);
});

test("relógio do app adiantado: horários são corrigidos pelo desvio", () => {
  const skew = 2 * 60 * 60 * 1000; // app 2h adiantado
  const r = resolveAttribution({
    signupAt: new Date(T0 + DAY),
    payload: {
      installId: "inst-1",
      firstOpenAt: at(skew),
      clientSentAt: at(DAY + skew),
      touches: [{ url: campaign("verao"), capturedAt: at(DAY / 2 + skew) }],
    },
  });
  assert.equal(r.clockOffsetMs, -skew);
  assert.equal(r.window.start, at(0));
  assert.equal(r.touches[0].capturedAt, at(DAY / 2));
  assert.equal(r.touches[0].capturedAtClient, at(DAY / 2 + skew));
  assert.equal(r.touches[0].status, "won");
});

test("todo toque recebe status e motivo não vazio", () => {
  const r = resolve(
    [
      { url: campaign("a", "1"), capturedAt: at(DAY) },
      { url: campaign("a", "1"), capturedAt: at(DAY) },
      { url: referral("B", "2"), capturedAt: at(DAY) },
      { url: campaign("c", "3"), capturedAt: at(DAY / 2) },
      { url: "lixo", capturedAt: at(DAY) },
      { url: campaign("d", "4"), capturedAt: at(9 * DAY) },
    ],
    10 * DAY,
  );
  for (const t of r.touches) assert.ok(t.reason.length > 0, `toque #${t.index} sem motivo`);
  assert.deepEqual(statuses(r), ["lost_tie_break", "duplicate", "won", "lost_to_newer", "invalid", "outside_window"]);
});
