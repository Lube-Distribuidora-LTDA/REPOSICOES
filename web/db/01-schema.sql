-- ===========================================================================
-- REPOSIÇÕES — schema `reposicao` no projeto DATA WAREHOUSE (Supabase)
--
-- Origem no WinThor:
--   rotina 8352 "Pedido de Reposição"       -> PCPEDC / PCPEDI (CODUSUR = 999, POSICAO = 'F')
--   rotina 8353 "Relatório Geral de Chamados" -> PCMANIF / PCMANIFPROD / PCMANASSUNTO
--
-- Regras da casa (skill data-warehouse): schema próprio, nada no `public`,
-- RLS ligado e sem políticas (a chave pública não lê nem escreve nada), cada
-- tabela com um único dono — o ETL de REPOSIÇÕES. Este sistema não escreve em
-- nenhum outro schema e não lê o fato de nenhum outro sistema.
-- ===========================================================================

CREATE SCHEMA IF NOT EXISTS reposicao;

-- ---------------------------------------------------------------------------
-- Controle de carga: é ele, e não o log na tela, que responde "a carga entrou?"
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reposicao.controle_carga (
    id                bigserial PRIMARY KEY,
    consulta          text NOT NULL,
    tabela_destino    text,
    status            text NOT NULL,
    linhas            integer,
    linhas_esperadas  integer,
    segundos          numeric,
    mensagem          text,
    executado_em      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_reposicao_carga_data ON reposicao.controle_carga (executado_em DESC);

-- ---------------------------------------------------------------------------
-- Fato: item do pedido de reposição (rotina 8352)
-- Grão: pedido x produto. A planilha consolidada repetia o total do PEDIDO em
-- cada item (e de novo em cada chamado ligado ao item) — somar aquela coluna
-- inflava o total em 44%. Aqui o total do pedido fica guardado uma vez por
-- item (`valor_pedido`) e a view vw_linhas o reparte entre os itens.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reposicao.fato_item (
    numped          bigint        NOT NULL,   -- PCPEDC.NUMPED (999xxxxxx)
    codprod         integer       NOT NULL,
    data            date          NOT NULL,   -- PCPEDC.DATA
    codfilial       smallint      NOT NULL,
    numnota         bigint,                   -- NF da reposição (PCPEDC.NUMNOTA)
    codcli          integer,
    cliente         text,
    codemitente     integer,
    emitente        text,                     -- quem lançou a reposição (PCEMPR)
    descricao       text,                     -- PCPRODUT.DESCRICAO
    codfornec       integer,
    fornecedor      text,
    qt              numeric(14,3) NOT NULL,   -- unidades repostas
    pvenda          numeric(14,4),
    valor_item      numeric(14,2) NOT NULL,   -- qt x pvenda
    valor_pedido    numeric(14,2) NOT NULL,   -- PCPEDC.VLTOTAL (repetido nos itens do pedido)
    obs             text,
    obs1            text,
    obs2            text,
    nfs_referencia  bigint[]      NOT NULL DEFAULT '{}',  -- NFs citadas nas observações ("PEND. REF. A NF ...")
    PRIMARY KEY (numped, codprod)
);
CREATE INDEX IF NOT EXISTS ix_reposicao_item_data ON reposicao.fato_item (data);
CREATE INDEX IF NOT EXISTS ix_reposicao_item_nfs  ON reposicao.fato_item USING gin (nfs_referencia);

-- ---------------------------------------------------------------------------
-- Fato: chamado (rotina 8353) — capa
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reposicao.fato_chamado (
    nummanif        bigint        NOT NULL,   -- "Nº CHAMADO"
    numseq          integer       NOT NULL,
    dtab            timestamp     NOT NULL,   -- data/hora de abertura
    codfilial       smallint,
    codcli          integer,
    cliente         text,
    codassunto      integer,
    assunto         text,                     -- o MOTIVO do chamado
    situacao        text,
    nf_capa         bigint,                   -- PCMANIF.NUMNOTA
    codmotorista    integer,
    motorista       text,                     -- PCEMPR.NOME
    PRIMARY KEY (nummanif, numseq)
);
CREATE INDEX IF NOT EXISTS ix_reposicao_chamado_nf ON reposicao.fato_chamado (codfilial, nf_capa);

-- ---------------------------------------------------------------------------
-- Fato: produtos reclamados no chamado (PCMANIFPROD)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reposicao.fato_chamado_item (
    nummanif        bigint        NOT NULL,
    numseq          integer       NOT NULL,
    codprod         integer       NOT NULL,
    qtreclamada     numeric(14,3),
    nf_item         bigint,
    codmotorista    integer,
    motorista       text,
    PRIMARY KEY (nummanif, numseq, codprod)
);
CREATE INDEX IF NOT EXISTS ix_reposicao_chamado_item_nf ON reposicao.fato_chamado_item (nf_item, codprod);

ALTER TABLE reposicao.controle_carga      ENABLE ROW LEVEL SECURITY;
ALTER TABLE reposicao.fato_item           ENABLE ROW LEVEL SECURITY;
ALTER TABLE reposicao.fato_chamado        ENABLE ROW LEVEL SECURITY;
ALTER TABLE reposicao.fato_chamado_item   ENABLE ROW LEVEL SECURITY;
