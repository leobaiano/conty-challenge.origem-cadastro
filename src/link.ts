// Contrato do link: tudo que a atribuição precisa viaja na URL, porque o
// webview que abre o link normalmente não repassa referrer.

export const LINK_BASE = "https://conty.app/a";
export const CONTRACT_VERSION = "1";

export type TouchType = "campaign" | "referral";

export interface ParsedLink {
  type: TouchType;
  /** Id da campanha (obrigatório quando type = campaign). */
  campaign?: string;
  /** Código de indicação de quem convidou (obrigatório quando type = referral). */
  referrer?: string;
  /** Canal onde o link foi postado (instagram, whatsapp, comunidade...). Opcional. */
  channel?: string;
  /** Id único do clique, gerado pelo redirecionador no momento do clique. Opcional. */
  clickId?: string;
  /**
   * Chave de deduplicação do toque. Com clickId: `click:<clickId>`.
   * Sem clickId (link estático): `static:` + parâmetros normalizados, então
   * reabrir o mesmo link estático é o mesmo toque.
   */
  key: string;
}

export type ParseResult =
  | { ok: true; link: ParsedLink }
  | { ok: false; error: string };

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface CampaignLinkInput {
  campaign: string;
  channel?: string;
  clickId?: string;
}

export interface ReferralLinkInput {
  referrer: string;
  channel?: string;
  clickId?: string;
}

export function buildCampaignLink(input: CampaignLinkInput, base = LINK_BASE): string {
  return buildLink(base, {
    ct_type: "campaign",
    ct_campaign: input.campaign,
    ct_channel: input.channel,
    ct_click: input.clickId,
  });
}

export function buildReferralLink(input: ReferralLinkInput, base = LINK_BASE): string {
  return buildLink(base, {
    ct_type: "referral",
    ct_ref: input.referrer,
    ct_channel: input.channel,
    ct_click: input.clickId,
  });
}

function buildLink(base: string, params: Record<string, string | undefined>): string {
  const url = new URL(base);
  url.searchParams.set("ct_v", CONTRACT_VERSION);
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (name !== "ct_type" && !ID_PATTERN.test(value)) {
      throw new Error(`${name} inválido: ${JSON.stringify(value)}`);
    }
    url.searchParams.set(name, value);
  }
  return url.toString();
}

export function parseLink(raw: string): ParseResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "URL malformada" };
  }
  const p = url.searchParams;

  const version = p.get("ct_v");
  if (version !== CONTRACT_VERSION) {
    return { ok: false, error: `versão do contrato ausente ou desconhecida (ct_v=${version ?? "∅"})` };
  }

  const type = p.get("ct_type");
  if (type !== "campaign" && type !== "referral") {
    return { ok: false, error: `ct_type inválido (${type ?? "∅"})` };
  }

  // Cada tipo lê só o seu id; um ct_ref num link de campanha é ignorado.
  const fields: Array<[keyof ParsedLink, string, boolean]> = [
    type === "campaign" ? ["campaign", "ct_campaign", true] : ["referrer", "ct_ref", true],
    ["channel", "ct_channel", false],
    ["clickId", "ct_click", false],
  ];
  const link: Partial<ParsedLink> = { type };
  for (const [field, param, required] of fields) {
    const value = p.get(param);
    if (value === null || value === "") {
      if (required) return { ok: false, error: `${param} obrigatório para ct_type=${type}` };
      continue;
    }
    if (!ID_PATTERN.test(value)) return { ok: false, error: `${param} inválido` };
    (link as Record<string, string>)[field] = value;
  }

  link.key = link.clickId
    ? `click:${link.clickId}`
    : `static:${type}|${link.campaign ?? ""}|${link.referrer ?? ""}|${link.channel ?? ""}`;

  return { ok: true, link: link as ParsedLink };
}
