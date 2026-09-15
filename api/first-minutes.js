/**
 * GET /api/first-minutes?chain=solana&address=...
 *
 * O retrato dos primeiros minutos de vida de um token: quanto negociou no
 * minuto 1, 3, 5 e 15, quantos desses minutos não tiveram negociação NENHUMA,
 * e quanto o preço andou — tudo contado desde o nascimento do contrato, que a
 * própria Mobula informa em `createdAt`.
 *
 * Custa 1 crédito (details) + 5 créditos (ohlcv) por token.
 */
import {
  CHAINS,
  candlesDeUmMinuto,
  mobulaGet,
  orcamento,
  responder,
  retratoDosPrimeirosMinutos,
  tratarErro,
} from "./_mobula.js";

export default async function handler(req, res) {
  const chain = String(req.query.chain || "solana").toLowerCase();
  const address = String(req.query.address || "").trim();
  const minutos = Math.min(60, Math.max(5, Number(req.query.minutos || 20)));
  const chainId = CHAINS[chain];

  if (!chainId) return responder(res, 400, { erro: "rede_desconhecida", redes: Object.keys(CHAINS) });
  if (!address) return responder(res, 400, { erro: "endereco_obrigatorio" });

  try {
    const detalhes = await mobulaGet(
      "/api/2/token/details",
      { chainId, address },
      { ttlSegundos: 300 }
    );
    const t = detalhes?.data;
    if (!t) return responder(res, 404, { erro: "token_desconhecido_pela_mobula" });

    const nascimentoMs = Date.parse(t.createdAt || t.created_at || "");
    if (!Number.isFinite(nascimentoMs)) {
      // "não sei quando nasceu" é diferente de "nasceu e não negociou"
      return responder(res, 422, {
        erro: "sem_nascimento",
        detalhe: "a Mobula não tem a data de criação deste contrato, então não dá para contar 'desde o minuto zero'.",
      });
    }

    const velas = await candlesDeUmMinuto(chainId, address, nascimentoMs, minutos);
    const retrato = retratoDosPrimeirosMinutos(velas, nascimentoMs);

    responder(res, 200, {
      token: {
        endereco: address,
        rede: chain,
        simbolo: t.symbol,
        nome: t.name,
        nascimento: new Date(nascimentoMs).toISOString(),
        idadeMinutos: Math.round((Date.now() - nascimentoMs) / 60_000),
        launchpad: t.sourceMetadata?.name || t.source || null,
        liquidezUsd: t.liquidityUSD ?? null,
        holders: t.holdersCount ?? null,
        top10Pct: t.top10HoldingsPercentage ?? null,
        bundlersPct: t.bundlersHoldingsPercentage ?? null,
        devPct: t.devHoldingsPercentage ?? null,
      },
      retrato,
      orcamento: orcamento(),
    });
  } catch (erro) {
    tratarErro(res, erro);
  }
}
