#!/usr/bin/env python3
"""
diagnostico_reposicao.py — roda as consultas do REPOSICOES SEM gravar nada.

Use antes da primeira carga e sempre que mexer em consultas_reposicao.py.
Mostra quantas linhas cada consulta devolve e quanto tempo leva, e depois confere
o recorte de janeiro a setembro de 2026 contra a planilha consolidada que o
Julio montou a mao com as duas rotinas (Consolidado_Chamados_Reposicoes_Janeiro_a_Setembro_2026.xlsx).

Os valores de referencia abaixo sairam dessa planilha, conferidos no Oracle em
2026-10-06 — e batem EXATAMENTE:

    pedidos de reposicao ............ 1.622
    itens (pedido x produto) ........ 2.005
    soma do total dos pedidos ....... R$ 218.896,89

ATENCAO a um detalhe da planilha: a coluna VALOR TOTAL e o total do PEDIDO,
repetido em cada item (e de novo em cada chamado ligado ao item). Somar a coluna
inteira da R$ 316.230,78 — 44% a mais que o real. O numero certo e o de cima.
"""

from __future__ import annotations

import sys
from datetime import date

import bi_comum as bi

log = bi.configurar_log("diagnostico_reposicao.log")
bi.definir_schema("reposicao")

REFERENCIA_2026 = {
    "pedidos": 1622,
    "itens": 2005,
    "valor_pedidos": 218896.89,
}


def _fmt(n) -> str:
    return "-" if n is None else f"{n:,}".replace(",", ".")


def _brl(v: float) -> str:
    return "R$ " + f"{v:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def main() -> int:
    bi.carregar_env()
    from consultas_reposicao import CODUSUR_REPOSICAO, catalogo

    cfg_ora = bi.OracleConfig.from_env()
    problemas = 0

    with bi.conectar_oracle(cfg_ora) as conn_ora:
        log.info("=" * 70)
        log.info("1. Cada consulta do catalogo (sem gravar)")
        for consulta in catalogo():
            relogio = bi.cronometro()
            try:
                linhas = bi.extrair(conn_ora, consulta)
                amostra = consulta.mapear(linhas[0]) if linhas else None
                log.info("  %-16s %10s linhas em %.1fs   (amostra mapeada: %s colunas)",
                         consulta.nome, _fmt(len(linhas)), relogio(), len(amostra) if amostra else 0)
            except Exception:  # noqa: BLE001
                problemas += 1
                log.exception("  %s FALHOU", consulta.nome)

        log.info("=" * 70)
        log.info("2. Conferencia contra a planilha (2026-01-01 a 2026-09-30)")
        with conn_ora.cursor() as cur:
            cur.execute(
                """
                SELECT COUNT(DISTINCT p.numped), COUNT(*)
                FROM pcpedc p JOIN pcpedi i ON i.numped = p.numped
                WHERE p.codusur = :u AND p.posicao = 'F'
                  AND p.data >= :ini AND p.data < :fim
                """,
                {"u": CODUSUR_REPOSICAO, "ini": date(2026, 1, 1), "fim": date(2026, 10, 1)},
            )
            pedidos, itens = cur.fetchone()
            cur.execute(
                """
                SELECT SUM(vltotal) FROM pcpedc p
                WHERE p.codusur = :u AND p.posicao = 'F' AND p.data >= :ini AND p.data < :fim
                  AND EXISTS (SELECT 1 FROM pcpedi i WHERE i.numped = p.numped)
                """,
                {"u": CODUSUR_REPOSICAO, "ini": date(2026, 1, 1), "fim": date(2026, 10, 1)},
            )
            valor = float(cur.fetchone()[0] or 0)

        confere = [
            ("pedidos de reposicao", pedidos, REFERENCIA_2026["pedidos"], _fmt),
            ("itens (pedido x produto)", itens, REFERENCIA_2026["itens"], _fmt),
            ("soma do total dos pedidos", round(valor, 2), REFERENCIA_2026["valor_pedidos"], _brl),
        ]
        log.info("  %-28s %16s %16s", "", "OBTIDO", "PLANILHA")
        for nome, obtido, esperado, f in confere:
            ok = abs(obtido - esperado) < 0.005
            problemas += 0 if ok else 1
            log.info("  %-28s %16s %16s   %s", nome, f(obtido), f(esperado), "OK" if ok else "DIVERGE")

    log.info("=" * 70)
    log.info("Diagnostico terminou com %d problema(s).", problemas)
    return 1 if problemas else 0


if __name__ == "__main__":
    try:
        codigo = main()
    except SystemExit as exc:
        log.error("%s", exc)
        codigo = 1
    except Exception:
        log.exception("Erro inesperado.")
        codigo = 1
    sys.exit(codigo)
