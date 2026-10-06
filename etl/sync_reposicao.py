#!/usr/bin/env python3
"""
sync_reposicao.py — orquestrador do sistema REPOSICOES.

Leva, numa tacada so, as rotinas 8352 (Pedido de Reposicao) e 8353 (Relatorio
Geral de Chamados) do Oracle/WinThor para o Supabase (projeto DATA WAREHOUSE,
schema `reposicao`).

Cada consulta roda de forma independente: se uma falhar, as outras continuam, e
o resultado de cada uma fica registrado em reposicao.controle_carga — e essa
tabela, nao o log na tela, que responde "a carga entrou?".

Como usar
---------
    python sync_reposicao.py                       # as tres consultas
    python sync_reposicao.py --consulta chamado    # so uma
    python sync_reposicao.py --listar              # mostra o catalogo e sai

O volume e pequeno (alguns milhares de linhas): a carga inteira leva segundos e
e um full refresh (TRUNCATE + INSERT, numa transacao por tabela), entao nao ha
estado intermediario para recuperar — a carga seguinte conserta qualquer falha.

Antes da primeira carga, rode o diagnostico_reposicao.py: ele testa as consultas
SEM gravar nada e confere o recorte de 2026 contra a planilha consolidada.
"""

from __future__ import annotations

import argparse
import sys

import bi_comum as bi

log = bi.configurar_log("sync_reposicao.log")

# Sem isto o bi_comum gravaria o controle_carga no schema do BI COMPRAS.
bi.definir_schema("reposicao")


def _argumentos() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Sincroniza REPOSICOES (Oracle/WinThor -> Supabase).")
    p.add_argument("--consulta", nargs="+", metavar="NOME",
                   help="Roda apenas as consultas indicadas (pelo nome do catalogo).")
    p.add_argument("--listar", action="store_true", help="Mostra o catalogo de consultas e sai.")
    return p.parse_args()


def _formatar(n: int | None) -> str:
    return "-" if n is None else f"{n:,}".replace(",", ".")


def _aquecer_painel(conn_pg) -> None:
    """Chama a funcao do painel uma vez, so para deixar o banco quente e provar
    que ela continua respondendo depois da carga. Se falhar, nao e problema da
    carga: o painel segue funcionando e o aviso fica no log."""
    relogio = bi.cronometro()
    try:
        with conn_pg.cursor() as cur:
            cur.execute("SELECT length(reposicao.painel_dados()::text)")
            tamanho = cur.fetchone()[0]
        conn_pg.commit()
        log.info("  painel aquecido em %.1fs (resposta de %s KB)", relogio(), round(tamanho / 1024))
    except Exception as exc:  # noqa: BLE001
        conn_pg.rollback()
        log.warning("  nao consegui aquecer o painel: %s", exc)


def main() -> int:
    args = _argumentos()
    bi.carregar_env()

    # O catalogo le o ENV (data inicial, filiais), entao so existe depois dele.
    from consultas_reposicao import catalogo, selecionar

    if args.listar:
        print()
        print(f"{'CONSULTA':20s} {'DESTINO':32s} DESCRICAO")
        print("-" * 96)
        for c in catalogo():
            print(f"{c.nome:20s} {c.destino:32s} {c.descricao}")
        print()
        return 0

    try:
        cfg_ora = bi.OracleConfig.from_env()
        cfg_pg = bi.SupabaseConfig.from_env()
    except SystemExit as exc:
        log.error("Configuracao invalida: %s", exc)
        return 1

    log.info("Senha do Supabase carregada do ENV (comprimento: %d caracteres).", len(cfg_pg.password))

    consultas = selecionar("todas", args.consulta)
    log.info("Vou rodar %d consulta(s): %s", len(consultas), ", ".join(c.nome for c in consultas))

    resultados: list[tuple[str, str, int | None, float]] = []

    try:
        with bi.conectar_oracle(cfg_ora) as conn_ora, bi.conectar_supabase(cfg_pg) as conn_pg:
            for consulta in consultas:
                relogio = bi.cronometro()
                log.info("=" * 70)
                log.info("[%s] %s", consulta.nome, consulta.descricao)
                try:
                    brutas = bi.extrair(conn_ora, consulta)
                    log.info("  Oracle devolveu %s linhas.", _formatar(len(brutas)))
                    linhas = bi.carregar(conn_pg, consulta, brutas)
                    conn_pg.commit()
                    segundos = relogio()
                    log.info("  OK — %s linhas em %.1fs -> %s", _formatar(linhas), segundos, consulta.destino)
                    resultados.append((consulta.nome, "OK", linhas, segundos))
                    bi.registrar_execucao(conn_pg, consulta, "OK", linhas, segundos, None)

                except Exception as exc:  # noqa: BLE001 — uma falha nao pode derrubar as outras
                    conn_pg.rollback()
                    segundos = relogio()
                    log.exception("  FALHOU: %s", consulta.nome)
                    resultados.append((consulta.nome, "ERRO", None, segundos))
                    bi.registrar_execucao(conn_pg, consulta, "ERRO", None, segundos, f"{type(exc).__name__}: {exc}")

            log.info("=" * 70)
            _aquecer_painel(conn_pg)

            log.info("RESUMO DA CARGA")
            log.info("%-20s %-6s %12s %9s", "CONSULTA", "STATUS", "LINHAS", "TEMPO")
            for nome, status, linhas, segundos in resultados:
                log.info("%-20s %-6s %12s %8.1fs", nome, status, _formatar(linhas), segundos)
            log.info("=" * 70)

    except Exception:
        log.exception("Nao consegui nem abrir as conexoes — nada foi carregado.")
        return 1

    falhas = [r for r in resultados if r[1] != "OK"]
    if falhas:
        log.error("%d consulta(s) falharam: %s", len(falhas), ", ".join(r[0] for r in falhas))
        return 1
    log.info("Todas as consultas foram carregadas com sucesso.")
    return 0


if __name__ == "__main__":
    try:
        codigo = main()
    except Exception:
        log.exception("Erro inesperado — veja o traceback acima / no sync_reposicao.log.")
        codigo = 1
    sys.exit(codigo)
