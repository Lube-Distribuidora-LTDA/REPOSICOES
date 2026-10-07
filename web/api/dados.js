/**
 * /api/dados — entrega ao painel todo o conteúdo do sistema REPOSIÇÕES.
 *
 * O JSON do painel NÃO é montado aqui nem a cada visita: a carga (sync_reposicao.py)
 * o monta uma vez e o guarda em `reposicao.painel_cache` (ver db/05-painel-cache.sql).
 * Esta rota só lê essa linha. Se ela não existir (banco recém-criado), cai para
 * `reposicao.painel_dados()`, que monta na hora — mais lenta, mas nunca sem resposta.
 *
 * Cache da Vercel: a resposta fica 5 minutos "fresca" e, depois disso, ainda
 * pode ser entregue velha por até 24 h ENQUANTO a Vercel busca a nova por trás
 * (stale-while-revalidate). Quem abre o painel nunca espera o banco: espera, no
 * máximo, o CDN. O aquecedor (etl/aquecer_painel.py) chama esta rota de poucos em
 * poucos minutos para o CDN jamais ficar frio. O botão "Atualizar" do painel manda
 * ?atualizar=<hora>, que é outra URL e passa por cima do cache.
 */

const { consultar, faltandoVariaveis, responderErro } = require("./_db");

module.exports = async function handler(req, res) {
  const faltando = faltandoVariaveis();
  if (faltando.length) {
    res.status(500).json({
      erro: "configuracao_incompleta",
      mensagem:
        "Faltam variáveis de ambiente no projeto da Vercel: " + faltando.join(", ") +
        ". Cadastre em Settings › Environment Variables e publique de novo.",
    });
    return;
  }

  try {
    let r = await consultar("SELECT payload FROM reposicao.painel_cache WHERE id = 1", []);
    let corpo = r.rows[0] && r.rows[0].payload;
    let origem = "cache";
    if (!corpo) {
      r = await consultar("SELECT reposicao.painel_dados()::text AS payload", []);
      corpo = r.rows[0] && r.rows[0].payload;
      origem = "calculado";
    }
    if (!corpo) throw new Error("A consulta não devolveu dados.");

    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=86400, stale-if-error=86400");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("X-Painel-Origem", origem);
    res.status(200).send(corpo);
  } catch (e) {
    // erro nunca vai para o cache do CDN: senão um tropeço de 1 s ficaria 5 minutos na tela
    res.setHeader("Cache-Control", "no-store");
    responderErro(res, e, process.env.SUPABASE_DB_PORT);
  }
};
