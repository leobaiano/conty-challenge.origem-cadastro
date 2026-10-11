# Origem do cadastro

Contrato de atribuição para saber de onde veio cada criador que se cadastra no app:
**o que viaja no link → o que o app grava na primeira abertura → como o cadastro consome isso.**

Biblioteca TypeScript sem dependências, mais uma API HTTP mínima. Precisa de Node ≥ 22.18
(roda `.ts` direto, sem build).

```bash
npm test          # 31 testes (node:test)
npm run example   # imprime um cadastro com 4 toques e o motivo de cada um
npm start         # API em http://localhost:3000
```

## 1. O que viaja no link

O link costuma abrir num webview (Instagram, TikTok, WhatsApp) que não manda referrer.
Por isso **tudo que a atribuição precisa vai na própria URL**; nada depende de referrer, cookie
ou cabeçalho.

| Parâmetro    | Obrigatório               | Conteúdo                                                        |
|--------------|---------------------------|-----------------------------------------------------------------|
| `ct_v`       | sim                       | Versão do contrato. Hoje `1`.                                    |
| `ct_type`    | sim                       | `campaign` ou `referral`.                                        |
| `ct_campaign`| se `ct_type=campaign`     | Id da campanha.                                                  |
| `ct_ref`     | se `ct_type=referral`     | Código de indicação de quem convidou.                            |
| `ct_channel` | não                       | Onde o link foi postado (`instagram`, `whatsapp`, `comunidade`…). |
| `ct_click`   | não (recomendado)         | Id único do clique, gerado pelo redirecionador no clique.        |

Ids aceitam `[A-Za-z0-9_-]`, até 64 caracteres. Link que não cumpre o contrato não é descartado
em silêncio: é gravado e aparece na auditoria com status `invalid` e o motivo.

**Exemplo de link de campanha**

```
https://conty.app/a?ct_v=1&ct_type=campaign&ct_campaign=verao-2026&ct_channel=instagram&ct_click=c-01HZY2
```

**Exemplo de link de indicação**

```
https://conty.app/a?ct_v=1&ct_type=referral&ct_ref=MARIA42&ct_channel=whatsapp&ct_click=r-01HZX9
```

Gerados por `buildCampaignLink` / `buildReferralLink` (`src/link.ts`).

### Identidade do clique (deduplicação)

Cada toque tem uma chave:

- com `ct_click`: `click:<ct_click>`. O redirecionador gera um id por clique, então o
  **mesmo clique** entregue duas vezes ao app (cold start + resume, retry do sistema) tem a
  mesma chave e conta uma vez só; dois cliques reais são dois toques.
- sem `ct_click` (link estático colado numa comunidade): `static:<tipo>|<campanha>|<ref>|<canal>`.
  Reabrir o mesmo link estático é o mesmo toque, seja qual for a ordem dos parâmetros.

## 2. O que o app grava (`AttributionRecorder`, `src/device.ts`)

| Momento                     | Chamada                 | Efeito                                                                     |
|-----------------------------|-------------------------|----------------------------------------------------------------------------|
| Toda abertura do app        | `open()`                | Na **primeira** vez grava `installId` e `firstOpenAt`; depois nunca sobrescreve. |
| Todo link recebido          | `captureLink(url)`      | Guarda `{ url, capturedAt }`. Mesma chave já gravada → `duplicate`, não grava. |
| Cadastro                    | `buildSignupPayload()`  | Monta o payload abaixo.                                                    |
| Backend confirmou cadastro  | `markSignedUp()`        | A partir daqui `captureLink` devolve `ignored_after_signup` e não grava.   |

O app só registra; **quem decide é o backend**. O app guarda a URL crua para que a regra possa
mudar no servidor sem atualizar o app.

Deferred deep link (o criador instalou a partir do link): a URL recuperada na primeira abertura
é passada a `captureLink` logo depois de `open()`, então `capturedAt ≥ firstOpenAt`.

### Payload enviado no cadastro

```json
{
  "userId": "creator-123",
  "attribution": {
    "installId": "inst-7f3a",
    "firstOpenAt": "2026-10-01T12:00:00.000Z",
    "clientSentAt": "2026-10-10T19:00:00.000Z",
    "touches": [
      { "url": "https://conty.app/a?ct_v=1&ct_type=referral&ct_ref=MARIA42…", "capturedAt": "2026-10-01T12:00:00.000Z" }
    ]
  }
}
```

Os horários são do relógio do app. O backend calcula `clockOffsetMs = recebidoNoServidor − clientSentAt`
e converte todos os horários do app para o relógio do servidor antes de comparar com o cadastro.

## 3. Como o cadastro consome (`resolveAttribution`, `src/resolver.ts`)

### Janela de validade

**7 dias contados a partir de `firstOpenAt`** (`DEFAULT_WINDOW_MS`), não do clique nem do cadastro.
Intervalo fechado: `[firstOpenAt, firstOpenAt + 7d]`. Configurável por `windowMs`, e o valor
usado sempre aparece na resposta em `window`.

### Qual toque vence

Cada toque é avaliado nesta ordem e recebe **um** status:

| Status              | Quando                                                                 |
|---------------------|------------------------------------------------------------------------|
| `invalid`           | URL fora do contrato ou horário ilegível.                              |
| `duplicate`         | Mesma chave de um toque anterior; só a primeira ocorrência conta.      |
| `after_signup`      | Capturado depois do cadastro (`signupAt`, relógio do servidor).        |
| `before_first_open` | Capturado antes da primeira abertura (relógio adulterado/inconsistente). |
| `outside_window`    | Capturado depois de `firstOpenAt + janela`.                            |
| `won`               | O vencedor entre os válidos.                                           |
| `lost_to_newer`     | Válido, mas existe válido mais recente.                                |
| `lost_tie_break`    | Válido, mesmo horário do vencedor, perdeu no desempate.                |

**Regra: vence o último toque válido (last-touch).**
Empate de horário (mesmo milissegundo): **indicação vence campanha**; se ainda empatar
(mesmo tipo), vence a **menor chave** em ordem lexicográfica. O resultado não depende da
ordem dos toques no payload.

Por que last-touch: a pergunta do time é "o que repetir". O último link antes do cadastro é o
que levou à conversão; toques antigos ainda aparecem na auditoria como `lost_to_newer`, então
dá para medir assistência sem mudar a origem oficial. Por que indicação no empate: indicação
é um convite pessoal, sinal mais forte de intenção que um post de campanha, e é o que costuma
gerar recompensa para quem convidou. A chave lexicográfica existe só para o resultado ser
determinístico.

### Orgânico nunca é silencioso

Sem vencedor, a origem é `{ "kind": "organic" }` com `organicReason` e `reason`:

| `organicReason`          | Significado                                                      |
|--------------------------|------------------------------------------------------------------|
| `no_attribution_payload` | O app não mandou payload (versão antiga, cadastro pela web…).    |
| `no_touches`             | Payload veio, nenhum link foi capturado.                         |
| `no_valid_touches`       | Houve toques, nenhum válido; cada um diz por quê em `touches[]`. |

## 4. Resposta do cadastro (auditoria)

A resposta lista **todos** os toques considerados, com status e motivo, a regra aplicada, a
janela e o desvio de relógio. Exemplo completo (gerado por `npm run example`) em
[`examples/resposta-cadastro.json`](examples/resposta-cadastro.json). Trecho:

```json
{
  "origin": { "kind": "campaign", "campaign": "verao-2026", "channel": "instagram" },
  "organicReason": null,
  "reason": "Origem campanha verao-2026 pelo toque #1: Toque válido mais recente entre 2 válidos.",
  "window": { "start": "2026-10-01T12:00:00.000Z", "end": "2026-10-08T12:00:00.000Z", "durationMs": 604800000 },
  "winner": { "index": 1, "key": "click:c-01HZY2" },
  "touches": [
    { "index": 0, "type": "referral", "status": "lost_to_newer", "reason": "Válido, mas há toque válido mais recente (#1, 2026-10-02T18:00:00.000Z)." },
    { "index": 1, "type": "campaign", "status": "won", "reason": "Toque válido mais recente entre 2 válidos." },
    { "index": 2, "type": null, "status": "invalid", "reason": "Link inválido: ct_campaign obrigatório para ct_type=campaign." },
    { "index": 3, "type": "campaign", "status": "outside_window", "reason": "Capturado em 2026-10-10T18:00:00.000Z, após o fim da janela (2026-10-08T12:00:00.000Z)." }
  ]
}
```

(Os toques no trecho foram resumidos; a resposta real traz também `url`, `key`, `campaign`,
`referrer`, `channel`, `clickId`, `capturedAtClient` e `capturedAt`.)

## API HTTP (`src/server.ts`)

Armazenamento em memória, só para demonstrar o contrato.

| Método e rota                        | Corpo                          | Resposta                                   |
|--------------------------------------|--------------------------------|--------------------------------------------|
| `POST /signups`                      | `{ userId, attribution? }`     | `201 { userId, attribution: <resultado> }` |
| `GET /signups/:userId/attribution`   | —                              | `200` mesmo resultado (auditoria)          |
| `PUT /signups/:userId/attribution`   | `{ attribution }`              | `200` reavaliado                           |

`signupAt` é o horário do servidor no `POST`. O `PUT` cobre o payload que chega depois do
cadastro (ex.: criador se cadastrou na web e depois abriu o app): o payload novo substitui o
anterior (ele é cumulativo), mas `signupAt` não muda, então links abertos depois do cadastro
saem como `after_signup` e não alteram a origem.

## Testes

`test/` cobre, entre outros:

- dois links diferentes antes do cadastro → o mais recente vence (`resolver.test.ts`);
- empate de horário campanha × indicação, nas duas ordens do payload, e empate entre dois do mesmo tipo;
- mesmo clique repetido → um toque `won`, o outro `duplicate` (no app e no backend);
- toque fora da janela, no limite exato da janela e 1 ms depois;
- toque posterior ao cadastro, inclusive quando é o mais recente;
- cadastro sem payload / sem toques / só com toques inválidos → orgânico com motivo;
- relógio do app adiantado;
- fluxo HTTP completo, do `AttributionRecorder` ao `GET` de auditoria.

## Limitações conhecidas

- Os horários vêm do app. A correção de desvio usa `clientSentAt`; um app adulterado ainda pode
  mentir, e o contrato não assina os links. Se isso importar, o redirecionador pode assinar
  `ct_click` (HMAC) e registrar o clique no servidor.
- Deduplicação por clique depende de `ct_click`. Sem ele, dois cliques reais no mesmo link
  estático contam como um (que é o comportamento desejado para "mesmo link reaberto").
- A API guarda em memória; em produção o resultado da resolução deve ser persistido junto do
  cadastro, como está, para a auditoria não mudar se a regra mudar depois.

## Uso de IA

Feito com IA (Claude Code, modelo Claude Opus 5.5), a partir do enunciado do desafio:

- desenho do contrato (parâmetros do link, dados gravados no app, payload, regra de vitória,
  janela e status);
- todo o código em `src/`, os testes em `test/`, o exemplo em `examples/` e este README.

O que eu revisei:

- Regra de vitória: conferi que vence o toque válido mais recente e que o desempate por
  horário idêntico (indicação antes de campanha, depois a menor chave) está coberto por
  testes nas duas ordens do payload.
- Janela: conferi que ela é contada a partir de `firstOpenAt` e que um toque exatamente no
  limite é aceito, enquanto 1 ms depois sai como `outside_window`.
- Relógio: revisei o cálculo de `clockOffsetMs` (recebido no servidor − `clientSentAt`) e como
  os horários do app são convertidos antes da comparação com o cadastro.
- Auditoria: verifiquei que cada status (`won`, `lost_to_newer`, `lost_tie_break`, `duplicate`,
  `invalid`, `before_first_open`, `after_signup`, `outside_window`) traz um motivo que explica
  a decisão.
- Deduplicação: verifiquei o comportamento com e sem `ct_click`. Com ele, cada clique real é
  um toque e o mesmo clique reentregue é `duplicate`; sem ele, reabrir o mesmo link estático
  conta como um único toque (não há como distinguir cliques reais nesse caso, limitação
  registrada acima).
- `PUT /signups/:userId/attribution`: conferi que preserva o `signupAt` original, então links
  abertos depois do cadastro não alteram a origem.
