#!/usr/bin/env python3
"""
aquecer_painel.py — chama o painel publicado de poucos em poucos minutos, para
que quem abre o sistema nunca pegue ele frio.

O que acontece quando o painel esfria (medido em 2026-10-07):
  - a primeira chamada do dia a /api/dados deu 504 depois de 60 s; a segunda
    levou 13 s; a terceira, 0,16 s;
  - do computador do Julio, a primeira conexao com o pooler do Supabase depois
    de um tempo parado levou 35 s e as seguintes, 0,2 s.
O tempo e a ABERTURA da conexao com o banco, nao a consulta. A API guarda a
resposta no CDN da Vercel (5 min "fresca" + 24 h entregavel enquanto uma nova
e buscada por tras). Este script e quem renova essa resposta antes de alguem
precisar dela: a espera, se houver, e dele — nunca de quem esta mostrando o
sistema para a empresa.

Cada chamada devolve uma linha em aquecer_painel.log: horario, status, tempo,
tamanho e se veio do CDN (HIT) ou do banco (MISS/STALE). Sem PAINEL_URL no ENV,
nao faz nada (e avisa no log).

Rodar:  python aquecer_painel.py          (o instalador agenda de 5 em 5 minutos)
"""

from __future__ import annotations

import gzip
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

PASTA = os.path.dirname(os.path.abspath(sys.argv[0]))
LOG = os.path.join(PASTA, "aquecer_painel.log")
MAX_LINHAS_LOG = 600
TIMEOUT_S = 100          # a funcao da Vercel tem 60 s; a mais, para o CDN responder


def _linha_env(chave: str) -> str | None:
    """Le UMA chave do ENV sem carregar (nem imprimir) o resto — la ha senhas."""
    for pasta in (PASTA, os.path.dirname(PASTA)):
        for nome in ("ENV", ".env", "env"):
            caminho = os.path.join(pasta, nome)
            if not os.path.isfile(caminho):
                continue
            with open(caminho, encoding="utf-8") as arq:
                for linha in arq:
                    linha = linha.strip()
                    if linha.startswith("#") or "=" not in linha:
                        continue
                    k, v = linha.split("=", 1)
                    if k.strip() == chave:
                        return v.strip().strip('"').strip("'") or None
    return os.environ.get(chave)


def _registrar(texto: str) -> None:
    """Acrescenta ao log e mantem so as ultimas linhas. Nunca levanta erro."""
    try:
        linhas: list[str] = []
        if os.path.isfile(LOG):
            with open(LOG, encoding="utf-8") as arq:
                linhas = arq.read().splitlines()
        linhas.append(datetime.now().strftime("%d/%m/%Y %H:%M:%S") + "  " + texto)
        with open(LOG, "w", encoding="utf-8") as arq:
            arq.write("\n".join(linhas[-MAX_LINHAS_LOG:]) + "\n")
    except Exception:  # noqa: BLE001
        pass


def main() -> int:
    if sys.stdout is None:                       # pythonw: sem console
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8")

    base = (_linha_env("PAINEL_URL") or "").rstrip("/")
    if not base.startswith("http"):
        _registrar("AVISO  PAINEL_URL nao esta no ENV: nada para aquecer.")
        return 0

    url = base + "/api/dados"
    pedido = urllib.request.Request(url, headers={
        "Accept-Encoding": "gzip",               # gzip da para conferir aqui; brotli nao
        "User-Agent": "Lube-Aquecedor/1.0 (+reposicoes)",
    })
    inicio = time.monotonic()
    try:
        with urllib.request.urlopen(pedido, timeout=TIMEOUT_S) as resp:
            bruto = resp.read()
            cab = resp.headers
            status = resp.status
        corpo = gzip.decompress(bruto) if cab.get("Content-Encoding") == "gzip" else bruto
        dados = json.loads(corpo)
        linhas = len(dados.get("linhas", []))
        seg = time.monotonic() - inicio
        _registrar(
            f"OK  {status}  {seg:5.1f}s  {len(bruto) / 1024:6.0f} KB  cdn={cab.get('X-Vercel-Cache', '?'):5s} "
            f"idade={cab.get('Age', '?')}s  origem={cab.get('X-Painel-Origem', '?')}  linhas={linhas}"
        )
        return 0
    except urllib.error.HTTPError as e:
        _registrar(f"ERRO  HTTP {e.code} em {time.monotonic() - inicio:.1f}s  ({url})")
    except Exception as e:  # noqa: BLE001
        _registrar(f"ERRO  {type(e).__name__}: {e}  em {time.monotonic() - inicio:.1f}s  ({url})")
    return 1


if __name__ == "__main__":
    sys.exit(main())
