/**
 * GET /api/pulse?chain=solana&secao=new
 *
 * Lançamentos recém-nascidos, direto da Pulse da Mobula — 50 tokens por
 * chamada, com os sinais vitais já calculados (compradores no 1º e no 5º
 * minuto, volume, liquidez, bundlers).
 *
 * Por que o campo `buyers_5min` só serve aqui: ele é uma janela relativa ao
 * INSTANTE DA CONSULTA. Num token de 4 minutos de vida, "compradores nos
 * últimos 5 minutos" é a vida inteira dele. No mesmo token com 30 minutos, o
 * campo descreve os minutos 25 a 30 — e não os primeiros. Por isso a lista
 * mostra a idade em cada linha, e o retrato de verdade (/api/first-minutes)
 * recorta por carimbo de tempo desde o nascimento.
 */
import { CHAINS, mobulaGet, orcamento, responder, tratarErro } from "./_mobula.js";

const SECOES = ["new", "bonding", "bonded"];

export default async function handler(req, res) {
  const chain = String(req.query.chain || "solana").toLowerCase();
  const secao = SECOES.includes(req.query.secao) ? req.query.secao : "new";
  const chainId = CHAINS[chain];
  if (!chainId) {
    return responder(res, 400, { erro: "rede_desconhecida", redes: Object.keys(CHAINS) });
  }

  try {
    const dados = await mobulaGet(
      "/api/2/pulse",
      { assetMode: "false", chainId, model: "default" },
      { ttlSegundos: 45 }
    );

    const itens = Array.isArray(dados?.[secao]?.data) ? dados[secao].data : [];
    const agora = Date.now();

    const tokens = itens.map((t) => {
      const nascimento = Date.parse(t.created_at || t.createdAt || "") || null;
      return {
        endereco: t.address,
        rede: chain,
        simbolo: t.symbol,
        nome: t.name,
        idadeMinutos: nascimento ? Math.round((agora - nascimento) / 60_000) : null,
        nascimento,
        // sinais vitais, como a Pulse entrega
        compradores1min: t.buyers_1min ?? null,
        compradores5min: t.buyers_5min ?? null,
        compras5min: t.buys_5min ?? null,
        volume5min: t.volume_5min ?? null,
        volume1h: t.volume_1h ?? null,
        liquidezUsd: t.liquidity ?? null,
        precoUsd: t.price ?? null,
        bundlersPct: t.bundlersHoldings ?? null,
        devPct: t.devHoldings ?? null,
        launchpad: t.factory ?? null,
        bonded: Boolean(t.bonded),
      };
    });

    tokens.sort((a, b) => (a.idadeMinutos ?? 1e9) - (b.idadeMinutos ?? 1e9));
    responder(res, 200, { rede: chain, secao, total: tokens.length, orcamento: orcamento(), tokens });
  } catch (erro) {
    tratarErro(res, erro);
  }
}
