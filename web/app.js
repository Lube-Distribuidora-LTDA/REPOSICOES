/* =============================================================================
 * app.js — painel REPOSIÇÕES E CHAMADOS (Lube Distribuidora)
 *
 * Uma chamada só ao banco (/api/dados) traz as LINHAS: cada linha é um item de
 * pedido de reposição ligado ao chamado que o causou (ou sem chamado). Os cinco
 * filtros e todos os gráficos são calculados aqui, no navegador — o volume é de
 * alguns milhares de linhas e tudo se cruza com tudo.
 *
 * O dinheiro de cada linha é ADITIVO: a soma de `v` em qualquer recorte é a soma
 * dos pedidos do recorte (a planilha consolidada repetia o total do pedido em
 * cada item e somava 44% a mais). Contagens de pedido e de item usam valores
 * DISTINTOS — nunca "número de linhas".
 *
 * Linha (chaves curtas, para o JSON caber):
 *   d data · f filial · pd pedido · nf NF da reposição · c cliente · e emitente
 *   p produto · q unidades · v R$ · ch nº do chamado · m motivo · mo motorista
 *   vi vínculo (1 produto+NF, 2 só NF) · qr unid. reclamadas · da abertura · nr NF de referência
 * ========================================================================== */
(function () {
"use strict";

/* ---------------------------------------------------------------------------
 * Utilidades
 * ------------------------------------------------------------------------ */
var MESES = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
var MESES_LONGO = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
var NS = "http://www.w3.org/2000/svg";

function el(tag, cls, txt) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
}
function S(tag, attrs, txt) {
  var n = document.createElementNS(NS, tag);
  for (var k in attrs) n.setAttribute(k, attrs[k]);
  if (txt != null) n.textContent = txt;
  return n;
}
function limpar(n) { while (n.firstChild) n.removeChild(n.firstChild); }
function $(id) { return document.getElementById(id); }

var nf0 = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
var nf1 = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
var nf2 = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fInt(n) { return nf0.format(Math.round(n || 0)); }
/* unidades: o rateio entre chamados deixa fração por baixo; na tela vai inteiro */
function fQtd(n) { return nf0.format(Math.round(n || 0)); }
function fBRL(n) { return "R$ " + nf2.format(n || 0); }
function fPct(x) { return x == null || isNaN(x) ? "—" : nf1.format(x * 100) + "%"; }
/* R$ 14,4 mil · R$ 1,25 mi — o padrão da casa. Valor cheio vai no tooltip. */
function fMil(n) {
  n = n || 0;
  var a = Math.abs(n), s = n < 0 ? "-" : "";
  if (a >= 1e6) return s + "R$ " + nf2.format(a / 1e6) + " mi";
  if (a >= 1e3) return s + "R$ " + nf1.format(a / 1e3) + " mil";
  return s + "R$ " + nf0.format(a);
}
function fMilCurto(n) {
  n = n || 0;
  var a = Math.abs(n);
  if (a >= 1e6) return nf2.format(a / 1e6) + " mi";
  if (a >= 1e3) return nf1.format(a / 1e3) + " mil";
  return nf0.format(a);
}
function fData(d) { return d ? d.slice(8, 10) + "/" + d.slice(5, 7) + "/" + d.slice(0, 4) : ""; }
function fDataHora(iso) {
  if (!iso) return "";
  return iso.slice(8, 10) + "/" + iso.slice(5, 7) + "/" + iso.slice(0, 4) + " " + iso.slice(11, 16);
}
function ultimoDia(ym) {
  var y = +ym.slice(0, 4), m = +ym.slice(5, 7);
  return ym + "-" + String(new Date(y, m, 0).getDate()).padStart(2, "0");
}
function diasEntre(a, b) { return Math.round((Date.parse(a) - Date.parse(b)) / 864e5); }
function mediana(v) {
  if (!v.length) return null;
  var s = v.slice().sort(function (a, b) { return a - b; }), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function norm(s) { return String(s == null ? "" : s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); }
function deslocarAno(d, n) { return (+d.slice(0, 4) + n) + d.slice(4); }

/* ---------------------------------------------------------------------------
 * Estado
 * ------------------------------------------------------------------------ */
var E = {
  pagina: "geral",
  de: "", ate: "", preset: "ano",
  motivos: new Set(), motoristas: new Set(), filiais: new Set(),
  chamado: "todos",                 // todos | com | sem
  itensVisao: "produto",            // produto | fornecedor
  itensOrdem: "valor",              // valor | volume | recorrencia
  T: {}                             // estado de cada tabela (busca, ordem, página)
};
var D = null;            // resposta do banco
var R = [];              // linhas preparadas
var MIND = "", MAXD = "";
var FILA = [];           // gráficos que precisam do elemento já na página para medir a largura

var PAGINAS = [
  { id: "geral", nome: "Visão geral", eyebrow: "Reposições e chamados",
    ic: '<path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/>' },
  { id: "motivos", nome: "Motivos", eyebrow: "Por que se repõe",
    ic: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>' },
  { id: "itens", nome: "Itens", eyebrow: "O que mais se repõe",
    ic: '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/>' },
  { id: "motoristas", nome: "Motoristas", eyebrow: "Quem entregou",
    ic: '<path d="M3 7h11v9H3z"/><path d="M14 10h4l3 3v3h-7z"/><circle cx="7" cy="18" r="1.8"/><circle cx="17" cy="18" r="1.8"/>' },
  { id: "detalhe", nome: "Detalhe", eyebrow: "Linha a linha",
    ic: '<path d="M4 6h16M4 12h16M4 18h10"/>' }
];

/* ---------------------------------------------------------------------------
 * Dados
 * ------------------------------------------------------------------------ */
function preparar(json) {
  D = json;
  var P = json.dims.produtos;
  R = (json.linhas || []).map(function (l) {
    return {
      d: l.d, mes: l.d.slice(0, 7), f: l.f, pd: l.pd, nf: l.nf, c: l.c, e: l.e, p: l.p,
      cod: P[l.p][0], fo: P[l.p][2] == null ? -1 : P[l.p][2],
      q: l.q || 0, v: l.v || 0,
      ch: l.ch || 0, m: l.m == null ? -1 : l.m, mo: l.mo == null ? -1 : l.mo,
      vi: l.vi || 0, qr: l.qr || 0, da: l.da || "", nr: l.nr || 0,
      ik: l.pd + "/" + l.p
    };
  });
  MIND = R.length ? R[0].d : "";
  MAXD = R.length ? R[R.length - 1].d : "";
}

function nomeCliente(i) { var x = D.dims.clientes[i]; return x ? x[1] : "—"; }
function nomeEmitente(i) { var x = D.dims.emitentes[i]; return x ? x[1] : "—"; }
function nomeProduto(i) { var x = D.dims.produtos[i]; return x ? x[1] : "—"; }
function codProduto(i) { var x = D.dims.produtos[i]; return x ? x[0] : ""; }
function nomeFornecedor(i) { var x = D.dims.fornecedores[i]; return x ? x[1] : "—"; }
function nomeMotivo(i) { var x = D.dims.motivos[i]; return x ? x[1] : "—"; }
function nomeMotorista(i) { var x = D.dims.motoristas[i]; return x ? x[1] : "—"; }

/* ---------------------------------------------------------------------------
 * Filtros
 * ------------------------------------------------------------------------ */
function passaBase(r) {
  return r.d >= E.de && r.d <= E.ate && (!E.filiais.size || E.filiais.has(r.f));
}
function passaChamado(r) {
  if (E.chamado === "com" && !r.ch) return false;
  if (E.chamado === "sem" && r.ch) return false;
  if (E.motivos.size && !E.motivos.has(r.m)) return false;
  if (E.motoristas.size && !E.motoristas.has(r.mo)) return false;
  return true;
}
function passaSemPeriodo(r) {
  return (!E.filiais.size || E.filiais.has(r.f)) && passaChamado(r);
}
function contexto() {
  var B = [], F = [];
  for (var i = 0; i < R.length; i++) {
    var r = R[i];
    if (!passaBase(r)) continue;
    B.push(r);
    if (passaChamado(r)) F.push(r);
  }
  return { B: B, F: F };
}

function presets() {
  var ay = +MAXD.slice(0, 4);
  var out = [{ id: "ano", rot: "Ano " + ay, de: ay + "-01-01", ate: MAXD }];
  if (MIND.slice(0, 4) < String(ay)) {
    out.push({ id: "ant", rot: "Ano " + (ay - 1), de: (ay - 1) + "-01-01", ate: (ay - 1) + "-12-31" });
  }
  function menosMeses(n) {
    var y = +MAXD.slice(0, 4), m = +MAXD.slice(5, 7) - n;
    while (m < 1) { m += 12; y--; }
    return y + "-" + String(m).padStart(2, "0") + "-01";
  }
  out.push({ id: "6m", rot: "Últimos 6 meses", de: menosMeses(5), ate: MAXD });
  out.push({ id: "12m", rot: "Últimos 12 meses", de: menosMeses(11), ate: MAXD });
  out.push({ id: "tudo", rot: "Tudo", de: MIND, ate: MAXD });
  return out;
}
function aplicarPreset(id) {
  var p = presets().filter(function (x) { return x.id === id; })[0];
  if (!p) return;
  E.de = p.de < MIND ? MIND : p.de;
  E.ate = p.ate;
  E.preset = id;
}
function presetAtual() {
  var achou = presets().filter(function (p) {
    return (p.de < MIND ? MIND : p.de) === E.de && p.ate === E.ate;
  })[0];
  return achou ? achou.id : "";
}

function listaMeses(de, ate) {
  var out = [], y = +de.slice(0, 4), m = +de.slice(5, 7), y2 = +ate.slice(0, 4), m2 = +ate.slice(5, 7);
  while (y < y2 || (y === y2 && m <= m2)) {
    out.push(y + "-" + String(m).padStart(2, "0"));
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}
function mesParcial(ym) {
  var fim = ultimoDia(ym);
  /* o primeiro dia com dado (MIND) não é recorte do usuário: 02/01 é só o primeiro dia útil */
  return (ym === E.ate.slice(0, 7) && E.ate < fim) ||
         (ym === E.de.slice(0, 7) && E.de > ym + "-01" && E.de !== MIND) ||
         (ym === MAXD.slice(0, 7) && MAXD < fim);
}
function rotMes(ym, multiAno) {
  return MESES[+ym.slice(5, 7) - 1] + (multiAno ? "/" + ym.slice(2, 4) : "");
}
function descricaoFiltros() {
  var f = [["Período", fData(E.de) + " a " + fData(E.ate)]];
  f.push(["Motivos", E.motivos.size ? Array.from(E.motivos).map(nomeMotivo).join("; ") : "todos"]);
  f.push(["Chamado", E.chamado === "com" ? "só reposições COM chamado" : E.chamado === "sem" ? "só reposições SEM chamado" : "com e sem chamado"]);
  f.push(["Motoristas", E.motoristas.size ? Array.from(E.motoristas).map(nomeMotorista).join("; ") : "todos"]);
  f.push(["Filiais", E.filiais.size ? Array.from(E.filiais).sort().join(", ") : "todas"]);
  return f;
}

/* ---------------------------------------------------------------------------
 * Cálculos
 * ------------------------------------------------------------------------ */
function resumir(F, B) {
  var ped = new Set(), pedCom = new Set(), pedComB = new Set(), pedB = new Set(), it = new Set(),
      cli = new Set(), cham = new Set(), seen = new Set(), lags = [],
      v = 0, q = 0, vCom = 0, vSem = 0, vB = 0, qr = 0, i, r;
  for (i = 0; i < B.length; i++) {
    r = B[i]; pedB.add(r.pd); vB += r.v;
    if (r.ch) pedComB.add(r.pd);
  }
  var pedSem = new Set();
  for (i = 0; i < F.length; i++) {
    r = F[i];
    ped.add(r.pd); it.add(r.ik); cli.add(r.c); v += r.v; q += r.q;
    if (r.ch) {
      pedCom.add(r.pd); cham.add(r.ch); vCom += r.v; qr += r.qr;
      var k = r.pd + "/" + r.ch;
      if (r.da && !seen.has(k)) { seen.add(k); lags.push(diasEntre(r.d, r.da.slice(0, 10))); }
    } else {
      vSem += r.v;
      if (!pedComB.has(r.pd)) pedSem.add(r.pd);
    }
  }
  return {
    v: v, q: q, vCom: vCom, vSem: vSem, vB: vB, qr: qr,
    ped: ped.size, pedCom: pedCom.size, pedSem: pedSem.size, pedB: pedB.size,
    itens: it.size, clientes: cli.size, chamados: cham.size,
    lagMed: mediana(lags),
    pctPed: pedB.size ? pedCom.size / pedB.size : 0,
    pctVal: vB ? vCom / vB : 0
  };
}

function serieMensal(B, F, meses) {
  var idx = {}, n = meses.length, i;
  meses.forEach(function (m, k) { idx[m] = k; });
  var vCom = [], vSem = [], pedB = [], pedCom = [];
  for (i = 0; i < n; i++) { vCom.push(0); vSem.push(0); pedB.push(new Set()); pedCom.push(new Set()); }
  B.forEach(function (r) { var k = idx[r.mes]; if (k != null) pedB[k].add(r.pd); });
  F.forEach(function (r) {
    var k = idx[r.mes]; if (k == null) return;
    if (r.ch) { vCom[k] += r.v; pedCom[k].add(r.pd); } else vSem[k] += r.v;
  });
  return meses.map(function (m, k) {
    return {
      mes: m, vCom: vCom[k], vSem: vSem[k], v: vCom[k] + vSem[k],
      pedB: pedB[k].size, pedCom: pedCom[k].size,
      pct: pedB[k].size ? pedCom[k].size / pedB[k].size : null
    };
  });
}

/* soma por mês, por ano: ignora o filtro de início do período — "acumulado do
   ano" é do 1º de janeiro até o fim do período, não a partir de onde o filtro começa */
function somaMensalAno() {
  var m = {};
  R.forEach(function (r) {
    if (r.d > E.ate || !passaSemPeriodo(r)) return;
    m[r.mes] = (m[r.mes] || 0) + r.v;
  });
  return m;
}

function somaPeriodo(de, ate) {
  var s = 0;
  R.forEach(function (r) { if (r.d >= de && r.d <= ate && passaSemPeriodo(r)) s += r.v; });
  return s;
}

function mediaAnual() {
  var porAno = {};
  R.forEach(function (r) {
    if (E.filiais.size && !E.filiais.has(r.f)) return;
    var a = r.mes.slice(0, 4), g = porAno[a];
    if (!g) g = porAno[a] = { ped: new Set(), com: new Set(), v: 0, ate: "" };
    g.ped.add(r.pd); g.v += r.v;
    if (r.d > g.ate) g.ate = r.d;
    if (passaChamado(r) && r.ch) g.com.add(r.pd);
  });
  return Object.keys(porAno).sort().map(function (a) {
    var g = porAno[a];
    return { ano: a, ped: g.ped.size, com: g.com.size, pct: g.ped.size ? g.com.size / g.ped.size : 0, v: g.v, ate: g.ate };
  });
}

function agrupar(rows, chave) {
  var M = new Map();
  rows.forEach(function (r) {
    var k = chave(r);
    if (k == null) return;
    var g = M.get(k);
    if (!g) {
      g = { k: k, v: 0, q: 0, qr: 0, ped: new Set(), it: new Set(), cli: new Set(), cham: new Set(), meses: new Set(), vCom: 0 };
      M.set(k, g);
    }
    g.v += r.v; g.q += r.q; g.qr += r.qr;
    g.ped.add(r.pd); g.it.add(r.ik); g.cli.add(r.c); g.meses.add(r.mes);
    if (r.ch) { g.cham.add(r.ch); g.vCom += r.v; }
  });
  return Array.from(M.values());
}

/* ---------------------------------------------------------------------------
 * Componentes
 * ------------------------------------------------------------------------ */
function noGrafico(box, fn) { FILA.push({ box: box, fn: fn }); }
function desenharGraficos() {
  FILA.forEach(function (x) {
    limpar(x.box);
    try { x.fn(x.box); } catch (e) { x.box.appendChild(el("div", "vazio", "Não consegui desenhar este gráfico.")); console.error(e); }
  });
}

function painel(titulo, sub, corpo, acoes) {
  var p = el("div", "painel sobe");
  var h = el("div", "painel-head");
  var esq = el("div");
  esq.appendChild(el("h2", null, titulo));
  if (sub) esq.appendChild(el("div", "sub", sub));
  h.appendChild(esq);
  if (acoes) h.appendChild(acoes);
  p.appendChild(h);
  var c = el("div", "painel-corpo");
  if (corpo) c.appendChild(corpo);
  p.appendChild(c);
  return p;
}

function kpi(cls, rotulo, valor, sub, ajuda) {
  var k = el("div", "kpi " + (cls || ""));
  var l = el("div", "lbl");
  l.appendChild(document.createTextNode(rotulo));
  if (ajuda) {
    var a = el("span", "ajuda", "?");
    a.tabIndex = 0;
    a.appendChild(el("span", "tip", ajuda));
    l.appendChild(a);
  }
  k.appendChild(l);
  k.appendChild(el("div", "val", valor));
  var s = el("div", "sub");
  if (sub instanceof Node) s.appendChild(sub); else s.textContent = sub || "";
  k.appendChild(s);
  return k;
}

function delta(atual, anterior, rotulo) {
  var d = el("span", "delta");
  if (!anterior) { d.className = "delta igual"; d.textContent = "sem base em " + rotulo; return d; }
  var x = atual / anterior - 1;
  d.className = "delta " + (Math.abs(x) < 0.005 ? "igual" : x > 0 ? "sobe" : "desce");
  d.textContent = (x > 0 ? "▲ " : x < 0 ? "▼ " : "") + nf1.format(Math.abs(x) * 100) + "% vs " + rotulo;
  return d;
}

function rank(itens, empilhado) {
  var wrap = el("div", "rank" + (empilhado ? " empilhado" : ""));
  var max = Math.max.apply(null, itens.map(function (i) { return i.valor; }).concat([1e-9]));
  itens.forEach(function (it, i) {
    var l = el("div", "rank-l");
    l.appendChild(el("span", "rank-pos", String(i + 1)));
    var nm = el("span", "rank-nome", it.nome);
    nm.title = it.nome;
    l.appendChild(nm);
    var tr = el("div", "rank-trilho"), b = el("div", "rank-barra");
    b.style.width = Math.max(1.5, it.valor / max * 100) + "%";
    b.style.background = it.cor || "var(--viz-1)";
    tr.appendChild(b);
    l.appendChild(tr);
    var val = el("span", "rank-val", it.texto);
    if (it.sub) val.appendChild(el("span", "rank-sub", it.sub));
    if (it.tip) l.title = it.tip;
    l.appendChild(val);
    wrap.appendChild(l);
  });
  return wrap;
}

function vazioFiltro() {
  var d = el("div", "vazio-filtro");
  d.innerHTML = "Nenhuma reposição com esses filtros.<br><b>Afrouxe o período ou limpe os filtros</b> para ver dados.";
  return d;
}

/* --- seletor com várias opções ------------------------------------------- */
function multi(cfg) {
  var raiz = el("div", "multi");
  var btn = el("button", "multi-btn");
  btn.type = "button";
  btn.appendChild(el("span", null, cfg.rot + ":"));
  var vs = el("span", "v");
  btn.appendChild(vs);
  btn.insertAdjacentHTML("beforeend", '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 4l4 4 4-4"/></svg>');
  raiz.appendChild(btn);
  var painelEl = null;

  function nomeDe(id) { var o = cfg.opcoes().filter(function (x) { return x.id === id; })[0]; return o ? o.nome : String(id); }
  function atualizar() {
    var n = cfg.conjunto.size;
    btn.classList.toggle("on", n > 0);
    vs.textContent = n === 0 ? "todos" : n === 1 ? nomeDe(Array.from(cfg.conjunto)[0]) : n + " selecionados";
    vs.title = vs.textContent;
  }
  function fechar() {
    if (painelEl) { painelEl.remove(); painelEl = null; }
    document.removeEventListener("mousedown", fora, true);
    document.removeEventListener("keydown", tecla, true);
  }
  function fora(e) { if (!raiz.contains(e.target)) fechar(); }
  function tecla(e) { if (e.key === "Escape") fechar(); }
  function abrir() {
    painelEl = el("div", "multi-painel");
    var topo = el("div", "busca-m");
    var inp = el("input"); inp.type = "search"; inp.placeholder = "Buscar " + cfg.rot.toLowerCase() + "…";
    var limparBtn = el("button", null, "Limpar"); limparBtn.type = "button";
    topo.appendChild(inp); topo.appendChild(limparBtn);
    painelEl.appendChild(topo);
    var lista = el("div", "multi-lista");
    painelEl.appendChild(lista);
    function montar() {
      limpar(lista);
      var termo = norm(inp.value), n = 0;
      cfg.opcoes().forEach(function (o) {
        if (termo && norm(o.nome).indexOf(termo) === -1) return;
        n++;
        var li = el("div", "multi-op" + (cfg.conjunto.has(o.id) ? " on" : ""));
        li.appendChild(el("span", "cx", "✓"));
        var nm = el("span", "nm", o.nome); nm.title = o.nome;
        li.appendChild(nm);
        li.appendChild(el("span", "qt", fInt(o.qt)));
        li.addEventListener("click", function () {
          if (cfg.conjunto.has(o.id)) cfg.conjunto.delete(o.id); else cfg.conjunto.add(o.id);
          li.classList.toggle("on", cfg.conjunto.has(o.id));
          atualizar(); cfg.aoMudar();
        });
        lista.appendChild(li);
      });
      if (!n) lista.appendChild(el("div", "multi-vazio", "Nada encontrado."));
    }
    inp.addEventListener("input", montar);
    limparBtn.addEventListener("click", function () { cfg.conjunto.clear(); montar(); atualizar(); cfg.aoMudar(); });
    montar();
    raiz.appendChild(painelEl);
    inp.focus();
    document.addEventListener("mousedown", fora, true);
    document.addEventListener("keydown", tecla, true);
  }
  btn.addEventListener("click", function () { if (painelEl) fechar(); else abrir(); });
  raiz.atualizar = atualizar;
  atualizar();
  return raiz;
}

/* --- tabela ordenável, com busca, páginas e exportação para Excel ---------
 * coluna: { t título · k tipo (texto|moeda|inteiro|percentual|data) · v(r) valor cru ·
 *           f(r) texto da tela (opcional) · somar:false · corta:true · fixa:true } */
function tabela(cfg) {
  var st = E.T[cfg.id] || (E.T[cfg.id] = { q: "", col: cfg.ordem ? cfg.ordem[0] : 0, dir: cfg.ordem ? cfg.ordem[1] : -1, pag: 1 });
  var env = el("div");
  var tam = cfg.tam || 25;

  function texto(c, r) {
    if (c.f) return c.f(r);
    var v = c.v(r);
    if (v == null || v === "") return "";
    if (c.k === "moeda") return fBRL(v);
    if (c.k === "inteiro") return fQtd(v);
    if (c.k === "percentual") return nf1.format(v) + "%";
    if (c.k === "data") return fData(v);
    return String(v);
  }
  function numerica(c) { return c.k === "moeda" || c.k === "inteiro" || c.k === "percentual"; }

  function filtradas() {
    var rows = cfg.linhas;
    if (cfg.busca && st.q) {
      var t = norm(st.q);
      rows = rows.filter(function (r) {
        return cfg.colunas.some(function (c) { return c.k === "texto" && norm(texto(c, r)).indexOf(t) !== -1; });
      });
    }
    var c = cfg.colunas[st.col];
    if (c) {
      var d = st.dir;
      rows = rows.slice().sort(function (a, b) {
        var x = c.v(a), y = c.v(b);
        if (x == null) x = numerica(c) || c.k === "data" ? -Infinity : "";
        if (y == null) y = numerica(c) || c.k === "data" ? -Infinity : "";
        if (typeof x === "string" || typeof y === "string") return String(x).localeCompare(String(y), "pt-BR") * d;
        return (x - y) * d;
      });
    }
    return rows;
  }

  function desenhar() {
    limpar(env);
    var rows = filtradas();
    var paginas = Math.max(1, Math.ceil(rows.length / tam));
    if (st.pag > paginas) st.pag = paginas;

    var barra = el("div", "filtros");
    barra.style.borderRadius = "0"; barra.style.border = "0"; barra.style.borderBottom = "1px solid var(--line-1)"; barra.style.background = "transparent";
    if (cfg.busca) {
      var b = el("div", "busca");
      b.style.marginLeft = "0";
      var inp = el("input"); inp.type = "search"; inp.placeholder = cfg.busca; inp.value = st.q;
      inp.addEventListener("input", function () {
        st.q = inp.value; st.pag = 1;
        var pos = inp.selectionStart;
        desenhar();
        var novo = env.querySelector(".busca input");
        if (novo) { novo.focus(); try { novo.setSelectionRange(pos, pos); } catch (e) { /* tipo não suporta */ } }
      });
      b.appendChild(inp);
      barra.appendChild(b);
    }
    var info = el("div", "fgrupo");
    info.appendChild(el("span", "frot", fInt(rows.length) + (rows.length === 1 ? " linha" : " linhas")));
    barra.appendChild(info);
    if (cfg.exportar) {
      var ex = el("button", "btn-limpar", "⬇ Baixar Excel");
      ex.type = "button";
      ex.addEventListener("click", function () { exportar(rows); });
      barra.appendChild(ex);
    }
    env.appendChild(barra);

    if (cfg.totais) {
      var tt = el("div", "totais");
      cfg.totais(rows).forEach(function (t) {
        var c = el("div", "t" + (t.destaque ? " destaque" : ""));
        c.appendChild(el("div", "k", t.k)); c.appendChild(el("div", "v", t.v));
        if (t.d) c.appendChild(el("div", "d", t.d));
        tt.appendChild(c);
      });
      env.appendChild(tt);
    }

    var rol = el("div", "tabela-rolagem");
    var tb = el("table", "dados");
    var th = el("thead"), trh = el("tr");
    cfg.colunas.forEach(function (c, i) {
      var h = el("th", (numerica(c) ? "n " : "") + (st.col === i ? "ordenado" : ""), c.t);
      h.appendChild(el("span", "seta", st.col === i ? (st.dir > 0 ? "▲" : "▼") : "↕"));
      h.addEventListener("click", function () {
        if (st.col === i) st.dir = -st.dir; else { st.col = i; st.dir = numerica(c) || c.k === "data" ? -1 : 1; }
        st.pag = 1; desenhar();
      });
      trh.appendChild(h);
    });
    th.appendChild(trh); tb.appendChild(th);
    var tbody = el("tbody");
    var ini = (st.pag - 1) * tam;
    rows.slice(ini, ini + tam).forEach(function (r) {
      var tr = el("tr", cfg.classeLinha ? cfg.classeLinha(r) : "");
      cfg.colunas.forEach(function (c) {
        var td = el("td", (numerica(c) ? "n" : "") + (c.corta ? " corta" : ""));
        var t = texto(c, r);
        if (t instanceof Node) td.appendChild(t); else td.textContent = t;
        if (c.corta) td.title = t instanceof Node ? t.textContent : t;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    tb.appendChild(tbody); rol.appendChild(tb);
    if (!rows.length) rol.appendChild(el("div", "vazio", "Nada para mostrar com esses filtros."));
    env.appendChild(rol);

    if (rows.length > tam) {
      var pe = el("div", "tabela-pe");
      pe.appendChild(el("div", "info", "Mostrando " + fInt(ini + 1) + "–" + fInt(Math.min(rows.length, ini + tam)) + " de " + fInt(rows.length)));
      var pg = el("div", "paginas");
      [["«", 1, st.pag <= 1], ["‹", st.pag - 1, st.pag <= 1]].forEach(function (a) {
        var bt = el("button", null, a[0]); bt.type = "button"; bt.disabled = a[2];
        bt.addEventListener("click", function () { st.pag = a[1]; desenhar(); });
        pg.appendChild(bt);
      });
      var at = el("button", "atual", st.pag + " / " + paginas); at.disabled = true; pg.appendChild(at);
      [["›", st.pag + 1, st.pag >= paginas], ["»", paginas, st.pag >= paginas]].forEach(function (a) {
        var bt = el("button", null, a[0]); bt.type = "button"; bt.disabled = a[2];
        bt.addEventListener("click", function () { st.pag = a[1]; desenhar(); });
        pg.appendChild(bt);
      });
      pe.appendChild(pg);
      env.appendChild(pe);
    }
  }

  function exportar(rows) {
    var filtros = descricaoFiltros();
    if (st.q) filtros.push(["Busca na tabela", st.q]);
    filtros.push(["Gerado em", new Date().toLocaleString("pt-BR")]);
    filtros.push(["Linhas", fInt(rows.length)]);
    try {
      Planilha.baixar({
        arquivo: "reposicoes-" + cfg.id + "-" + E.de + "-a-" + E.ate + ".xlsx",
        titulo: cfg.exportar,
        aba: cfg.exportar,
        filtros: filtros,
        colunas: cfg.colunas.map(function (c) {
          return { titulo: c.t, tipo: c.k, somar: c.somar, valor: function (r) { return c.v(r); } };
        }),
        linhas: rows
      });
    } catch (e) {
      alert("Não consegui gerar a planilha: " + (e && e.message ? e.message : e));
    }
  }

  desenhar();
  return env;
}

/* ---------------------------------------------------------------------------
 * Gráficos (SVG à mão: sem biblioteca, sem rede)
 * ------------------------------------------------------------------------ */
function areaDe(box) { return Math.max(box.clientWidth || 0, 300); }

function ticks(max, n) {
  n = n || 4;
  var raw = (max || 1) / n, mag = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / mag;
  var step = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * mag;
  var top = Math.ceil(max / step - 1e-9) * step, t = [];
  for (var v = 0; v <= top + step * 1e-6; v += step) t.push(v);
  return t;
}

/* Rótulo que não cabe não aparece: guarda as caixas já usadas e recusa as que colidem. */
function Colisao() {
  var caixas = [];
  return function (cx, cy, w, h) {
    var a = { x1: cx - w / 2, x2: cx + w / 2, y1: cy - h / 2, y2: cy + h / 2 };
    for (var i = 0; i < caixas.length; i++) {
      var b = caixas[i];
      if (a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1) return false;
    }
    caixas.push(a);
    return true;
  };
}

/* barras empilhadas, com o total em cima de cada coluna */
function graficoBarras(box, c) {
  var n = c.cats.length, H = c.altura || 310, mL = 64, mR = 16, mT = 32, mB = 40;
  if (c.ref) mR = 18 + c.ref.rot.length * 6.4;
  var W0 = areaDe(box), W = Math.max(W0, mL + mR + n * 60);
  var slot = (W - mL - mR) / n;
  var totais = c.cats.map(function (_, i) { return c.series.reduce(function (s, se) { return s + (se.valores[i] || 0); }, 0); });
  var max = Math.max.apply(null, totais.concat([c.ref ? c.ref.valor : 0, 1]));
  var tk = ticks(max, 4), top = tk[tk.length - 1];
  var y = function (v) { return mT + (H - mT - mB) * (1 - v / top); };
  var svg = S("svg", { width: W, height: H, viewBox: "0 0 " + W + " " + H, role: "img" });

  tk.forEach(function (t) {
    svg.appendChild(S("line", { x1: mL, x2: W - mR, y1: y(t), y2: y(t), "class": "grade" }));
    svg.appendChild(S("text", { x: mL - 8, y: y(t) + 3.5, "text-anchor": "end", "class": "eixo" }, c.fmtEixo(t)));
  });

  var bw = Math.min(54, slot * 0.66);
  c.cats.forEach(function (cat, i) {
    var g = S("g", { "class": "col" });
    var dica = [cat.dica || cat.rot];
    c.series.forEach(function (se) { if (se.valores[i]) dica.push(se.nome + ": " + c.fmtCheio(se.valores[i])); });
    dica.push("Total: " + c.fmtCheio(totais[i]));
    g.appendChild(S("title", {}, dica.join("\n")));
    var x = mL + slot * i + (slot - bw) / 2, acum = 0;
    c.series.forEach(function (se) {
      var v = se.valores[i] || 0;
      if (v <= 0) return;
      var y1 = y(acum + v), y0 = y(acum), h = y0 - y1;
      g.appendChild(S("rect", { x: x, y: y1, width: bw, height: Math.max(h, 0.6), rx: 2, fill: se.cor, "class": "barra" }));
      if (h >= 15 && bw >= 38) {
        g.appendChild(S("text", { x: x + bw / 2, y: y1 + h / 2 + 3.5, "text-anchor": "middle", "class": "rot-seg", fill: se.txt || "#0b1020" }, c.fmtSeg(v)));
      }
      acum += v;
    });
    if (totais[i] > 0) g.appendChild(S("text", { x: x + bw / 2, y: y(totais[i]) - 7, "text-anchor": "middle", "class": "rot-total" }, c.fmtSeg(totais[i])));
    g.appendChild(S("text", { x: x + bw / 2, y: H - mB + 18, "text-anchor": "middle", "class": "eixo-x" }, cat.rot));
    svg.appendChild(g);
  });

  if (c.ref && c.ref.valor > 0) {
    svg.appendChild(S("line", { x1: mL, x2: W - mR + 4, y1: y(c.ref.valor), y2: y(c.ref.valor), stroke: "var(--ouro)", "stroke-width": 1.6, "stroke-dasharray": "6 5", opacity: 0.9 }));
    svg.appendChild(S("text", { x: W - mR + 9, y: y(c.ref.valor) + 4, "text-anchor": "start", "class": "rot-linha", fill: "var(--ouro-forte)" }, c.ref.rot));
  }
  box.appendChild(svg);
}

/* linhas com marcadores e rótulo em cada ponto */
function graficoLinhas(box, c) {
  var n = c.cats.length, H = c.altura || 300, mL = 64, mR = 22, mT = 30, mB = 40;
  if (c.ref) mR = 24 + c.ref.rot.length * 6.4;
  var W0 = areaDe(box), W = Math.max(W0, mL + mR + n * 52);
  var slot = (W - mL - mR) / n;
  var tk = c.ticks, lo = tk[0], hi = tk[tk.length - 1];
  var y = function (v) { return mT + (H - mT - mB) * (1 - (v - lo) / (hi - lo)); };
  var x = function (i) { return mL + slot * i + slot / 2; };
  var svg = S("svg", { width: W, height: H, viewBox: "0 0 " + W + " " + H, role: "img" });
  tk.forEach(function (t) {
    svg.appendChild(S("line", { x1: mL, x2: W - mR, y1: y(t), y2: y(t), "class": "grade" }));
    svg.appendChild(S("text", { x: mL - 8, y: y(t) + 3.5, "text-anchor": "end", "class": "eixo" }, c.fmtEixo(t)));
  });
  c.cats.forEach(function (cat, i) {
    svg.appendChild(S("text", { x: x(i), y: H - mB + 18, "text-anchor": "middle", "class": "eixo-x" }, cat.rot));
  });
  if (c.ref != null) {
    svg.appendChild(S("line", { x1: mL, x2: W - mR + 4, y1: y(c.ref.valor), y2: y(c.ref.valor), stroke: "var(--ouro)", "stroke-width": 1.6, "stroke-dasharray": "6 5", opacity: 0.9 }));
    svg.appendChild(S("text", { x: W - mR + 9, y: y(c.ref.valor) + 4, "text-anchor": "start", "class": "rot-linha", fill: "var(--ouro-forte)" }, c.ref.rot));
  }
  var cabe = Colisao();
  c.series.forEach(function (se) {
    var d = "", ant = false;
    se.valores.forEach(function (v, i) {
      if (v == null) { ant = false; return; }
      d += (ant ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1);
      ant = true;
    });
    svg.appendChild(S("path", { d: d, fill: "none", stroke: se.cor, "stroke-width": se.larg || 2.6, "stroke-linejoin": "round", "stroke-linecap": "round", "stroke-dasharray": se.tracejado ? "5 5" : "none", opacity: se.opaco || 1 }));
  });
  c.series.forEach(function (se) {
    se.valores.forEach(function (v, i) {
      if (v == null) return;
      var g = S("g", { "class": "col" });
      g.appendChild(S("title", {}, (se.nome ? se.nome + " · " : "") + c.cats[i].rot + ": " + c.fmtCheio(v)));
      g.appendChild(S("circle", { cx: x(i), cy: y(v), r: 4, fill: "var(--navy-900)", stroke: se.cor, "stroke-width": 2.4, "class": "pt" }));
      var txt = c.fmt(v), w = txt.length * 6.3 + 4;
      var ehUltimo = i === se.valores.length - 1 || se.valores.slice(i + 1).every(function (z) { return z == null; });
      var mostrar = se.rotulos === "todos" || (se.rotulos === "fim" && ehUltimo);
      if (mostrar) {
        var ly = se.rotulos === "fim" || se.abaixo ? y(v) + 17 : y(v) - 10;
        if (cabe(x(i), ly - 3, w, 12)) {
          g.appendChild(S("text", { x: x(i), y: ly, "text-anchor": "middle", "class": "rot-linha", fill: se.corTxt || se.cor }, txt));
        }
      }
      svg.appendChild(g);
    });
  });
  box.appendChild(svg);
}

function legenda(itens) {
  var l = el("div", "glegenda");
  itens.forEach(function (i) {
    var s = el("span");
    var ic = el("i", i.linha ? "linha" : "");
    ic.style.background = i.cor;
    if (i.tracejado) { ic.style.background = "repeating-linear-gradient(90deg," + i.cor + " 0 5px,transparent 5px 9px)"; }
    s.appendChild(ic);
    s.appendChild(document.createTextNode(i.nome));
    l.appendChild(s);
  });
  return l;
}

/* ---------------------------------------------------------------------------
 * Páginas
 * ------------------------------------------------------------------------ */
var COR = {
  com: "#5f7ef5", sem: "#d3a344",
  motivos: ["#5f7ef5", "#d3a344", "#a58cee", "#25b581"],
  txtMotivos: ["#ffffff", "#0b1020", "#0b1020", "#0b1020"],
  demais: "#7c92be", semChamado: "#3d4f78"
};

function notaParcial(meses) {
  var parc = meses.filter(mesParcial);
  if (!parc.length) return null;
  var d = el("div", "rodape-grafico");
  d.innerHTML = "<b>*</b> mês parcial: dado de " + (parc[0] === E.de.slice(0, 7) && E.de > parc[0] + "-01" && E.de !== MIND ? fData(E.de) : "01/" + parc[0].slice(5, 7)) +
    " até " + fData(E.ate < MAXD ? E.ate : MAXD) + ". A média mensal considera só meses completos.";
  return d;
}

/* ------------------------------- Visão geral ----------------------------- */
function paginaGeral(C) {
  var pg = el("div"); pg.style.display = "flex"; pg.style.flexDirection = "column"; pg.style.gap = "16px";
  var K = resumir(C.F, C.B);
  var meses = listaMeses(E.de, E.ate);
  var multiAno = meses.length > 12 || meses[0].slice(0, 4) !== meses[meses.length - 1].slice(0, 4);
  var serie = serieMensal(C.B, C.F, meses);
  var anoFim = E.ate.slice(0, 4);

  /* acumulado do ano (1º de janeiro até o fim do período) */
  var porMes = somaMensalAno();
  var acumFim = 0;
  Object.keys(porMes).forEach(function (m) { if (m.slice(0, 4) === anoFim) acumFim += porMes[m]; });
  var acumAnt = 0, ateAnt = deslocarAno(E.ate, -1);
  R.forEach(function (r) { if (r.d >= (+anoFim - 1) + "-01-01" && r.d <= ateAnt && passaSemPeriodo(r)) acumAnt += r.v; });
  var vAnt = somaPeriodo(deslocarAno(E.de, -1), deslocarAno(E.ate, -1));

  var completos = serie.filter(function (s) { return !mesParcial(s.mes); });
  var base = completos.length ? completos : serie;
  var mediaMes = base.length ? base.reduce(function (s, x) { return s + x.v; }, 0) / base.length : 0;

  /* --- cartões --- */
  var heroi = el("div", "heroi sobe");
  var hc = el("div", "heroi-card");
  hc.appendChild(el("div", "rot", "Total reposto no período"));
  var hv = el("div", "valor", fBRL(K.v)); hv.title = fMil(K.v);
  hc.appendChild(hv);
  var sub = el("div", "sub");
  sub.innerHTML = "<b>" + fInt(K.ped) + "</b> reposições · " + fInt(K.itens) + " itens · ticket médio <b>" + fBRL(K.ped ? K.v / K.ped : 0) + "</b>";
  hc.appendChild(sub);
  var dl = el("div", "sub"); dl.style.marginTop = "12px";
  dl.appendChild(delta(K.v, vAnt, "mesmo período de " + (+anoFim - 1)));
  hc.appendChild(dl);
  heroi.appendChild(hc);

  var lado = el("div", "heroi-lado");
  lado.appendChild(kpi("ouro", "Acumulado em " + anoFim, fBRL(acumFim),
    el("span", null, "de 01/01 até " + fData(E.ate < MAXD ? E.ate : MAXD)), "Soma de 1º de janeiro até o fim do período, respeitando os filtros de motivo, chamado, motorista e filial — o filtro de início não corta o acumulado."));
  var kAcum = lado.lastChild.querySelector(".sub");
  kAcum.appendChild(document.createTextNode(" · "));
  kAcum.appendChild(delta(acumFim, acumAnt, String(+anoFim - 1)));
  lado.appendChild(kpi("info", "Reposições com chamado", fPct(K.pctPed),
    fInt(K.pedCom) + " de " + fInt(K.pedB) + " reposições · " + fPct(K.pctVal) + " do valor",
    "Uma reposição (pedido) conta como COM chamado se ao menos um item dela tem chamado ligado. A ligação usa a NF citada na observação do pedido e o produto reposto. O percentual de valor é medido por item."));
  lado.appendChild(kpi("atencao", "Reposições sem chamado", fInt(K.pedSem),
    fBRL(K.vSem) + " repostos sem chamado",
    "Pedido de reposição que não tem nenhum chamado ligado: nem pelo produto, nem pela NF."));
  lado.appendChild(kpi("", "Média mensal", fBRL(mediaMes), "meses completos do período"));
  heroi.appendChild(lado);
  pg.appendChild(heroi);

  var ks = el("div", "kpis sobe");
  ks.appendChild(kpi("", "Unidades repostas", fQtd(K.q), fInt(K.itens) + " itens distintos"));
  ks.appendChild(kpi("", "Clientes atendidos", fInt(K.clientes), "com ao menos uma reposição"));
  ks.appendChild(kpi("", "Chamados ligados", fInt(K.chamados), fQtd(K.qr) + " unid. reclamadas"));
  ks.appendChild(kpi("", "Chamado → reposição", K.lagMed == null ? "—" : fQtd(K.lagMed) + (K.lagMed === 1 ? " dia" : " dias"),
    "mediana entre abrir o chamado e repor", "Dias entre a abertura do chamado e a data do pedido de reposição. Valor 0 = repôs no mesmo dia."));
  pg.appendChild(ks);

  if (!C.F.length) { pg.appendChild(painel("Sem dados", null, vazioFiltro())); return pg; }

  /* --- R$ mês a mês, com × sem chamado --- */
  var cats = serie.map(function (s) {
    var parc = mesParcial(s.mes);
    return { rot: rotMes(s.mes, multiAno) + (parc ? "*" : ""), dica: MESES_LONGO[+s.mes.slice(5, 7) - 1] + "/" + s.mes.slice(0, 4) + (parc ? " (parcial)" : "") };
  });
  var b1 = el("div", "gbox");
  noGrafico(b1, function (box) {
    graficoBarras(box, {
      cats: cats,
      series: [
        { nome: "Com chamado", cor: COR.com, txt: "#ffffff", valores: serie.map(function (s) { return s.vCom; }) },
        { nome: "Sem chamado", cor: COR.sem, txt: "#0b1020", valores: serie.map(function (s) { return s.vSem; }) }
      ],
      fmtEixo: fMil, fmtSeg: fMilCurto, fmtCheio: fBRL,
      ref: mediaMes ? { valor: mediaMes, rot: "Média " + fMil(mediaMes) } : null
    });
  });
  var corpo1 = el("div");
  corpo1.appendChild(b1);
  corpo1.appendChild(legenda([{ nome: "Com chamado", cor: COR.com }, { nome: "Sem chamado", cor: COR.sem }, { nome: "Média mensal", cor: "var(--ouro)", linha: true, tracejado: true }]));
  var np = notaParcial(meses); if (np) corpo1.appendChild(np);
  pg.appendChild(painel("Reposições mês a mês (R$)",
    "Valor reposto em cada mês, separado entre reposições com e sem chamado. Total em cima de cada coluna.", corpo1));

  /* --- acumulado do ano + % com chamado --- */
  var anos = [];
  for (var a = +E.de.slice(0, 4) - 1; a <= +anoFim; a++) {
    if (R.some(function (r) { return r.mes.slice(0, 4) === String(a); })) anos.push(a);
  }
  if (anos.length > 3) anos = anos.slice(anos.length - 3);
  var coresAno = [ "#7c92be", "#5f7ef5", "#d3a344" ];
  var b2 = el("div", "gbox");
  noGrafico(b2, function (box) {
    var catsAno = MESES.map(function (m) { return { rot: m }; });
    var series = anos.map(function (an, ix) {
      var acum = 0, vals = [], atual = an === +anoFim;
      for (var m = 1; m <= 12; m++) {
        var ym = an + "-" + String(m).padStart(2, "0");
        var corte = atual ? E.ate.slice(0, 7) : null;
        if (atual && ym > corte) { vals.push(null); continue; }
        if (!atual && an > +anoFim) { vals.push(null); continue; }
        // mês sem nenhuma linha no dado: não existe ainda (ano em curso)
        if (an === +MAXD.slice(0, 4) && ym > MAXD.slice(0, 7)) { vals.push(null); continue; }
        acum += porMes[ym] || 0;
        vals.push(acum);
      }
      var cor = coresAno[Math.min(ix + (3 - anos.length), 2)];
      return { nome: String(an), cor: atual ? "#d3a344" : cor, valores: vals, rotulos: atual ? "todos" : "fim", abaixo: !atual, tracejado: !atual, larg: atual ? 3 : 2, opaco: atual ? 1 : 0.85, corTxt: atual ? "#f5dea0" : "#aec0e2" };
    });
    var max = Math.max.apply(null, series.reduce(function (s, x) { return s.concat(x.valores.filter(function (v) { return v != null; })); }, [1]));
    graficoLinhas(box, { cats: catsAno, series: series, ticks: ticks(max, 4), fmtEixo: fMil, fmt: fMilCurto, fmtCheio: fBRL });
  });
  var corpo2 = el("div");
  corpo2.appendChild(b2);
  corpo2.appendChild(legenda(anos.map(function (an) { return { nome: String(an), cor: an === +anoFim ? "#d3a344" : "#7c92be", linha: true, tracejado: an !== +anoFim }; })));
  pg.appendChild(painel("Acumulado no ano (R$)", "Soma corrida de janeiro até cada mês, comparada ao ano anterior.", corpo2));

  var pcts = serie.map(function (s) { return s.pct; });
  var b3 = el("div", "gbox");
  noGrafico(b3, function (box) {
    var validos = pcts.filter(function (p) { return p != null; });
    var mn = Math.min.apply(null, validos.concat([K.pctPed])), piso = Math.max(0, Math.floor((mn - 0.06) * 10) / 10);
    var tk = []; for (var t = piso; t <= 1.0001; t += 0.1) tk.push(Math.round(t * 100) / 100);
    graficoLinhas(box, {
      cats: cats, ticks: tk, fmtEixo: function (v) { return Math.round(v * 100) + "%"; }, fmt: function (v) { return nf1.format(v * 100) + "%"; }, fmtCheio: function (v) { return nf1.format(v * 100) + "%"; },
      series: [{ nome: "% com chamado", cor: COR.com, valores: pcts, rotulos: "todos", corTxt: "#aebdff" }],
      ref: { valor: K.pctPed, rot: "Média " + fPct(K.pctPed) }
    });
  });
  var corpo3 = el("div");
  corpo3.appendChild(b3);
  var anosBox = el("div", "anos");
  mediaAnual().forEach(function (x) {
    var c = el("div", "ano");
    c.appendChild(el("div", "k", "Média " + x.ano + (x.ano === MAXD.slice(0, 4) ? " (até " + fData(x.ate).slice(0, 5) + ")" : "")));
    c.appendChild(el("div", "v", fPct(x.pct)));
    c.appendChild(el("div", "d", fInt(x.com) + " de " + fInt(x.ped) + " reposições"));
    anosBox.appendChild(c);
  });
  var np3 = notaParcial(meses); if (np3) { np3.firstChild && (np3.innerHTML = "<b>*</b> mês parcial: o percentual de um mês em andamento ainda vai mudar quando os chamados forem abertos."); corpo3.appendChild(np3); }
  corpo3.appendChild(anosBox);
  pg.appendChild(painel("% de reposições com chamado",
    "Evolução mensal. Reposição sem chamado = campo de chamado vazio. A linha tracejada é a média do período.", corpo3));

  /* --- principais motivos e clientes --- */
  var tres = el("div", "duas");
  var gm = agrupar(C.F.filter(function (r) { return r.m >= 0; }), function (r) { return r.m; }).sort(function (a, b) { return b.v - a.v; });
  var totalV = K.v || 1;
  tres.appendChild(painel("Principais motivos (R$)", "Os 8 maiores. A lista completa está em Motivos.",
    gm.length ? rank(gm.slice(0, 8).map(function (g, i) {
      return { nome: nomeMotivo(g.k), valor: g.v, texto: fMil(g.v), sub: fPct(g.v / totalV) + " · " + fInt(g.ped.size) + " rep.", cor: i < 4 ? COR.motivos[i] : COR.demais, tip: fBRL(g.v) };
    }), true) : el("div", "vazio", "Sem chamados no recorte.")));
  var gc = agrupar(C.F, function (r) { return r.c; }).sort(function (a, b) { return b.v - a.v; });
  tres.appendChild(painel("Clientes que mais recebem reposição (R$)", "Os 8 maiores do período.",
    rank(gc.slice(0, 8).map(function (g) {
      return { nome: nomeCliente(g.k), valor: g.v, texto: fMil(g.v), sub: fInt(g.ped.size) + " rep.", cor: "var(--viz-1)", tip: fBRL(g.v) };
    }), true)));
  pg.appendChild(tres);
  return pg;
}

/* --------------------------------- Motivos -------------------------------- */
function paginaMotivos(C) {
  var pg = el("div"); pg.style.display = "flex"; pg.style.flexDirection = "column"; pg.style.gap = "16px";
  if (!C.F.length) { pg.appendChild(painel("Sem dados", null, vazioFiltro())); return pg; }
  var K = resumir(C.F, C.B);
  var comMotivo = C.F.filter(function (r) { return r.m >= 0; });
  var semMotivo = C.F.filter(function (r) { return r.m < 0; });
  var gm = agrupar(comMotivo, function (r) { return r.m; }).sort(function (a, b) { return b.v - a.v; });
  var vSem = semMotivo.reduce(function (s, r) { return s + r.v; }, 0);
  var total = K.v || 1;

  var ks = el("div", "kpis sobe");
  ks.appendChild(kpi("ouro", "Motivos distintos", fInt(gm.length), "no recorte de filtros"));
  ks.appendChild(kpi("info", "Principal motivo", gm.length ? nomeMotivo(gm[0].k) : "—", gm.length ? fBRL(gm[0].v) + " · " + fPct(gm[0].v / total) : ""));
  ks.lastChild.querySelector(".val").style.fontSize = "15px";
  ks.lastChild.querySelector(".val").style.whiteSpace = "normal";
  ks.appendChild(kpi("", "Valor com motivo", fBRL(K.vCom), fPct(K.v ? K.vCom / K.v : 0) + " do reposto"));
  ks.appendChild(kpi("atencao", "Valor sem chamado", fBRL(vSem), fPct(K.v ? vSem / K.v : 0) + " do reposto · sem motivo"));
  pg.appendChild(ks);

  var itensRank = gm.slice(0, 12).map(function (g, i) {
    return { nome: nomeMotivo(g.k), valor: g.v, texto: fMil(g.v), sub: fPct(g.v / total) + " · " + fInt(g.ped.size) + " rep.", cor: i < 4 ? COR.motivos[i] : COR.demais, tip: fBRL(g.v) };
  });
  if (gm.length > 12) {
    var resto = gm.slice(12).reduce(function (s, g) { return s + g.v; }, 0);
    itensRank.push({ nome: "Demais " + (gm.length - 12) + " motivos", valor: resto, texto: fMil(resto), sub: fPct(resto / total), cor: COR.demais, tip: fBRL(resto) });
  }
  if (vSem > 0) itensRank.push({ nome: "Sem chamado (sem motivo)", valor: vSem, texto: fMil(vSem), sub: fPct(vSem / total), cor: COR.semChamado, tip: fBRL(vSem) });
  pg.appendChild(painel("Motivos que mais geram reposição (R$)", "Valor reposto por motivo do chamado. O pedido é repartido entre os motivos dos seus itens — a soma fecha com o total.", rank(itensRank)));

  /* evolução mensal dos 4 maiores */
  var meses = listaMeses(E.de, E.ate);
  var multiAno = meses.length > 12 || meses[0].slice(0, 4) !== meses[meses.length - 1].slice(0, 4);
  var top = gm.slice(0, 4).map(function (g) { return g.k; });
  var idx = {}; meses.forEach(function (m, i) { idx[m] = i; });
  function zeros() { return meses.map(function () { return 0; }); }
  var sTop = top.map(function () { return zeros(); }), sDem = zeros(), sSem = zeros();
  C.F.forEach(function (r) {
    var i = idx[r.mes]; if (i == null) return;
    if (r.m < 0) { sSem[i] += r.v; return; }
    var t = top.indexOf(r.m);
    if (t >= 0) sTop[t][i] += r.v; else sDem[i] += r.v;
  });
  var series = top.map(function (k, t) { return { nome: nomeMotivo(k), cor: COR.motivos[t], txt: COR.txtMotivos[t], valores: sTop[t] }; });
  series.push({ nome: "Demais motivos", cor: COR.demais, txt: "#0b1020", valores: sDem });
  series.push({ nome: "Sem chamado", cor: COR.semChamado, txt: "#ffffff", valores: sSem });
  var b = el("div", "gbox");
  noGrafico(b, function (box) {
    graficoBarras(box, {
      cats: meses.map(function (m) { return { rot: rotMes(m, multiAno) + (mesParcial(m) ? "*" : ""), dica: MESES_LONGO[+m.slice(5, 7) - 1] + "/" + m.slice(0, 4) }; }),
      series: series, fmtEixo: fMil, fmtSeg: fMilCurto, fmtCheio: fBRL, altura: 340
    });
  });
  var corpo = el("div"); corpo.appendChild(b);
  corpo.appendChild(legenda(series.map(function (s) { return { nome: s.nome, cor: s.cor }; })));
  var np = notaParcial(meses); if (np) corpo.appendChild(np);
  pg.appendChild(painel("Evolução mensal por motivo (R$)", "Os 4 maiores motivos do recorte; o resto agrupado. “Sem chamado” é o valor reposto sem motivo.", corpo));

  /* tabela completa */
  var linhas = gm.map(function (g) { return { motivo: nomeMotivo(g.k), g: g, sem: false }; });
  if (vSem > 0) {
    var gs = agrupar(semMotivo, function () { return 1; })[0];
    linhas.push({ motivo: "(Sem chamado)", g: gs, sem: true });
  }
  pg.appendChild(painel("Todos os motivos", "Clique no título da coluna para ordenar. “Reposições” conta pedidos distintos.",
    tabela({
      id: "motivos", exportar: "Motivos", busca: "Buscar motivo…", tam: 15, ordem: [1, -1],
      linhas: linhas, classeLinha: function (r) { return r.sem ? "sem-chamado-linha" : ""; },
      colunas: [
        { t: "Motivo", k: "texto", v: function (r) { return r.motivo; }, corta: true },
        { t: "Valor (R$)", k: "moeda", v: function (r) { return r.g.v; } },
        { t: "% do total", k: "percentual", v: function (r) { return r.g.v / total * 100; }, somar: false },
        { t: "Reposições", k: "inteiro", v: function (r) { return r.g.ped.size; }, somar: false },
        { t: "Itens", k: "inteiro", v: function (r) { return r.g.it.size; }, somar: false },
        { t: "Unid. repostas", k: "inteiro", v: function (r) { return r.g.q; } },
        { t: "Unid. reclamadas", k: "inteiro", v: function (r) { return r.sem ? null : r.g.qr; } },
        { t: "Chamados", k: "inteiro", v: function (r) { return r.sem ? null : r.g.cham.size; }, somar: false },
        { t: "Ticket médio (R$)", k: "moeda", v: function (r) { return r.g.ped.size ? r.g.v / r.g.ped.size : 0; } }
      ]
    })));
  return pg;
}

/* ---------------------------------- Itens -------------------------------- */
function paginaItens(C) {
  var pg = el("div"); pg.style.display = "flex"; pg.style.flexDirection = "column"; pg.style.gap = "16px";
  if (!C.F.length) { pg.appendChild(painel("Sem dados", null, vazioFiltro())); return pg; }
  var porFornec = E.itensVisao === "fornecedor";
  var grupos = agrupar(C.F, function (r) { return porFornec ? (r.fo < 0 ? null : r.fo) : r.p; });
  var nomeG = function (g) { return porFornec ? nomeFornecedor(g.k) : nomeProduto(g.k); };

  var cab = el("div", "filtros");
  var seg = el("div", "seg");
  [["produto", "Itens (produtos)"], ["fornecedor", "Fornecedores"]].forEach(function (o) {
    var b = el("button", E.itensVisao === o[0] ? "on" : "", o[1]); b.type = "button";
    b.addEventListener("click", function () { E.itensVisao = o[0]; E.T.itens = null; desenhar(); });
    seg.appendChild(b);
  });
  cab.appendChild(el("span", "frot", "Agrupar por")); cab.appendChild(seg);
  pg.appendChild(cab);

  var tres = el("div", "tres");
  function topo(titulo, sub, chave, fmtTxt, fmtSub, cor) {
    var ord = grupos.slice().sort(function (a, b) { return chave(b) - chave(a); }).slice(0, 10);
    return painel(titulo, sub, rank(ord.map(function (g) {
      return { nome: nomeG(g), valor: chave(g), texto: fmtTxt(g), sub: fmtSub(g), cor: cor, tip: nomeG(g) };
    }), true));
  }
  tres.appendChild(topo("Maior valor (R$)", "Top 10 por valor reposto.", function (g) { return g.v; }, function (g) { return fMil(g.v); }, function (g) { return fQtd(g.q) + " unid."; }, "var(--viz-1)"));
  tres.appendChild(topo("Maior volume (unidades)", "Top 10 por unidades repostas.", function (g) { return g.q; }, function (g) { return fQtd(g.q) + " un."; }, function (g) { return fMil(g.v); }, "var(--viz-3)"));
  tres.appendChild(topo("Mais recorrentes (reposições)", "Top 10 por nº de reposições em que aparece.", function (g) { return g.ped.size; }, function (g) { return fInt(g.ped.size) + " rep."; }, function (g) { return fInt(g.meses.size) + " meses"; }, "var(--viz-4)"));
  pg.appendChild(tres);

  var nMeses = listaMeses(E.de, E.ate).length;
  var linhas = grupos;
  var colunas = [
    { t: porFornec ? "Fornecedor" : "Item", k: "texto", v: function (g) { return nomeG(g); }, corta: true }
  ];
  if (!porFornec) {
    colunas.push({ t: "Código", k: "texto", v: function (g) { return String(codProduto(g.k)); } });
    colunas.push({ t: "Fornecedor", k: "texto", v: function (g) {
      var f = D.dims.produtos[g.k][2]; return f == null ? "" : nomeFornecedor(f);
    }, corta: true });
  } else {
    colunas.push({ t: "Itens distintos", k: "inteiro", v: function (g) { return new Set(Array.from(g.it).map(function (k) { return k.split("/")[1]; })).size; }, somar: false });
  }
  colunas.push(
    { t: "Valor (R$)", k: "moeda", v: function (g) { return g.v; } },
    { t: "Unidades", k: "inteiro", v: function (g) { return g.q; } },
    { t: "Reposições", k: "inteiro", v: function (g) { return g.ped.size; }, somar: false },
    { t: "Clientes", k: "inteiro", v: function (g) { return g.cli.size; }, somar: false },
    { t: "Meses com reposição (de " + nMeses + ")", k: "inteiro", v: function (g) { return g.meses.size; }, somar: false },
    { t: "Com chamado (%)", k: "percentual", v: function (g) { return g.v ? g.vCom / g.v * 100 : 0; }, somar: false },
    { t: "Média por reposição (R$)", k: "moeda", v: function (g) { return g.ped.size ? g.v / g.ped.size : 0; } }
  );
  pg.appendChild(painel(porFornec ? "Todos os fornecedores" : "Todos os itens",
    "Valor, volume e recorrência juntos. Ordene pela coluna que interessa; a busca olha nome, código e fornecedor.",
    tabela({ id: "itens-" + E.itensVisao, exportar: porFornec ? "Fornecedores" : "Itens", busca: porFornec ? "Buscar fornecedor…" : "Buscar item, código ou fornecedor…", tam: 20, ordem: [colunas.length - 7 + (porFornec ? 0 : 0), -1], linhas: linhas, colunas: colunas })));
  return pg;
}

/* -------------------------------- Motoristas ------------------------------ */
function paginaMotoristas(C) {
  var pg = el("div"); pg.style.display = "flex"; pg.style.flexDirection = "column"; pg.style.gap = "16px";
  var comMot = C.F.filter(function (r) { return r.mo >= 0; });
  if (!comMot.length) {
    pg.appendChild(painel("Motoristas", "Só as reposições com chamado trazem o motorista.", el("div", "vazio-filtro", "Nenhuma reposição com chamado e motorista nesses filtros.")));
    return pg;
  }
  var gm = agrupar(comMot, function (r) { return r.mo; });
  gm.forEach(function (g) {
    var porMotivo = {};
    comMot.forEach(function (r) { if (r.mo === g.k && r.m >= 0) porMotivo[r.m] = (porMotivo[r.m] || 0) + r.v; });
    var melhor = null;
    Object.keys(porMotivo).forEach(function (m) { if (melhor == null || porMotivo[m] > porMotivo[melhor]) melhor = m; });
    g.motivo = melhor == null ? "" : nomeMotivo(+melhor);
  });
  var totalV = gm.reduce(function (s, g) { return s + g.v; }, 0) || 1;

  var ks = el("div", "kpis sobe");
  ks.appendChild(kpi("ouro", "Motoristas com chamado", fInt(gm.length), "no recorte de filtros"));
  var porCh = gm.slice().sort(function (a, b) { return b.cham.size - a.cham.size; })[0];
  ks.appendChild(kpi("info", "Mais chamados", nomeMotorista(porCh.k), fInt(porCh.cham.size) + " chamados · " + fBRL(porCh.v)));
  ks.lastChild.querySelector(".val").style.fontSize = "15px"; ks.lastChild.querySelector(".val").style.whiteSpace = "normal";
  var porVal = gm.slice().sort(function (a, b) { return b.v - a.v; })[0];
  ks.appendChild(kpi("atencao", "Maior valor reposto", nomeMotorista(porVal.k), fBRL(porVal.v) + " · " + fPct(porVal.v / totalV) + " do total"));
  ks.lastChild.querySelector(".val").style.fontSize = "15px"; ks.lastChild.querySelector(".val").style.whiteSpace = "normal";
  ks.appendChild(kpi("", "Chamados no recorte", fInt(new Set(comMot.map(function (r) { return r.ch; })).size), "com motorista identificado"));
  pg.appendChild(ks);

  var duas = el("div", "duas");
  var topC = gm.slice().sort(function (a, b) { return b.cham.size - a.cham.size; }).slice(0, 12);
  duas.appendChild(painel("Mais chamados que viraram reposição", "Quantidade de chamados distintos por motorista. Ranking absoluto: o painel não tem o total de entregas de cada um.",
    rank(topC.map(function (g) { return { nome: nomeMotorista(g.k), valor: g.cham.size, texto: fInt(g.cham.size), sub: fMil(g.v), cor: "var(--viz-1)", tip: g.motivo }; }))));
  var topV = gm.slice().sort(function (a, b) { return b.v - a.v; }).slice(0, 12);
  duas.appendChild(painel("Maior valor reposto (R$)", "Soma do valor das reposições ligadas aos chamados do motorista.",
    rank(topV.map(function (g) { return { nome: nomeMotorista(g.k), valor: g.v, texto: fMil(g.v), sub: fPct(g.v / totalV), cor: "var(--viz-2-luz)", tip: fBRL(g.v) }; }))));
  pg.appendChild(duas);

  pg.appendChild(painel("Todos os motoristas", "Cada chamado pertence a um motorista; a reposição herda o motorista do chamado que a causou.",
    tabela({
      id: "motoristas", exportar: "Motoristas", busca: "Buscar motorista ou motivo…", tam: 20, ordem: [2, -1], linhas: gm,
      colunas: [
        { t: "Motorista", k: "texto", v: function (g) { return nomeMotorista(g.k); }, corta: true },
        { t: "Código", k: "texto", v: function (g) { return String(D.dims.motoristas[g.k][0]); } },
        { t: "Chamados", k: "inteiro", v: function (g) { return g.cham.size; }, somar: false },
        { t: "Reposições", k: "inteiro", v: function (g) { return g.ped.size; }, somar: false },
        { t: "Valor (R$)", k: "moeda", v: function (g) { return g.v; } },
        { t: "% do total", k: "percentual", v: function (g) { return g.v / totalV * 100; }, somar: false },
        { t: "Unid. reclamadas", k: "inteiro", v: function (g) { return g.qr; } },
        { t: "Principal motivo", k: "texto", v: function (g) { return g.motivo; }, corta: true }
      ]
    })));
  return pg;
}

/* --------------------------------- Detalhe -------------------------------- */
function paginaDetalhe(C) {
  var pg = el("div");
  var K = resumir(C.F, C.B);
  pg.appendChild(painel("Linha a linha", "Cada linha é um item de uma reposição ligado ao chamado que a causou (ou sem chamado). O valor é a parte do pedido que cabe àquela linha.",
    tabela({
      id: "detalhe", exportar: "Detalhe das reposições", busca: "Buscar cliente, produto, pedido, NF, chamado, motivo, motorista…", tam: 25, ordem: [0, -1],
      linhas: C.F,
      totais: function (rows) {
        var ped = new Set(), v = 0, q = 0;
        rows.forEach(function (r) { ped.add(r.pd); v += r.v; q += r.q; });
        return [{ k: "Valor das linhas", v: fBRL(v), destaque: true }, { k: "Reposições", v: fInt(ped.size) }, { k: "Unidades repostas", v: fQtd(q) }];
      },
      colunas: [
        { t: "Data", k: "data", v: function (r) { return r.d; } },
        { t: "Filial", k: "texto", v: function (r) { return String(r.f); } },
        { t: "Pedido", k: "texto", v: function (r) { return String(r.pd); } },
        { t: "NF reposição", k: "texto", v: function (r) { return r.nf ? String(r.nf) : ""; } },
        { t: "Cliente", k: "texto", v: function (r) { return nomeCliente(r.c); }, corta: true },
        { t: "Produto", k: "texto", v: function (r) { return nomeProduto(r.p); }, corta: true },
        { t: "Unid.", k: "inteiro", v: function (r) { return r.q; } },
        { t: "Valor (R$)", k: "moeda", v: function (r) { return r.v; } },
        { t: "Chamado", k: "texto", v: function (r) { return r.ch ? String(r.ch) : ""; } },
        { t: "Aberto em", k: "data", v: function (r) { return r.da ? r.da.slice(0, 10) : null; } },
        { t: "Motivo", k: "texto", v: function (r) { return r.m >= 0 ? nomeMotivo(r.m) : "(sem chamado)"; }, corta: true },
        { t: "Motorista", k: "texto", v: function (r) { return r.mo >= 0 ? nomeMotorista(r.mo) : ""; }, corta: true },
        { t: "Un. reclamadas", k: "inteiro", v: function (r) { return r.ch && r.qr ? r.qr : null; }, somar: false },
        { t: "NF de referência", k: "texto", v: function (r) { return r.nr ? String(r.nr) : ""; } },
        { t: "Ligação", k: "texto", v: function (r) { return r.vi === 1 ? "produto + NF" : r.vi === 2 ? "só NF" : ""; } },
        { t: "Lançado por", k: "texto", v: function (r) { return nomeEmitente(r.e); }, corta: true }
      ]
    })));
  return pg;
}

/* ---------------------------------------------------------------------------
 * Filtros (barra) e navegação
 * ------------------------------------------------------------------------ */
var REF = {};   // referências aos controles da barra, para sincronizar sem reconstruir

function construirFiltros() {
  var raiz = $("filtros");
  limpar(raiz);
  var f = el("div", "filtros fixo");
  var tg = el("button", "btn-limpar filtros-toggle", "Filtros ▾"); tg.type = "button";
  tg.addEventListener("click", function () { f.classList.toggle("fechado"); tg.textContent = f.classList.contains("fechado") ? "Filtros ▾" : "Filtros ▴"; });
  f.appendChild(tg);
  if (window.innerWidth <= 640) f.classList.add("fechado");

  /* período */
  var gp = el("div", "fgrupo");
  gp.appendChild(el("span", "frot", "Período"));
  REF.presets = {};
  presets().forEach(function (p) {
    var b = el("button", "chip", p.rot); b.type = "button";
    b.addEventListener("click", function () { aplicarPreset(p.id); sincronizar(); desenhar(); });
    REF.presets[p.id] = b;
    gp.appendChild(b);
  });
  var fd = el("div", "fdatas");
  REF.de = el("input"); REF.de.type = "date"; REF.de.min = MIND; REF.de.max = MAXD; REF.de.title = "Início do período";
  REF.ate = el("input"); REF.ate.type = "date"; REF.ate.min = MIND; REF.ate.max = MAXD; REF.ate.title = "Fim do período";
  function mudouData() {
    var a = REF.de.value || MIND, b = REF.ate.value || MAXD;
    if (a > b) { var t = a; a = b; b = t; }
    E.de = a; E.ate = b; E.preset = ""; sincronizar(); desenhar();
  }
  REF.de.addEventListener("change", mudouData); REF.ate.addEventListener("change", mudouData);
  fd.appendChild(REF.de); fd.appendChild(el("span", "ate", "até")); fd.appendChild(REF.ate);
  gp.appendChild(fd);
  f.appendChild(gp);

  /* motivo */
  var gm = el("div", "fgrupo sep");
  var contaMotivo = {}, contaMot = {}, vistos = {};
  R.forEach(function (r) {
    if (r.m >= 0) { var k = r.pd + "/m" + r.m; if (!vistos[k]) { vistos[k] = 1; contaMotivo[r.m] = (contaMotivo[r.m] || 0) + 1; } }
    if (r.mo >= 0) { var k2 = r.pd + "/o" + r.mo; if (!vistos[k2]) { vistos[k2] = 1; contaMot[r.mo] = (contaMot[r.mo] || 0) + 1; } }
  });
  REF.mMotivo = multi({
    rot: "Motivo", conjunto: E.motivos, aoMudar: function () { sincronizar(); desenhar(); },
    opcoes: function () {
      return D.dims.motivos.map(function (m, i) { return { id: i, nome: m[1], qt: contaMotivo[i] || 0 }; })
        .sort(function (a, b) { return b.qt - a.qt; });
    }
  });
  gm.appendChild(REF.mMotivo);
  f.appendChild(gm);

  /* com / sem chamado */
  var gc = el("div", "fgrupo sep");
  gc.appendChild(el("span", "frot", "Chamado"));
  REF.chamado = {};
  [["todos", "Todos"], ["com", "Com chamado"], ["sem", "Sem chamado"]].forEach(function (o) {
    var b = el("button", "chip", o[1]); b.type = "button";
    b.addEventListener("click", function () { E.chamado = o[0]; sincronizar(); desenhar(); });
    REF.chamado[o[0]] = b; gc.appendChild(b);
  });
  f.appendChild(gc);

  /* motorista */
  var gmo = el("div", "fgrupo sep");
  REF.mMot = multi({
    rot: "Motorista", conjunto: E.motoristas, aoMudar: function () { sincronizar(); desenhar(); },
    opcoes: function () {
      return D.dims.motoristas.map(function (m, i) { return { id: i, nome: m[1], qt: contaMot[i] || 0 }; })
        .sort(function (a, b) { return a.nome.localeCompare(b.nome, "pt-BR"); });
    }
  });
  gmo.appendChild(REF.mMot);
  f.appendChild(gmo);

  /* filial */
  var filiais = Array.from(new Set(R.map(function (r) { return r.f; }))).sort(function (a, b) { return a - b; });
  REF.filiais = {};
  if (filiais.length > 1) {
    var gf = el("div", "fgrupo sep");
    gf.appendChild(el("span", "frot", "Filial"));
    filiais.forEach(function (n) {
      var b = el("button", "chip", String(n)); b.type = "button";
      b.addEventListener("click", function () {
        if (E.filiais.has(n)) E.filiais.delete(n); else E.filiais.add(n);
        sincronizar(); desenhar();
      });
      REF.filiais[n] = b; gf.appendChild(b);
    });
    f.appendChild(gf);
  }

  var lim = el("button", "btn-limpar", "Limpar filtros"); lim.type = "button";
  lim.style.marginLeft = "auto";
  lim.addEventListener("click", function () {
    E.motivos.clear(); E.motoristas.clear(); E.filiais.clear(); E.chamado = "todos";
    aplicarPreset("ano"); sincronizar(); desenhar();
  });
  f.appendChild(lim);
  raiz.appendChild(f);
}

function sincronizar() {
  var atual = presetAtual();
  Object.keys(REF.presets).forEach(function (id) { REF.presets[id].classList.toggle("on", id === atual); });
  REF.de.value = E.de; REF.ate.value = E.ate;
  Object.keys(REF.chamado).forEach(function (k) { REF.chamado[k].classList.toggle("on", E.chamado === k); });
  Object.keys(REF.filiais).forEach(function (n) { REF.filiais[n].classList.toggle("on", E.filiais.has(+n)); });
  REF.mMotivo.atualizar(); REF.mMot.atualizar();
}

function construirMenu() {
  var m = $("menu");
  limpar(m);
  PAGINAS.forEach(function (p) {
    var b = el("button", "side-item" + (E.pagina === p.id ? " ativo" : ""));
    b.type = "button"; b.dataset.id = p.id;
    var ic = el("span", "ic");
    ic.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p.ic + "</svg>";
    b.appendChild(ic); b.appendChild(document.createTextNode(p.nome));
    b.addEventListener("click", function () {
      E.pagina = p.id; history.replaceState(null, "", "#" + p.id);
      $("side").classList.remove("aberto"); $("veu").style.display = "";
      construirMenu(); desenhar(); window.scrollTo({ top: 0 });
    });
    m.appendChild(b);
  });
}

function desenhar() {
  var alvo = $("pagina");
  limpar(alvo);
  FILA = [];
  var p = PAGINAS.filter(function (x) { return x.id === E.pagina; })[0] || PAGINAS[0];
  $("topo-eyebrow").textContent = p.eyebrow;
  $("topo-titulo").textContent = p.nome === "Visão geral" ? "Reposições e Chamados" : p.nome;
  var C = contexto();
  var corpo = ({ geral: paginaGeral, motivos: paginaMotivos, itens: paginaItens, motoristas: paginaMotoristas, detalhe: paginaDetalhe })[p.id](C);
  alvo.appendChild(corpo);
  desenharGraficos();
  var rd = $("rodape");
  rd.innerHTML = "<b>" + fInt(C.F.length) + "</b> linhas no recorte · período <b>" + fData(E.de) + "</b> a <b>" + fData(E.ate) + "</b> · " +
    "dado do WinThor (rotinas 8352 e 8353) · carga de " + (D.carga ? fDataHora(new Date(D.carga).toLocaleString("sv-SE").replace(" ", "T")) : "—");
}

/* ---------------------------------------------------------------------------
 * Carga
 * ------------------------------------------------------------------------ */
function falhou(msg, detalhe) {
  var c = $("carregando");
  c.className = "falhou"; c.hidden = false; c.style.display = "";
  limpar(c);
  c.appendChild(el("div", "marca", "Reposições e Chamados"));
  var e = el("div", "erro"); e.appendChild(document.createTextNode(msg));
  if (detalhe) e.appendChild(el("code", null, detalhe));
  c.appendChild(e);
  var b = el("button", null, "Tentar de novo"); b.type = "button";
  b.addEventListener("click", function () { location.reload(); });
  c.appendChild(b);
}

function buscar(atualizar) {
  var url = "/api/dados" + (atualizar ? "?atualizar=" + Date.now() : "");
  var aviso = setTimeout(function () {
    var t = $("carregandoTexto");
    if (t) t.textContent = "O banco pode estar acordando — a primeira leitura do dia demora um pouco…";
  }, 7000);
  return fetch(url, { cache: atualizar ? "reload" : "default" }).then(function (r) {
    clearTimeout(aviso);
    return r.json().catch(function () { return {}; }).then(function (j) {
      if (!r.ok) { var err = new Error(j.mensagem || ("HTTP " + r.status)); err.detalhe = (j.detalhe ? j.detalhe + " · " : "") + "HTTP " + r.status; throw err; }
      return j;
    });
  }, function (e) { clearTimeout(aviso); throw e; });
}

function iniciar(json, primeira) {
  preparar(json);
  if (!R.length) { falhou("O banco respondeu, mas ainda não há reposições carregadas.", "Rode o sync_reposicao.py e abra de novo."); return; }
  if (primeira) {
    var h = location.hash.replace("#", "");
    if (PAGINAS.some(function (p) { return p.id === h; })) E.pagina = h;
    aplicarPreset("ano");
    construirMenu();
    construirFiltros();
  } else {
    E.de = E.de < MIND ? MIND : E.de;
    if (E.ate > MAXD || E.preset === "ano") { aplicarPreset(E.preset || "ano"); }
    construirFiltros();
  }
  sincronizar();
  $("ultima-carga").textContent = D.carga ? new Date(D.carga).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
  $("carregando").style.display = "none";
  $("raiz").hidden = false;
  desenhar();
}

document.addEventListener("DOMContentLoaded", function () {
  $("menu-btn").addEventListener("click", function () { $("side").classList.toggle("aberto"); });
  $("veu").addEventListener("click", function () { $("side").classList.remove("aberto"); });
  $("btn-atualizar").addEventListener("click", function () {
    var b = $("btn-atualizar"); b.classList.add("girando"); b.disabled = true;
    buscar(true).then(function (j) { iniciar(j, false); }, function (e) { alert("Não consegui atualizar: " + e.message); })
      .then(function () { b.classList.remove("girando"); b.disabled = false; });
  });
  var tmr = null;
  window.addEventListener("resize", function () { clearTimeout(tmr); tmr = setTimeout(function () { if (D) desenharGraficos(); }, 160); });
  buscar(false).then(function (j) { iniciar(j, true); }, function (e) { falhou(e.message || "Não consegui ler o banco.", e.detalhe || ""); });
});

})();
