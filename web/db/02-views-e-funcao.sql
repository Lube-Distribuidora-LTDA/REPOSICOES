-- ===========================================================================
-- REPOSIÇÕES — a regra de vínculo, as linhas do painel e a função que as entrega
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- vw_vinculo — qual chamado causou cada item reposto
--
-- Uma reposição cita a NF original nas observações ("PEND. REF. A NF 1504784").
-- O chamado (rotina 8353) guarda a mesma NF. A regra, em dois degraus:
--
--   1. 'item' — chamado da MESMA FILIAL, da mesma NF e que reclama o MESMO PRODUTO
--               que foi reposto;
--   2. 'nf'   — se o item não achou chamado pelo produto, qualquer chamado da mesma
--               filial e NF. Cobre os motivos que não são de mercadoria (cliente
--               fechado, não deu tempo, sem ninguém para receber...), cujo
--               chamado não lista o produto reposto.
--
-- Janela de datas: o chamado foi aberto até 90 dias ANTES da reposição ou até
-- 7 dias DEPOIS dela (às vezes o pedido é lançado antes do chamado). Fora disso
-- é outro assunto da mesma NF — a planilha consolidada ligava um chamado aberto
-- 145 dias depois da reposição só porque a NF coincidia.
--
-- Esta regra reproduz 2.073 das 2.127 linhas da planilha consolidada (97,5%).
-- As diferenças estão listadas, uma a uma, no README do repositório.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW reposicao.vw_vinculo AS
WITH por_item AS (
    SELECT DISTINCT i.numped, i.codprod, c.nummanif, c.numseq, ci.qtreclamada
    FROM reposicao.fato_item i
    JOIN reposicao.fato_chamado c
      ON c.codfilial = i.codfilial
     AND c.dtab::date BETWEEN i.data - 90 AND i.data + 7
    JOIN reposicao.fato_chamado_item ci
      ON ci.nummanif = c.nummanif
     AND ci.numseq   = c.numseq
     AND ci.codprod  = i.codprod
     AND COALESCE(ci.nf_item, c.nf_capa) = ANY (i.nfs_referencia)
),
por_nf AS (
    SELECT DISTINCT i.numped, i.codprod, c.nummanif, c.numseq, NULL::numeric AS qtreclamada
    FROM reposicao.fato_item i
    JOIN reposicao.fato_chamado c
      ON c.codfilial = i.codfilial
     AND c.nf_capa   = ANY (i.nfs_referencia)
     AND c.dtab::date BETWEEN i.data - 90 AND i.data + 7
    WHERE NOT EXISTS (SELECT 1 FROM por_item x WHERE x.numped = i.numped AND x.codprod = i.codprod)
)
SELECT numped, codprod, nummanif, numseq, qtreclamada, 'item'::text AS vinculo FROM por_item
UNION ALL
SELECT numped, codprod, nummanif, numseq, qtreclamada, 'nf'::text   AS vinculo FROM por_nf;

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

-- ---------------------------------------------------------------------------
-- painel_dados() — o painel inteiro num JSON só
--
-- Exceção consciente ao padrão da casa (a função devolve LINHAS, não totais):
-- o volume é pequeno (alguns milhares de linhas por ano) e os cinco filtros do
-- painel se cruzam com todos os gráficos — filtrar no navegador é instantâneo e
-- evita uma função de banco com dez parâmetros. Textos repetidos (cliente,
-- produto, motivo, motorista...) saem num dicionário e a linha guarda o índice.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reposicao.painel_dados()
RETURNS json
LANGUAGE sql
STABLE
AS $$
WITH l AS (SELECT * FROM reposicao.vw_linhas),
cli AS (SELECT codcli, MAX(cliente) AS nome,
               ROW_NUMBER() OVER (ORDER BY codcli) - 1 AS ix FROM l GROUP BY codcli),
emi AS (SELECT codemitente, MAX(emitente) AS nome,
               ROW_NUMBER() OVER (ORDER BY codemitente) - 1 AS ix FROM l GROUP BY codemitente),
frn AS (SELECT codfornec, MAX(fornecedor) AS nome,
               ROW_NUMBER() OVER (ORDER BY codfornec) - 1 AS ix FROM l GROUP BY codfornec),
prd AS (SELECT l.codprod, MAX(l.descricao) AS nome, MAX(frn.ix) AS ix_fornecedor,
               ROW_NUMBER() OVER (ORDER BY l.codprod) - 1 AS ix
        FROM l LEFT JOIN frn ON frn.codfornec = l.codfornec GROUP BY l.codprod),
mtv AS (SELECT codassunto, MAX(assunto) AS nome,
               ROW_NUMBER() OVER (ORDER BY MAX(assunto), codassunto) - 1 AS ix
        FROM l WHERE codassunto IS NOT NULL GROUP BY codassunto),
mot AS (SELECT codmotorista, MAX(motorista) AS nome,
               ROW_NUMBER() OVER (ORDER BY MAX(motorista), codmotorista) - 1 AS ix
        FROM l WHERE codmotorista IS NOT NULL GROUP BY codmotorista)
SELECT json_build_object(
    'gerado_em', now(),
    'carga', (SELECT MAX(executado_em) FROM reposicao.controle_carga
              WHERE consulta = 'reposicao_item' AND status = 'OK'),
    'dims', json_build_object(
        'clientes',     (SELECT json_agg(json_build_array(codcli, nome) ORDER BY ix) FROM cli),
        'emitentes',    (SELECT json_agg(json_build_array(codemitente, nome) ORDER BY ix) FROM emi),
        'fornecedores', (SELECT json_agg(json_build_array(codfornec, nome) ORDER BY ix) FROM frn),
        'produtos',     (SELECT json_agg(json_build_array(codprod, nome, ix_fornecedor) ORDER BY ix) FROM prd),
        'motivos',      (SELECT json_agg(json_build_array(codassunto, nome) ORDER BY ix) FROM mtv),
        'motoristas',   (SELECT json_agg(json_build_array(codmotorista, nome) ORDER BY ix) FROM mot)
    ),
    'linhas', (
        SELECT json_agg(jsonb_strip_nulls(jsonb_build_object(
            'd',  l.data,
            'f',  l.codfilial,
            'pd', l.numped,
            'nf', l.numnota,
            'c',  cli.ix,
            'e',  emi.ix,
            'p',  prd.ix,
            'q',  l.qt_rep::int,
            'v',  ROUND(l.valor, 2),
            'ch', l.nummanif,
            'm',  mtv.ix,
            'mo', mot.ix,
            'vi', CASE l.vinculo WHEN 'item' THEN 1 WHEN 'nf' THEN 2 END,
            'qr', l.qtreclamada,
            'da', to_char(l.dtab, 'YYYY-MM-DD"T"HH24:MI'),
            'nr', l.nfs_referencia[1]
        )) ORDER BY l.data, l.numped, l.codprod, l.nummanif)
        FROM l
        LEFT JOIN cli ON cli.codcli = l.codcli
        LEFT JOIN emi ON emi.codemitente = l.codemitente
        JOIN prd ON prd.codprod = l.codprod
        LEFT JOIN mtv ON mtv.codassunto = l.codassunto
        LEFT JOIN mot ON mot.codmotorista = l.codmotorista
    )
);
$$;
