-- ===========================================================================
-- 05 — resposta do painel pronta no banco (cache)
--
-- Por que existe. Medido em 2026-10-07 no painel publicado: a primeira chamada
-- do dia à /api/dados deu 504 depois de 60 s, a segunda levou 13 s e a terceira
-- 0,16 s. O tempo se perdia abrindo a conexão com o pooler a frio e, de quebra,
-- montando o JSON inteiro (painel_dados(), ~0,7 s com o banco calmo) a cada
-- visita. Agora a CARGA monta o JSON uma vez e a API só lê essa linha.
--
-- Quem escreve: reposicao.atualizar_painel_cache(), chamada pelo
-- sync_reposicao.py no fim de cada carga. Se a linha não existir (banco novo),
-- a API cai para painel_dados() — mais lenta, mas nunca fica sem resposta.
-- Mudou painel_dados()? Rode `SELECT reposicao.atualizar_painel_cache();`.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS reposicao.painel_cache (
    id         smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),   -- uma linha só
    gerado_em  timestamptz NOT NULL DEFAULT now(),
    carga      timestamptz,                                         -- da carga que originou o JSON
    payload    text        NOT NULL
);
ALTER TABLE reposicao.painel_cache ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION reposicao.atualizar_painel_cache()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    v_payload text;
    v_carga   timestamptz;
BEGIN
    v_payload := reposicao.painel_dados()::text;
    SELECT MAX(executado_em) INTO v_carga
      FROM reposicao.controle_carga
     WHERE consulta = 'reposicao_item' AND status = 'OK';
    INSERT INTO reposicao.painel_cache (id, gerado_em, carga, payload)
    VALUES (1, now(), v_carga, v_payload)
    ON CONFLICT (id) DO UPDATE
       SET gerado_em = EXCLUDED.gerado_em, carga = EXCLUDED.carga, payload = EXCLUDED.payload;
    RETURN length(v_payload);
END;
$$;
