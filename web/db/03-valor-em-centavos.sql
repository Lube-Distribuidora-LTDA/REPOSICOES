-- Migração 03 — repartição em centavos exatos. A definição está em 02-views-e-funcao.sql (vw_linhas);
-- este arquivo existe só para registrar a ordem em que foi aplicada no DATA WAREHOUSE (2026-10-06).

-- ---------------------------------------------------------------------------
-- vw_linhas — o que o painel soma
--
-- Grão: item da reposição x chamado ligado a ele (ou só o item, se não houver
-- chamado). É o mesmo grão da planilha consolidada, mas com o dinheiro
-- ADITIVO — qualquer filtro que se aplique a estas linhas soma certo:
--
--   valor  = o total do pedido (PCPEDC.VLTOTAL), repartido entre os itens na
--            proporção de qt x preço e, dentro do item, em partes iguais entre
--            os chamados ligados a ele. A repartição é feita em CENTAVOS
--            EXATOS (maior resto): cada linha vale um número de centavos
--            inteiro e a soma das linhas de um pedido é, ao centavo, o total
--            do pedido. Assim a tela e a planilha exportada fecham igual.
--   qt_rep = unidades repostas, repartidas do mesmo jeito, em unidades inteiras
--            (nenhuma quantidade do WinThor é fracionada).
--
-- Para contar pedidos ou itens, conte `numped` / (numped, codprod) DISTINTOS.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS reposicao.vw_linhas;
CREATE VIEW reposicao.vw_linhas AS
WITH itens AS (
    SELECT i.*,
           SUM(i.valor_item) OVER (PARTITION BY i.numped) AS soma_itens,
           COUNT(*)          OVER (PARTITION BY i.numped) AS n_itens
    FROM reposicao.fato_item i
),
lig AS (
    SELECT it.*, v.nummanif, v.numseq, v.vinculo, v.qtreclamada,
           COUNT(*)     OVER (PARTITION BY it.numped, it.codprod)                      AS n_links,
           ROW_NUMBER() OVER (PARTITION BY it.numped, it.codprod ORDER BY v.nummanif) AS rn_link
    FROM itens it
    LEFT JOIN reposicao.vw_vinculo v ON v.numped = it.numped AND v.codprod = it.codprod
),
ideal AS (
    SELECT l.*,
           (CASE WHEN l.soma_itens > 0
                 THEN l.valor_pedido * l.valor_item / l.soma_itens
                 ELSE l.valor_pedido / l.n_itens END) / l.n_links AS v_ideal
    FROM lig l
),
centavos AS (
    SELECT d.*,
           FLOOR(d.v_ideal * 100) / 100                         AS piso,
           d.v_ideal * 100 - FLOOR(d.v_ideal * 100)             AS resto
    FROM ideal d
),
dist AS (
    SELECT c.*,
           ROUND((c.valor_pedido - SUM(c.piso) OVER (PARTITION BY c.numped)) * 100)::int AS sobra,
           ROW_NUMBER() OVER (PARTITION BY c.numped
                              ORDER BY c.resto DESC, c.codprod, c.nummanif NULLS FIRST)  AS pos
    FROM centavos c
)
SELECT
    d.numped, d.codprod, d.data, d.codfilial, d.numnota,
    d.codcli, d.cliente, d.codemitente, d.emitente,
    d.descricao, d.codfornec, d.fornecedor,
    d.qt, d.valor_item, d.valor_pedido, d.nfs_referencia,
    d.nummanif, d.vinculo, d.qtreclamada,
    c.dtab, c.codassunto, c.assunto, c.situacao,
    COALESCE(c.codmotorista, ci.codmotorista) AS codmotorista,
    COALESCE(c.motorista,    ci.motorista)    AS motorista,
    d.piso + CASE WHEN d.pos <= d.sobra THEN 0.01 ELSE 0 END AS valor,
    TRUNC(d.qt / d.n_links)
      + CASE WHEN d.rn_link <= d.qt - TRUNC(d.qt / d.n_links) * d.n_links THEN 1 ELSE 0 END AS qt_rep
FROM dist d
LEFT JOIN reposicao.fato_chamado c
       ON c.nummanif = d.nummanif AND c.numseq = d.numseq
LEFT JOIN reposicao.fato_chamado_item ci
       ON ci.nummanif = d.nummanif AND ci.numseq = d.numseq AND ci.codprod = d.codprod;

