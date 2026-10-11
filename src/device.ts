// Lado do app: o que é gravado na primeira abertura e a cada link recebido,
// e o payload que o cadastro envia ao backend.

import { randomUUID } from "node:crypto";
import { parseLink } from "./link.ts";

/** Armazenamento persistente do app (AsyncStorage, SharedPreferences, Keychain...). */
export interface KeyValueStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export class MemoryStorage implements KeyValueStorage {
  private data = new Map<string, string>();
  get(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.data.set(key, value);
  }
}

export interface CapturedTouch {
  /** URL exatamente como chegou ao app. O backend reinterpreta; o app não decide nada. */
  url: string;
  /** Relógio do app no momento em que o link foi entregue ao app (ISO 8601). */
  capturedAt: string;
}

export interface DeviceState {
  installId: string;
  /** Gravado uma única vez, na primeira abertura. Nunca é sobrescrito. */
  firstOpenAt: string;
  touches: CapturedTouch[];
  signedUpAt: string | null;
}

/** Corpo que o app manda junto do cadastro (campo `attribution`). */
export interface AttributionPayload {
  installId: string;
  firstOpenAt: string;
  /** Relógio do app no envio; o backend usa para corrigir o desvio de relógio. */
  clientSentAt: string;
  touches: CapturedTouch[];
}

export type CaptureStatus = "recorded" | "duplicate" | "ignored_after_signup";

const STATE_KEY = "conty.attribution.v1";

export class AttributionRecorder {
  private storage: KeyValueStorage;
  private now: () => Date;
  private newId: () => string;

  constructor(storage: KeyValueStorage, now: () => Date = () => new Date(), newId: () => string = randomUUID) {
    this.storage = storage;
    this.now = now;
    this.newId = newId;
  }

  /**
   * Chamar em toda abertura do app, antes de tratar qualquer link.
   * Na primeira vez grava installId e firstOpenAt; nas demais só lê.
   */
  open(): DeviceState {
    const existing = this.load();
    if (existing) return existing;
    const state: DeviceState = {
      installId: this.newId(),
      firstOpenAt: this.now().toISOString(),
      touches: [],
      signedUpAt: null,
    };
    this.save(state);
    return state;
  }

  /**
   * Chamar com cada link recebido (deep link, universal link, deferred deep link).
   * O mesmo clique entregue de novo (cold start + resume, retry do SO) não é regravado.
   */
  captureLink(url: string): CaptureStatus {
    const state = this.open();
    if (state.signedUpAt !== null) return "ignored_after_signup";

    const key = dedupeKey(url);
    if (state.touches.some((t) => dedupeKey(t.url) === key)) return "duplicate";

    state.touches.push({ url, capturedAt: this.now().toISOString() });
    this.save(state);
    return "recorded";
  }

  /** Payload enviado no cadastro. */
  buildSignupPayload(): AttributionPayload {
    const state = this.open();
    return {
      installId: state.installId,
      firstOpenAt: state.firstOpenAt,
      clientSentAt: this.now().toISOString(),
      touches: state.touches.map((t) => ({ ...t })),
    };
  }

  /** Chamar quando o backend confirmar o cadastro. Links posteriores deixam de ser gravados. */
  markSignedUp(): void {
    const state = this.open();
    if (state.signedUpAt !== null) return;
    state.signedUpAt = this.now().toISOString();
    this.save(state);
  }

  private load(): DeviceState | null {
    const raw = this.storage.get(STATE_KEY);
    return raw === null ? null : (JSON.parse(raw) as DeviceState);
  }

  private save(state: DeviceState): void {
    this.storage.set(STATE_KEY, JSON.stringify(state));
  }
}

function dedupeKey(url: string): string {
  const parsed = parseLink(url);
  // Link inválido também é gravado (o backend registra o motivo); deduplica pela URL crua.
  return parsed.ok ? parsed.link.key : `raw:${url}`;
}
