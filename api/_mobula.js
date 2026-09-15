/**
 * Cliente da Mobula API com cache e teto de créditos.
 *
 * Duas coisas aqui não são detalhe, e as duas custaram caro para descobrir:
 *
 * 1. O parâmetro `from` do OHLCV é IGNORADO se você não mandar `to` junto. A
 *    API devolve os candles mais recentes como se nada tivesse sido pedido —
 *    então um estudo "desde o lançamento" mede silenciosamente a janela errada
 *    e você nunca vê um erro.
 * 2. O plano gratuito é 10.000 créditos/mês a 1 requisição por segundo. Sem
 *    freio, um loop de análise queima a cota do mês em horas e passa a receber
 *    429 — que, se tratado como "sem dado", vira conclusão errada com cara de
 *    medida.
 */

const BASE = "https://api.mobula.io";

// Custo em créditos por endpoint, do https://docs.mobula.io/pricing
export const CUSTO = {
  "/api/2/token/ohlcv-history": 5,
  "/api/2/token/details": 1,
  "/api/2/pulse": 5,
};

// Como a Mobula nomeia cada rede.
export const CHAINS = {
  solana: "solana:solana",
  ethereum: "evm:1",
  bnb: "evm:56",
  base: "evm:8453",
  polygon: "evm:137",
  arbitrum: "evm:42161",
  // Robinhood Chain (L2 sobre Arbitrum). Nao aparece na Pulse, mas o retrato
  // dos primeiros minutos funciona - e e de la que vem o exemplo do README.
  robinhood: "evm:4663",
};

const TETO_DIARIO = Number(process.env.MOBULA_DAILY_BUDGET || 400);

// Estado por instância. Serverless recicla instâncias, então isto é um freio
// de melhor esforço, não uma contabilidade exata — e está escrito assim de
// propósito: prometer precisão aqui seria a mesma mentira que este projeto
// existe para evitar.
const gasto = { dia: diaAtual(), creditos: 0 };
const cache = new Map();

function diaAtual() {
  return new Date().toISOString().slice(0, 10);
}

export function orcamento() {
  if (gasto.dia !== diaAtual()) {
    gasto.dia = diaAtual();
    gasto.creditos = 0;
  }
  return { gastos: gasto.creditos, teto: TETO_DIARIO, restam: Math.max(0, TETO_DIARIO - gasto.creditos) };
}

export class SemCota extends Error {}
export class LimiteDeTaxa extends Error {}

/**
 * GET na Mobula, com cache e desconto de créditos.
 * Lança SemCota ou LimiteDeTaxa em vez de devolver vazio — "não consegui ler"
 * nunca pode virar "não tem".
 */
export async function mobulaGet(path, params, { ttlSegundos = 60 } = {}) {
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  const agora = Date.now();

  const emCache = cache.get(url);
  if (emCache && emCache.expiraEm > agora) return emCache.dados;

  const custo = CUSTO[path] ?? 1;
  const conta = orcamento();
  if (conta.restam < custo) {
    throw new SemCota(
      `teto diário de ${TETO_DIARIO} créditos atingido (${conta.gastos} usados). ` +
        `Rode sua própria instância com sua chave: https://github.com/joedsonalves/minute-zero`
    );
  }

  const headers = { Accept: "application/json" };
  if (process.env.MOBULA_API_KEY) headers.Authorization = process.env.MOBULA_API_KEY;

  // 1 requisicao por segundo no plano gratuito: uma pagina que faz duas
  // chamadas seguidas (details + ohlcv) bate na parede sozinha. Espera e tenta
  // de novo algumas vezes antes de desistir - e quando desiste, diz que
  // DESISTIU, em vez de devolver vazio.
  let resposta = null;
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    if (tentativa > 0) await new Promise((r) => setTimeout(r, 1100 * tentativa));
    resposta = await fetch(url, { headers });
    if (resposta.status !== 429 && resposta.status !== 503) break;
  }
  gasto.creditos += custo;

  if (resposta.status === 429 || resposta.status === 503) {
    throw new LimiteDeTaxa(
      "a Mobula recusou por limite de taxa depois de 3 tentativas (plano gratuito: 1 req/s)"
    );
  }
  if (!resposta.ok) {
    throw new Error(`Mobula respondeu ${resposta.status} em ${path}`);
  }

  const dados = await resposta.json();
  cache.set(url, { dados, expiraEm: agora + ttlSegundos * 1000 });
  return dados;
}

/** Candles de 1 minuto a partir de um instante — com `to` junto, sempre. */
export async function candlesDeUmMinuto(chainId, address, desdeMs, minutos) {
  const ateMs = desdeMs + minutos * 60_000;
  const dados = await mobulaGet(
    "/api/2/token/ohlcv-history",
    { address, chainId, period: "1m", usd: "true", amount: minutos + 5, from: desdeMs, to: ateMs },
    { ttlSegundos: 600 } // candle de um minuto passado não muda mais
  );
  const itens = Array.isArray(dados?.data) ? dados.data : [];
  return itens
    .map((c) => ({
      time: Number(c.t ?? c.time),
      close: c.c ?? c.close,
      volume: c.v ?? c.volume,
    }))
    .filter((c) => Number.isFinite(c.time))
    .sort((a, b) => a.time - b.time);
}

/**
 * O retrato dos primeiros minutos.
 *
 * **As janelas são recortadas pelo CARIMBO DE TEMPO de cada vela, nunca pela
 * posição dela na lista.** A Mobula devolve só os minutos que tiveram
 * negociação — não existe vela de minuto parado. Fatiar `velas.slice(0, 5)`
 * chamaria de "os cinco primeiros minutos" um pedaço que pode cobrir meia hora
 * num token parado, e faria "minutos mudos" dar sempre zero, que é justamente
 * a métrica mais barata para separar vivo de morto.
 */
export function retratoDosPrimeirosMinutos(velas, nascimentoMs, janelas = [1, 3, 5, 15]) {
  if (!velas.length) return { semCandle: true, velas: [] };

  const base = velas[0].close;
  const retrato = { nVelas: velas.length, precoInicialUsd: base, janelas: {} };

  for (const janela of janelas) {
    const limite = nascimentoMs + janela * 60_000;
    const pedaco = velas.filter((v) => v.time < limite);
    const minutosNegociados = new Set(
      pedaco.filter((v) => (v.volume || 0) > 0).map((v) => Math.floor((v.time - nascimentoMs) / 60_000))
    );
    const fechamentos = pedaco.map((v) => v.close).filter(Boolean);
    retrato.janelas[janela] = {
      volumeUsd: pedaco.reduce((s, v) => s + (v.volume || 0), 0),
      minutosNegociados: minutosNegociados.size,
      minutosMudos: Math.max(0, janela - minutosNegociados.size),
      multiplo: fechamentos.length && base ? Math.max(...fechamentos) / base : null,
    };
  }

  // as velas cruas vão junto: sem elas, qualquer conserto de conta obrigaria
  // a gastar crédito de novo só para recalcular
  retrato.velas = velas.slice(0, 20).map((v) => ({
    minuto: Math.floor((v.time - nascimentoMs) / 60_000),
    close: v.close,
    volume: v.volume || 0,
  }));
  return retrato;
}

export function responder(res, status, corpo) {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "public, max-age=30");
  res.status(status).send(JSON.stringify(corpo));
}

export function tratarErro(res, erro) {
  if (erro instanceof SemCota) return responder(res, 429, { erro: "sem_cota", detalhe: erro.message });
  if (erro instanceof LimiteDeTaxa)
    return responder(res, 429, { erro: "limite_de_taxa", detalhe: erro.message });
  return responder(res, 502, { erro: "falha_na_mobula", detalhe: String(erro.message || erro) });
}
