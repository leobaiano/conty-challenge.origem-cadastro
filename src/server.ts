// API HTTP mínima (node:http, armazenamento em memória) sobre o resolvedor.
//
//   POST /signups                      { userId, attribution: AttributionPayload | null }
//   PUT  /signups/:userId/attribution  { attribution }  payload que chegou depois do cadastro
//   GET  /signups/:userId/attribution  auditoria: origem + todos os toques e motivos

import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import type { AttributionPayload } from "./device.ts";
import { resolveAttribution, type AttributionResult } from "./resolver.ts";

interface SignupRecord {
  userId: string;
  signupAt: Date;
  payload: AttributionPayload | null;
  payloadReceivedAt: Date;
  result: AttributionResult;
}

export interface ServerOptions {
  now?: () => Date;
  windowMs?: number;
}

export function createServer(options: ServerOptions = {}): Server {
  const now = options.now ?? (() => new Date());
  const signups = new Map<string, SignupRecord>();

  const resolve = (r: Omit<SignupRecord, "result">): SignupRecord => ({
    ...r,
    result: resolveAttribution({
      signupAt: r.signupAt,
      payload: r.payload,
      payloadReceivedAt: r.payloadReceivedAt,
      windowMs: options.windowMs,
    }),
  });

  return createHttpServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body, null, 2));
    };
    try {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      const match = path.match(/^\/signups\/([^/]+)\/attribution$/);

      if (req.method === "POST" && path === "/signups") {
        const body = await readJson(req);
        const userId = body.userId;
        if (typeof userId !== "string" || userId === "") return send(400, { error: "userId obrigatório" });
        if (signups.has(userId)) return send(409, { error: "cadastro já existe" });
        const at = now();
        const record = resolve({ userId, signupAt: at, payload: body.attribution ?? null, payloadReceivedAt: at });
        signups.set(userId, record);
        return send(201, { userId, attribution: record.result });
      }

      if (match) {
        const userId = decodeURIComponent(match[1]);
        const existing = signups.get(userId);
        if (!existing) return send(404, { error: "cadastro não encontrado" });

        if (req.method === "GET") return send(200, { userId, attribution: existing.result });

        if (req.method === "PUT") {
          const body = await readJson(req);
          if (!body.attribution) return send(400, { error: "attribution obrigatório" });
          // O payload do app é cumulativo: o mais recente substitui o anterior.
          // signupAt não muda, então toques capturados após o cadastro continuam sem valer.
          const record = resolve({ ...existing, payload: body.attribution, payloadReceivedAt: now() });
          signups.set(userId, record);
          return send(200, { userId, attribution: record.result });
        }
      }

      send(404, { error: "rota não encontrada" });
    } catch (err) {
      send(400, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("JSON inválido");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.PORT ?? 3000);
  createServer().listen(port, () => console.log(`origem-cadastro ouvindo em http://localhost:${port}`));
}
