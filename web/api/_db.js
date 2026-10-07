/**
 * _db.js — conexão com o DATA WAREHOUSE, compartilhada pelas rotas da API.
 *
 * A senha fica numa variável de ambiente da Vercel e nunca chega ao navegador.
 * As tabelas do Supabase estão com Row Level Security ligado e sem políticas,
 * então a chave pública não lê nada: só quem conecta com credencial de
 * servidor — o ETL e estas funções — enxerga os dados.
 *
 * Variáveis necessárias (Settings › Environment Variables):
 *   SUPABASE_DB_HOST      aws-0-sa-east-1.pooler.supabase.com
 *   SUPABASE_DB_PORT      5432   (session pooler; o 6543 conecta e trava neste projeto)
 *   SUPABASE_DB_NAME      postgres
 *   SUPABASE_DB_USER      postgres.ivcnotrynogaljrvvyes
 *   SUPABASE_DB_PASSWORD  a senha do projeto DATA WAREHOUSE
 *
 * POR QUE ESTA VERSÃO NÃO USA POOL (2026-10-07)
 * Medido no painel publicado: a primeira chamada do dia deu 504 depois de 60 s
 * e a seguinte levou 13 s — o tempo inteiro era a ABERTURA da conexão com o
 * pooler a frio, não a consulta (a consulta leva milissegundos). Um pool com
 * uma tentativa de 15 s e três repetições em série esperava cada tentativa
 * travada até o fim. Agora cada chamada abre a conexão em TENTATIVAS
 * ESCALONADAS: se a primeira ainda não respondeu em 4 s, sai outra em
 * paralelo, e depois outra; vence a que conectar primeiro e as demais são
 * encerradas. Numa função serverless, que atende uma consulta e dorme, uma
 * conexão por chamada custa o mesmo que manter um pool.
 */

const { Client } = require("pg");

/* O pooler do Supabase responde em IPv4. Em ambiente sem rota IPv6, tentar AAAA
   primeiro deixa a conexão pendurada até a função estourar o tempo. */
try { require("dns").setDefaultResultOrder("ipv4first"); } catch (_) { /* Node antigo */ }

/* ref do projeto DATA WAREHOUSE. A máquina do Júlio tem variáveis de ambiente
   apontando para OUTRO projeto (painel-icms-lube), e variável do sistema vence
   .env.local — sem esta conferência, um deploy mal configurado leria o banco
   errado sem avisar. */
const REF_ESPERADO = "ivcnotrynogaljrvvyes";
const OBRIGATORIAS = ["SUPABASE_DB_HOST", "SUPABASE_DB_USER", "SUPABASE_DB_PASSWORD"];

/* Quanto esperar antes de disparar outra tentativa em paralelo, quantas no máximo,
   e quanto cada uma pode levar sozinha antes de desistir. */
const ESCALONAR_MS = Number(process.env.DB_ESCALONAR_MS || 4000);
const MAX_TENTATIVAS = Number(process.env.DB_MAX_TENTATIVAS || 3);
const TEMPO_POR_TENTATIVA_MS = Number(process.env.DB_TEMPO_TENTATIVA_MS || 14000);

function configuracao() {
  const usuario = process.env.SUPABASE_DB_USER || "";
  if (!usuario.endsWith(REF_ESPERADO)) {
    throw new Error("SUPABASE_DB_USER aponta para outro projeto (esperado ..." + REF_ESPERADO + ")");
  }
  return {
    host: process.env.SUPABASE_DB_HOST || "aws-0-sa-east-1.pooler.supabase.com",
    port: Number(process.env.SUPABASE_DB_PORT || 5432),
    database: process.env.SUPABASE_DB_NAME || "postgres",
    user: usuario,
    password: process.env.SUPABASE_DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: TEMPO_POR_TENTATIVA_MS,
    statement_timeout: 40000,
    application_name: "painel-reposicoes",
  };
}

/**
 * Abre UMA conexão pelo caminho mais rápido: tentativas escalonadas, a primeira
 * que conectar vence. Rejeita só quando TODAS falharam.
 */
function conectar() {
  const cfg = configuracao();
  return new Promise((resolve, reject) => {
    let iniciadas = 0, falhas = 0, vencida = false, ultimoErro = null, timer = null;

    function proxima() {
      if (vencida || iniciadas >= MAX_TENTATIVAS) return;
      iniciadas++;
      const c = new Client(cfg);
      // um Client descartado pode emitir 'error' depois; sem este ouvinte isso derrubaria a função
      c.on("error", () => { /* já descartado ou em falha tratada abaixo */ });
      c.connect().then(
        () => {
          if (vencida) { c.end().catch(() => {}); return; }   // chegou tarde: encerra
          vencida = true;
          clearTimeout(timer);
          resolve(c);
        },
        (e) => {
          ultimoErro = e;
          falhas++;
          if (vencida) return;
          if (falhas >= MAX_TENTATIVAS) { clearTimeout(timer); reject(ultimoErro); return; }
          // falhou rápido (ex.: recusou): não espera o escalonamento, tenta de novo já
          if (iniciadas < MAX_TENTATIVAS) { clearTimeout(timer); proxima(); }
        }
      );
      if (iniciadas < MAX_TENTATIVAS) {
        clearTimeout(timer);
        timer = setTimeout(proxima, ESCALONAR_MS);
      }
    }
    proxima();
  });
}

function erroDeConexao(e) {
  return /timeout|ECONNRESET|ECONNREFUSED|terminated|ETIMEDOUT|EAUTHQUERY|Connection ended/i
    .test(String((e && e.message) || ""));
}

/**
 * Roda a consulta numa conexão nova e a encerra. Se a conexão morrer no meio da
 * consulta (pooler reciclou), refaz UMA vez, numa conexão nova.
 */
async function consultar(sql, valores) {
  let ultimoErro;
  for (let i = 0; i < 2; i++) {
    const c = await conectar();
    try {
      return await c.query(sql, valores);
    } catch (e) {
      ultimoErro = e;
      if (!erroDeConexao(e)) throw e;
    } finally {
      c.end().catch(() => {});
    }
  }
  throw ultimoErro;
}

function faltandoVariaveis() {
  return OBRIGATORIAS.filter((v) => !process.env[v]);
}

/** Aceita só AAAA-MM-DD. Qualquer outra coisa vira null. */
function dataOuNulo(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

function responderErro(res, e, porta) {
  console.error("Falha ao consultar o Supabase:", e);
  res.status(502).json({
    erro: "falha_no_banco",
    mensagem:
      "Não consegui ler o DATA WAREHOUSE. Se for o primeiro acesso do dia, o pooler pode " +
      "estar acordando — tente de novo. Persistindo, confira as variáveis de ambiente e a porta " +
      (porta || 5432) + ".",
    detalhe: String(e && e.message ? e.message : e),
  });
}

module.exports = { consultar, conectar, faltandoVariaveis, dataOuNulo, responderErro };
