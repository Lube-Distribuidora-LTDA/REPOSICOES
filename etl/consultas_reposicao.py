#!/usr/bin/env python3
"""
consultas_reposicao.py — catalogo de consultas do sistema REPOSICOES.

Duas rotinas do WinThor alimentam este sistema:

    8352  Pedido de Reposicao          -> pedido de venda do vendedor 999
                                          ("REPOSICAO"), ja faturado (POSICAO = 'F')
    8353  Relatorio Geral de Chamados  -> manifestacoes (SAC) de PCMANIF, com os
                                          produtos reclamados em PCMANIFPROD

Tres consultas, uma por tabela de destino, todas no schema `reposicao`:

    reposicao_item   -> reposicao.fato_item          (pedido x produto)
    chamado          -> reposicao.fato_chamado       (capa do chamado)
    chamado_item     -> reposicao.fato_chamado_item  (produto reclamado)

O VINCULO entre uma reposicao e o chamado que a causou NAO e feito aqui: ele
mora no banco (view reposicao.vw_vinculo), de proposito. A regra e uma decisao
de negocio, e se ela mudar, muda-se uma view — nao se roda carga de novo.

Recortes (opcionais, no ENV):
    REPOSICAO_DATA_INICIAL=2025-01-01   primeira data de reposicao carregada
    REPOSICAO_FILIAIS=                  vazio = todas; ou "1,7,12"
"""

from __future__ import annotations

import os
import re
from datetime import date, datetime, timedelta
from typing import Any

from bi_comum import Consulta, inteiro, texto

# Vendedor "REPOSICAO": todo pedido de reposicao e lancado com este codigo.
CODUSUR_REPOSICAO = 999

# Chamados abertos ate N dias ANTES do inicio das reposicoes tambem entram: uma
# reposicao de 2 de janeiro pode ser de um chamado aberto em dezembro. A regra
# de vinculo (view) aceita chamado ate 90 dias antes da reposicao.
FOLGA_CHAMADO_DIAS = 120


def _data_inicial() -> date:
    bruto = (os.environ.get("REPOSICAO_DATA_INICIAL") or "2025-01-01").strip()
    return datetime.strptime(bruto, "%Y-%m-%d").date()


def _filiais() -> list[int]:
    bruto = (os.environ.get("REPOSICAO_FILIAIS") or "").strip()
    return [int(x) for x in bruto.split(",") if x.strip()]


def _clausula_filial(coluna: str) -> str:
    fil = _filiais()
    # Valores vem de int(): nao ha texto livre indo para o SQL.
    return f"AND {coluna} IN ({', '.join(str(f) for f in fil)})" if fil else ""


# ---------------------------------------------------------------------------
# NF de referencia: "PEND. REF. A NF 1504784"
# ---------------------------------------------------------------------------
# O operador escreve a NF que gerou a reposicao nas observacoes, e escreve de
# varias formas: "PEND. REF. A NF 4507", "PEND REF A NF", "PEND. RE.F  ANF 1540436",
# "PEN. REF. A NF". Desde setembro o NUMERO DO CHAMADO passa a ir em OBS e a NF
# em OBS1 — por isso as tres observacoes sao lidas, na ordem OBS, OBS1, OBS2.
# A planilha consolidada deixou 19 linhas sem NF de referencia (3 pedidos com
# a grafia "ANF" ela nao reconhecia); aqui elas sao reconhecidas. Mais de uma NF por pedido e normal
# ("NF 1562528 E 1562526"), entao guardamos TODAS, na ordem em que aparecem.
_RE_NF = re.compile(r"N\.?F\.?\s*:?\s*(\d{3,9})", re.IGNORECASE)
_RE_NF_SEGUINTE = re.compile(r"\s*(?:E|,|/)\s*(\d{4,9})\b", re.IGNORECASE)


def nfs_citadas(*observacoes: str | None) -> list[int]:
    achadas: list[int] = []
    for obs in observacoes:
        if not obs:
            continue
        for m in _RE_NF.finditer(obs):
            numeros = [int(m.group(1))]
            pos = m.end()
            while True:                       # "NF 1562528 E 1562526"
                seg = _RE_NF_SEGUINTE.match(obs, pos)
                if not seg:
                    break
                numeros.append(int(seg.group(1)))
                pos = seg.end()
            for n in numeros:
                if n not in achadas:
                    achadas.append(n)
    return achadas


# ---------------------------------------------------------------------------
# 1. Itens da reposicao (rotina 8352)
# ---------------------------------------------------------------------------
SQL_REPOSICAO_ITEM = """
SELECT
    p.numped,
    i.codprod,
    TRUNC(p.data)                       AS data,
    p.codfilial,
    p.numnota,
    p.codcli,
    c.cliente,
    p.codemitente,
    e.nome                              AS emitente,
    pr.descricao,
    pr.codfornec,
    f.fornecedor,
    i.qt,
    i.pvenda,
    ROUND(i.qt * i.pvenda, 2)           AS valor_item,
    p.vltotal                           AS valor_pedido,
    p.obs,
    p.obs1,
    p.obs2
FROM pcpedc p
JOIN pcpedi    i  ON i.numped    = p.numped
JOIN pcprodut  pr ON pr.codprod  = i.codprod
LEFT JOIN pcfornec f ON f.codfornec = pr.codfornec
LEFT JOIN pcclient c ON c.codcli    = p.codcli
LEFT JOIN pcempr   e ON e.matricula = p.codemitente
WHERE p.codusur  = {codusur}
  AND p.posicao  = 'F'                       -- faturado; cancelado ('C') fica de fora
  AND p.data    >= :ini
  {filial}
""".format(codusur=CODUSUR_REPOSICAO, filial=_clausula_filial("p.codfilial"))


def _mapear_item(r: dict[str, Any]) -> tuple:
    nfs = nfs_citadas(r["obs"], r["obs1"], r["obs2"])
    return (
        inteiro(r["numped"]), inteiro(r["codprod"]), r["data"].date() if isinstance(r["data"], datetime) else r["data"],
        inteiro(r["codfilial"]), inteiro(r["numnota"]),
        inteiro(r["codcli"]), texto(r["cliente"]),
        inteiro(r["codemitente"]), texto(r["emitente"]),
        texto(r["descricao"]), inteiro(r["codfornec"]), texto(r["fornecedor"]),
        r["qt"], r["pvenda"], r["valor_item"] or 0, r["valor_pedido"] or 0,
        texto(r["obs"]), texto(r["obs1"]), texto(r["obs2"]),
        nfs,                                   # list -> array do Postgres (psycopg2 adapta sozinho)
    )


COLUNAS_ITEM = (
    "numped", "codprod", "data", "codfilial", "numnota", "codcli", "cliente",
    "codemitente", "emitente", "descricao", "codfornec", "fornecedor",
    "qt", "pvenda", "valor_item", "valor_pedido", "obs", "obs1", "obs2",
    "nfs_referencia",
)

# ---------------------------------------------------------------------------
# 2. Chamados — capa (rotina 8353)
# ---------------------------------------------------------------------------
SQL_CHAMADO = """
SELECT
    m.nummanif,
    m.numseq,
    m.dtab,
    TO_NUMBER(m.codfilial)              AS codfilial,
    m.codcli,
    c.cliente,
    m.codassunto,
    a.assunto,
    m.situacao,
    m.numnota                           AS nf_capa,
    m.codmotorista,
    e.nome                              AS motorista
FROM pcmanif m
LEFT JOIN pcmanassunto a ON a.codassunto = m.codassunto
LEFT JOIN pcclient     c ON c.codcli     = m.codcli
LEFT JOIN pcempr       e ON e.matricula  = m.codmotorista
WHERE m.dtab >= :ini_chamado
  {filial}
""".format(filial=_clausula_filial("TO_NUMBER(m.codfilial)"))


def _mapear_chamado(r: dict[str, Any]) -> tuple:
    return (
        inteiro(r["nummanif"]), inteiro(r["numseq"]), r["dtab"], inteiro(r["codfilial"]),
        inteiro(r["codcli"]), texto(r["cliente"]),
        inteiro(r["codassunto"]), texto(r["assunto"]), texto(r["situacao"]),
        inteiro(r["nf_capa"]), inteiro(r["codmotorista"]), texto(r["motorista"]),
    )


COLUNAS_CHAMADO = (
    "nummanif", "numseq", "dtab", "codfilial", "codcli", "cliente", "codassunto",
    "assunto", "situacao", "nf_capa", "codmotorista", "motorista",
)

# ---------------------------------------------------------------------------
# 3. Produtos reclamados no chamado
# ---------------------------------------------------------------------------
# GROUP BY porque PCMANIFPROD tem (chamado, produto) repetido em 2 linhas — a
# chave do destino e (chamado, seq, produto), e a quantidade soma.
SQL_CHAMADO_ITEM = """
SELECT
    mp.nummanif,
    mp.numseq,
    mp.codprod,
    SUM(mp.qtreclamada)                 AS qtreclamada,
    MAX(mp.numnota)                     AS nf_item,
    MAX(mp.codmotorista)                AS codmotorista,
    MAX(e.nome)                         AS motorista
FROM pcmanifprod mp
JOIN pcmanif m ON m.nummanif = mp.nummanif AND m.numseq = mp.numseq
LEFT JOIN pcempr e ON e.matricula = mp.codmotorista
WHERE m.dtab >= :ini_chamado
  {filial}
GROUP BY mp.nummanif, mp.numseq, mp.codprod
""".format(filial=_clausula_filial("TO_NUMBER(m.codfilial)"))


def _mapear_chamado_item(r: dict[str, Any]) -> tuple:
    return (
        inteiro(r["nummanif"]), inteiro(r["numseq"]), inteiro(r["codprod"]),
        r["qtreclamada"], inteiro(r["nf_item"]), inteiro(r["codmotorista"]), texto(r["motorista"]),
    )


COLUNAS_CHAMADO_ITEM = (
    "nummanif", "numseq", "codprod", "qtreclamada", "nf_item", "codmotorista", "motorista",
)


# ---------------------------------------------------------------------------
# Catalogo
# ---------------------------------------------------------------------------
def _binds() -> dict[str, Any]:
    ini = _data_inicial()
    return {"ini": ini, "ini_chamado": ini - timedelta(days=FOLGA_CHAMADO_DIAS)}


def _montar() -> list[Consulta]:
    b = _binds()
    return [
        Consulta(
            nome="reposicao_item",
            descricao="Itens dos pedidos de reposicao faturados (rotina 8352)",
            pagina="REPOSICOES",
            sql=SQL_REPOSICAO_ITEM,
            destino="reposicao.fato_item",
            colunas=COLUNAS_ITEM,
            mapear=_mapear_item,
            binds={"ini": b["ini"]},
            linhas_esperadas=None,       # sem Power BI de referencia: a planilha valida o recorte de 2026 no diagnostico
        ),
        Consulta(
            nome="chamado",
            descricao="Chamados (manifestacoes) — capa (rotina 8353)",
            pagina="REPOSICOES",
            sql=SQL_CHAMADO,
            destino="reposicao.fato_chamado",
            colunas=COLUNAS_CHAMADO,
            mapear=_mapear_chamado,
            binds={"ini_chamado": b["ini_chamado"]},
        ),
        Consulta(
            nome="chamado_item",
            descricao="Produtos reclamados em cada chamado (rotina 8353)",
            pagina="REPOSICOES",
            sql=SQL_CHAMADO_ITEM,
            destino="reposicao.fato_chamado_item",
            colunas=COLUNAS_CHAMADO_ITEM,
            mapear=_mapear_chamado_item,
            binds={"ini_chamado": b["ini_chamado"]},
        ),
    ]


def catalogo() -> list[Consulta]:
    """Monta o catalogo na hora (o ENV ja foi carregado pelo orquestrador)."""
    return _montar()


def selecionar(grupo: str = "todas", nomes: list[str] | None = None) -> list[Consulta]:
    todas = catalogo()
    if nomes:
        indice = {c.nome: c for c in todas}
        faltando = [n for n in nomes if n not in indice]
        if faltando:
            raise SystemExit(f"Consulta(s) inexistente(s): {', '.join(faltando)}. Use --listar.")
        return [indice[n] for n in nomes]
    if grupo == "todas":
        return todas
    return [c for c in todas if c.grupo == grupo]
