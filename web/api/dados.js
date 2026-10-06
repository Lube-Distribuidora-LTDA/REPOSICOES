/**
 * /api/dados — entrega ao painel todo o conteúdo do sistema REPOSIÇÕES.
 *
 * Toda a consulta mora no banco, na função `reposicao.painel_dados()`
 * (ver db/02-views-e-funcao.sql). Aqui é só encanamento: chama a função e
 * devolve o JSON. A função devolve as LINHAS (item reposto x chamado ligado) e
 * os filtros e gráficos são calculados no navegador — o volume é de alguns
 * milhares de linhas, e os cinco filtros se cruzam com tudo na tela.
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
    const r = await consultar("SELECT reposicao.painel_dados() AS painel", []);
    const painel = r.rows[0] && r.rows[0].painel;
    if (!painel) throw new Error("A consulta não devolveu dados.");

    // O ETL roda algumas vezes ao dia; guardar 10 minutos no CDN faz com que só
    // o primeiro acesso de cada janela toque o banco. O botão "Atualizar" do
    // painel manda ?atualizar=<hora>, que é outra URL e ignora o cache.
    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).send(JSON.stringify(painel));
  } catch (e) {
    responderErro(res, e, process.env.SUPABASE_DB_PORT);
  }
};
