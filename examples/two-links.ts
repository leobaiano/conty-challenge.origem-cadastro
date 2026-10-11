// Simula um criador que recebeu uma indicação, depois clicou numa campanha
// (o mesmo clique chegou duas vezes ao app), e se cadastrou no dia seguinte.
// Imprime a resposta do cadastro com todos os toques e o motivo de cada um.
//
//   npm run example

import { AttributionRecorder, MemoryStorage } from "../src/device.ts";
import { buildCampaignLink, buildReferralLink } from "../src/link.ts";
import { resolveAttribution } from "../src/resolver.ts";

const HOUR = 60 * 60 * 1000;
let now = Date.parse("2026-10-01T12:00:00.000Z");
const recorder = new AttributionRecorder(new MemoryStorage(), () => new Date(now), () => "inst-7f3a");

const referralLink = buildReferralLink({ referrer: "MARIA42", channel: "whatsapp", clickId: "r-01HZX9" });
const campaignLink = buildCampaignLink({ campaign: "verao-2026", channel: "instagram", clickId: "c-01HZY2" });

recorder.open(); // primeira abertura (instalou a partir do link de indicação)
recorder.captureLink(referralLink);
now += 30 * HOUR;
recorder.captureLink(campaignLink);
recorder.captureLink(campaignLink); // mesmo clique entregue de novo (cold start + resume)
now += 2 * 24 * HOUR;
recorder.captureLink("https://conty.app/a?ct_v=1&ct_type=campaign"); // link truncado pelo webview
now += 6 * 24 * HOUR;
recorder.captureLink(buildCampaignLink({ campaign: "black-friday", clickId: "c-01J0A1" })); // fora da janela
now += HOUR;

const payload = recorder.buildSignupPayload();
const result = resolveAttribution({ signupAt: new Date(now), payload });

console.log(JSON.stringify({ request: { userId: "creator-123", attribution: payload }, response: { userId: "creator-123", attribution: result } }, null, 2));
