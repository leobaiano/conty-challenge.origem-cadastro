// Backend: decide a origem de um cadastro a partir do payload do app e
// devolve todos os toques considerados com o motivo de cada decisão.

import type { AttributionPayload } from "./device.ts";
import { parseLink, type TouchType } from "./link.ts";

/** Janela de validade: 7 dias contados da primeira abertura do app. */
export const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Desempate quando dois toques válidos têm o mesmo horário: maior vence. */
export const TYPE_PRIORITY: Record<TouchType, number> = { referral: 2, campaign: 1 };

export const RULE =
  "último toque válido vence (last-touch). Válido = capturado entre a primeira abertura e " +
  "primeira abertura + janela, e não depois do cadastro. Empate de horário: indicação vence " +
  "campanha; persistindo o empate, vence a menor chave do toque (ordem lexicográfica).";

export type TouchStatus =
  | "won"
  | "lost_to_newer"
  | "lost_tie_break"
  | "duplicate"
  | "invalid"
  | "before_first_open"
  | "after_signup"
  | "outside_window";

export interface EvaluatedTouch {
  /** Posição no payload enviado pelo app. */
  index: number;
  url: string;
  key: string | null;
  type: TouchType | null;
  campaign: string | null;
  referrer: string | null;
  channel: string | null;
  clickId: string | null;
  /** Como o app informou (relógio do app). */
  capturedAtClient: string;
  /** Convertido para o relógio do servidor. */
  capturedAt: string | null;
  status: TouchStatus;
  reason: string;
}

export type Origin =
  | { kind: "campaign"; campaign: string; channel: string | null }
  | { kind: "referral"; referrer: string; channel: string | null }
  | { kind: "organic" };

export type OrganicReason = "no_attribution_payload" | "no_touches" | "no_valid_touches";

export interface AttributionResult {
  installId: string | null;
  signupAt: string;
  origin: Origin;
  /** Preenchido só quando a origem é orgânica. */
  organicReason: OrganicReason | null;
  /** Explicação legível da decisão final. */
  reason: string;
  rule: string;
  window: { start: string | null; end: string | null; durationMs: number };
  /** Servidor − app, em ms, aplicado aos horários do app. */
  clockOffsetMs: number | null;
  winner: { index: number; key: string } | null;
  touches: EvaluatedTouch[];
}

export interface ResolveInput {
  /** Momento do cadastro, no relógio do servidor. */
  signupAt: Date;
  /** Payload do app; null quando o app não mandou nada (versão antiga, cadastro web...). */
  payload: AttributionPayload | null;
  /** Quando o servidor recebeu o payload. Default: signupAt. */
  payloadReceivedAt?: Date;
  windowMs?: number;
}

export function resolveAttribution(input: ResolveInput): AttributionResult {
  const windowMs = input.windowMs ?? DEFAULT_WINDOW_MS;
  const signupAt = input.signupAt;
  const base = {
    signupAt: signupAt.toISOString(),
    rule: RULE,
  };

  if (input.payload === null) {
    return {
      ...base,
      installId: null,
      origin: { kind: "organic" },
      organicReason: "no_attribution_payload",
      reason: "Cadastro sem payload de atribuição do app; marcado como orgânico.",
      window: { start: null, end: null, durationMs: windowMs },
      clockOffsetMs: null,
      winner: null,
      touches: [],
    };
  }

  const payload = input.payload;
  const receivedAt = input.payloadReceivedAt ?? signupAt;
  const offset = receivedAt.getTime() - Date.parse(payload.clientSentAt);
  if (Number.isNaN(offset)) throw new Error("clientSentAt inválido");
  const firstOpenMs = Date.parse(payload.firstOpenAt);
  if (Number.isNaN(firstOpenMs)) throw new Error("firstOpenAt inválido");

  const windowStart = firstOpenMs + offset;
  const windowEnd = windowStart + windowMs;
  const signupMs = signupAt.getTime();

  const touches: EvaluatedTouch[] = payload.touches.map((t, index) => {
    const parsed = parseLink(t.url);
    const clientMs = Date.parse(t.capturedAt);
    const evaluated: EvaluatedTouch = {
      index,
      url: t.url,
      key: parsed.ok ? parsed.link.key : null,
      type: parsed.ok ? parsed.link.type : null,
      campaign: parsed.ok ? parsed.link.campaign ?? null : null,
      referrer: parsed.ok ? parsed.link.referrer ?? null : null,
      channel: parsed.ok ? parsed.link.channel ?? null : null,
      clickId: parsed.ok ? parsed.link.clickId ?? null : null,
      capturedAtClient: t.capturedAt,
      capturedAt: Number.isNaN(clientMs) ? null : new Date(clientMs + offset).toISOString(),
      status: "invalid",
      reason: "",
    };
    if (!parsed.ok) evaluated.reason = `Link inválido: ${parsed.error}.`;
    else if (Number.isNaN(clientMs)) evaluated.reason = "Horário de captura inválido.";
    return evaluated;
  });

  // Ordem cronológica estável; a primeira ocorrência de cada chave é a que conta.
  const chronological = touches
    .filter((t) => t.reason === "")
    .sort((a, b) => Date.parse(a.capturedAt!) - Date.parse(b.capturedAt!) || a.index - b.index);

  const firstByKey = new Map<string, EvaluatedTouch>();
  const eligible: EvaluatedTouch[] = [];
  for (const t of chronological) {
    const at = Date.parse(t.capturedAt!);
    const original = firstByKey.get(t.key!);
    if (original) {
      t.status = "duplicate";
      t.reason = `Mesmo clique (${t.key}) já registrado no toque #${original.index}; não cria nova origem.`;
      continue;
    }
    firstByKey.set(t.key!, t);
    if (at > signupMs) {
      t.status = "after_signup";
      t.reason = `Capturado em ${t.capturedAt}, depois do cadastro (${base.signupAt}).`;
    } else if (at < windowStart) {
      t.status = "before_first_open";
      t.reason = `Capturado em ${t.capturedAt}, antes da primeira abertura do app (${iso(windowStart)}).`;
    } else if (at > windowEnd) {
      t.status = "outside_window";
      t.reason = `Capturado em ${t.capturedAt}, após o fim da janela (${iso(windowEnd)}).`;
    } else {
      eligible.push(t);
    }
  }

  const winner = eligible.reduce<EvaluatedTouch | null>(
    (best, t) => (best === null || beats(t, best) ? t : best),
    null,
  );

  for (const t of eligible) {
    if (t === winner) continue;
    const sameTime = t.capturedAt === winner!.capturedAt;
    t.status = sameTime ? "lost_tie_break" : "lost_to_newer";
    t.reason = sameTime
      ? `Empate de horário com o toque #${winner!.index}; ${tieBreakExplanation(winner!, t)}`
      : `Válido, mas há toque válido mais recente (#${winner!.index}, ${winner!.capturedAt}).`;
  }

  const window = { start: iso(windowStart), end: iso(windowEnd), durationMs: windowMs };

  if (winner === null) {
    const empty = touches.length === 0;
    return {
      ...base,
      installId: payload.installId,
      origin: { kind: "organic" },
      organicReason: empty ? "no_touches" : "no_valid_touches",
      reason: empty
        ? "Nenhum link foi capturado pelo app antes do cadastro; marcado como orgânico."
        : `Nenhum dos ${touches.length} toque(s) é válido (ver motivo de cada um); marcado como orgânico.`,
      window,
      clockOffsetMs: offset,
      winner: null,
      touches,
    };
  }

  winner.status = "won";
  winner.reason =
    eligible.length === 1
      ? "Único toque válido dentro da janela e antes do cadastro."
      : `Toque válido mais recente entre ${eligible.length} válidos.` +
        (eligible.some((t) => t !== winner && t.capturedAt === winner.capturedAt) ? " Venceu o desempate." : "");

  const origin: Origin =
    winner.type === "campaign"
      ? { kind: "campaign", campaign: winner.campaign!, channel: winner.channel }
      : { kind: "referral", referrer: winner.referrer!, channel: winner.channel };

  return {
    ...base,
    installId: payload.installId,
    origin,
    organicReason: null,
    reason: `Origem ${describe(origin)} pelo toque #${winner.index}: ${winner.reason}`,
    window,
    clockOffsetMs: offset,
    winner: { index: winner.index, key: winner.key! },
    touches,
  };
}

/** a vence b? */
function beats(a: EvaluatedTouch, b: EvaluatedTouch): boolean {
  const at = Date.parse(a.capturedAt!);
  const bt = Date.parse(b.capturedAt!);
  if (at !== bt) return at > bt;
  const ap = TYPE_PRIORITY[a.type!];
  const bp = TYPE_PRIORITY[b.type!];
  if (ap !== bp) return ap > bp;
  return a.key! < b.key!;
}

function tieBreakExplanation(winner: EvaluatedTouch, loser: EvaluatedTouch): string {
  if (winner.type !== loser.type) return `${winner.type} tem prioridade sobre ${loser.type}.`;
  return `mesmo tipo; venceu a menor chave (${winner.key} < ${loser.key}).`;
}

function describe(origin: Origin): string {
  if (origin.kind === "campaign") return `campanha ${origin.campaign}`;
  if (origin.kind === "referral") return `indicação ${origin.referrer}`;
  return "orgânica";
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
