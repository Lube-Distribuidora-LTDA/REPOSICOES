-- Migração 04 — valor e unidades saem enxutos no JSON (o valor já é em centavos exatos desde a 03).
-- A definição vigente está em 02-views-e-funcao.sql.

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
