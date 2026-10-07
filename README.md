# REPOSIÇÕES E CHAMADOS — Lube Distribuidora

Painel de **reposições** (pedidos lançados no vendedor `999 REPOSICAO`) e dos **chamados** que as causam. Nasceu de uma planilha consolidada à mão a partir de duas rotinas do WinThor e foi reconstruído no padrão da casa:

```
WinThor (Oracle)  →  ETL em Python  →  Supabase (DATA WAREHOUSE, schema `reposicao`)  →  painel na Vercel
  rotina 8352            etl/                  web/db/                                      web/
  rotina 8353
```

| Rotina | Nome no WinThor | De onde sai |
|---|---|---|
| **8352** | Pedido de Reposição | `PCPEDC` + `PCPEDI` com `CODUSUR = 999` e `POSICAO = 'F'` (faturado) |
| **8353** | Relatório Geral de Chamados | `PCMANIF` + `PCMANIFPROD` + `PCMANASSUNTO` (manifestações do SAC) |

Ambas rodam no módulo de relatórios personalizados (`PCSIS800`). O ETL não executa as rotinas: lê as mesmas tabelas que elas leem.

## O que o painel mostra

Cinco páginas, menu lateral, filtros fixos no topo (**período · motivo · com/sem chamado · motorista · cliente**, e filial):

| Página | O que responde |
|---|---|
| **Visão geral** | Total em R$ mês a mês (com × sem chamado) e **acumulado do ano** contra o ano anterior · **% de reposições com chamado**, mês a mês, com a média do período e a **média anual** · principais motivos e clientes · variação contra o mesmo período do ano passado · ticket médio, unidades, chamados ligados, mediana de dias do chamado até a reposição |
| **Motivos** | Ranking de motivos por R$ e nº de reposições, evolução mensal dos 4 maiores, tabela completa |
| **Itens** | Itens (ou fornecedores) por **valor**, por **volume** (unidades) e por **recorrência** (em quantas reposições e meses aparecem) |
| **Motoristas** | Chamados e valor reposto por motorista, com o principal motivo de cada um |
| **Detalhe** | Linha a linha, com busca e **exportação para Excel** (`.xlsx` formatado, com os filtros escritos dentro) |

### Clique em qualquer número: abre o Detalhe já filtrado

Todo cartão, barra, ponto, ranking, média anual e linha de tabela leva ao **Detalhe** com o recorte que ele representa — por exemplo, clicar em "Falta de mercadoria" abre o Detalhe só com esse motivo; clicar na parte "sem chamado" da coluna de abril abre abril com `Sem chamado`; clicar em um item abre só aquele item (a faixa sob os filtros mostra o recorte e deixa tirá-lo). O botão **← Voltar** devolve a tela de onde o clique saiu, com os filtros que ela tinha.

| Clique | O que o Detalhe mostra |
|---|---|
| Cartão "Total", "Acumulado", "Média mensal" | o período dos filtros (o acumulado, de 1º de janeiro ao fim do período) |
| "Com chamado" / "Sem chamado" | só reposições com / sem chamado |
| "Cliente que mais fez reposições" | só aquele cliente |
| Coluna do gráfico mensal | aquele mês; clicando em uma cor, também com ou sem chamado (ou aquele motivo) |
| Ponto do acumulado | de janeiro até aquele mês |
| Motivo, cliente, motorista, item ou fornecedor em rankings e tabelas | só aquele |

Ao passar o mouse nos gráficos aparece um cartão com o valor de cada série, o total, a quantidade de reposições e o percentual com chamado. **SKU** (tabela de Motivos) é o número de produtos distintos — não de linhas de item.

## A regra de ligação entre reposição e chamado

Uma reposição cita a NF original na observação do pedido (`PEND. REF. A NF 1504784`). O chamado guarda a mesma NF. A view `reposicao.vw_vinculo` liga os dois:

1. **`produto + NF`** — chamado da mesma filial, da mesma NF e que reclama o mesmo produto reposto;
2. **`só NF`** — se o item não achou chamado pelo produto, qualquer chamado da mesma filial e NF (cobre os motivos que não são de mercadoria: cliente fechado, não deu tempo, sem ninguém para receber…).

Janela de datas: chamado aberto até 90 dias **antes** da reposição ou até 7 dias **depois** (às vezes o pedido é lançado antes do chamado). A planilha consolidada ligava um chamado aberto 145 dias depois da reposição só porque a NF coincidia.

**Reposição sem chamado** = nenhum chamado ligado, por nenhum dos dois caminhos (o "campo de chamado vazio" da planilha).

A NF de referência é lida das três observações (`OBS`, `OBS1`, `OBS2`), com tolerância a erro de digitação (`PEND. RE.F  ANF 1540436`). Desde setembro/2026 o **número do chamado** passa a ser digitado em `OBS` e a NF em `OBS1`; o leitor já trata isso.

## Divergências conscientes em relação à planilha consolidada

Conferido em 2026-10-06, de janeiro a setembro de 2026:

| | Planilha | Aqui | Por quê |
|---|---|---|---|
| Pedidos de reposição | 1.622 | **1.622** | idêntico |
| Itens (pedido × produto) | 2.005 | **2.005** | idêntico |
| **Total em R$** | **R$ 316.230,78** | **R$ 218.896,89** | **A planilha repete o total do PEDIDO em cada item e em cada chamado do item.** Pedido com 3 itens aparecia 3 vezes. O número certo é a soma dos pedidos (`PCPEDC.VLTOTAL`), e bate com o Oracle ao centavo. Somar a coluna da planilha dava 44% a mais. |
| Linhas | 2.127 | 2.133 | A planilha cortou chamados abertos antes de 01/01 e depois de 29/09. Aqui uma reposição de 02/01 ligada a um chamado de dezembro conta como **com chamado**. |
| Pedidos com chamado | 83,4% (1.353) | 85,1% (1.381) | idem, mais os chamados de 30/09 e a NF lida das observações com a grafia "ANF". |

A regra de ligação reproduz **2.073 das 2.127 linhas** da planilha (97,5%). As 54 restantes, medidas uma a uma:

- **o banco acha chamado onde a planilha não tinha** (60 ligações): 29 abertos em dezembro/2025 (a planilha só listou chamados abertos a partir de 02/01), 9 abertos depois da extração da planilha (29/09 à noite em diante) e 20 casos de segundo chamado do mesmo item ou chamado da NF que o relatório 8353 não trouxe;
- **o banco deixa de ligar** 18 chamados que a planilha ligou: 16 foram abertos de 8 a 145 dias **depois** da reposição (fora da janela de 7 dias) e 2 a planilha ligou só pela NF, enquanto o banco já tinha o chamado do mesmo produto.

### Dinheiro aditivo
Cada linha do painel (item × chamado) carrega uma **parte** do total do pedido: repartida entre os itens na proporção de quantidade × preço e, dentro do item, em partes iguais entre os chamados. A repartição é em **centavos exatos** (método do maior resto): a soma das linhas de um pedido é, ao centavo, o total do pedido. Por isso qualquer filtro soma certo e a planilha exportada fecha igual à tela. Contagens de pedido e de item usam valores **distintos**, nunca número de linhas.

### "Reposição com chamado"
O **pedido** conta como *com chamado* se ao menos um item dele tem chamado ligado. O percentual de **valor** é medido por item. Com filtro de motivo ou de motorista ligado, o numerador é o que passa no filtro e o denominador são todas as reposições do período: o indicador vira "qual parcela das reposições vem desse motivo/motorista".

## Estrutura

```
etl/                       pipeline Python (roda na rede do WinThor)
  bi_comum.py              infraestrutura (cópia do COMPRAS/COMERCIAL)
  consultas_reposicao.py   3 consultas: reposicao_item, chamado, chamado_item
  sync_reposicao.py        orquestrador
  diagnostico_reposicao.py roda tudo SEM gravar e confere o recorte de 2026 contra a planilha
  executar.py              inicializador à prova de silêncio (usado pelo Agendador)
  instalar_e_agendar.ps1   instala em C:\BI\REPOSICOES e cria a tarefa
web/                       painel (estático + 1 função serverless)
  api/dados.js             chama reposicao.painel_dados()
  db/                      SQL versionado, na ordem em que foi aplicado
```

| Arquivo SQL | O que faz |
|---|---|
| `db/01-schema.sql` | schema `reposicao`, 3 fatos, `controle_carga`, RLS ligado e sem políticas |
| `db/02-views-e-funcao.sql` | `vw_vinculo`, `vw_linhas` e `painel_dados()` — **é a definição vigente** |
| `db/03-valor-em-centavos.sql`, `db/04-painel-dados-compacto.sql` | registro da ordem de aplicação |

## Como rodar

```powershell
# 1. nada gravado, só conferir
python etl\diagnostico_reposicao.py

# 2. carga
python etl\sync_reposicao.py

# 3. agendar (uma vez; roda aos :35 de 07:35 a 17:35 de 2 em 2 horas, e 22:35)
#    duplo clique em INSTALAR TUDO.bat na pasta de rede

# 4. ver o painel no seu computador, antes de publicar (usa o ENV do ETL, sem imprimir a senha)
cd web
npm install
node servidor_local.js        # abre em http://localhost:3101
```

"A carga entrou?" se responde em `reposicao.controle_carga`, não no log.

## Painel na Vercel

Projeto novo, **Root Directory = `web`**. Variáveis de ambiente (quem cadastra é o Júlio): `SUPABASE_DB_HOST`, `SUPABASE_DB_PORT` (5432), `SUPABASE_DB_NAME`, `SUPABASE_DB_USER`, `SUPABASE_DB_PASSWORD`.

> **Acesso:** a proteção "Standard" da Vercel não cobre o endereço principal do projeto (ver a nota da Vercel no cérebro). O painel tem nome de cliente e de motorista; a porta que fecha o endereço sem plano pago é o guarda da SENTINELA LUBE.

## Limites conhecidos

- O ranking de motoristas é **absoluto**: o banco não tem o total de entregas de cada um, então não há taxa de chamado por entrega.
- Só reposições **faturadas** (`POSICAO = 'F'`). Pedido cancelado (`C`) fica de fora, como na planilha.
- A coluna `motorista` vem do chamado; reposição sem chamado não tem motorista.
- O mês em andamento aparece marcado com `*` e fica fora da média mensal.
