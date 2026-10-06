/**
 * servidor_local.js — abre o painel no seu computador, antes (ou sem) publicar na Vercel.
 *
 * Serve a pasta web/ e atende /api/dados com A MESMA função que a Vercel usa
 * (api/dados.js), contra o DATA WAREHOUSE de verdade. A senha do banco vem do
 * arquivo ENV do ETL: ela é lida para a memória deste processo e nunca é
 * impressa nem gravada em outro lugar.
 *
 *   cd web
 *   npm install            (uma vez)
 *   node servidor_local.js
 *   abra http://localhost:3101
 *
 * Onde ele procura o ENV, nesta ordem: o caminho passado como argumento,
 * ..\etl\ENV, C:\BI\REPOSICOES\ENV e C:\BI\COMERCIAL\ENV.
 * Variáveis SUPABASE_DB_* que já estejam no ambiente têm preferência.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const WEB = __dirname;
const PORTA = Number(process.env.PORTA || 3101);

const candidatos = [
  process.argv[2],
  path.join(WEB, "..", "etl", "ENV"),
  "C:\\BI\\REPOSICOES\\ENV",
  "C:\\BI\\COMERCIAL\\ENV",
].filter(Boolean);
const arquivoEnv = candidatos.find((c) => fs.existsSync(c));
if (!arquivoEnv && !process.env.SUPABASE_DB_PASSWORD) {
  console.error("Nao achei o arquivo ENV. Passe o caminho: node servidor_local.js \"C:\\caminho\\ENV\"");
  process.exit(1);
}
if (arquivoEnv) {
  for (const linha of fs.readFileSync(arquivoEnv, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(linha);
    if (!m || linha.trim().startsWith("#")) continue;
    let v = m[2];
    if (/^".*"$/.test(v)) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
process.env.SUPABASE_DB_PORT = process.env.SUPABASE_DB_PORT || "5432";

const dados = require(path.join(WEB, "api", "dados.js"));
const TIPOS = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".png": "image/png", ".css": "text/css", ".json": "application/json",
};

http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname === "/api/dados") {
    req.query = Object.fromEntries(u.searchParams);
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); };
    res.send = (s) => res.end(s);
    return dados(req, res);
  }
  const f = path.join(WEB, u.pathname === "/" ? "index.html" : decodeURIComponent(u.pathname));
  // so serve o que esta dentro de web/, e nunca a pasta de codigo do servidor nem o ENV
  const ok = f.startsWith(WEB + path.sep) && !f.includes("node_modules") && !/servidor_local\.js$/.test(f) &&
             fs.existsSync(f) && fs.statSync(f).isFile();
  if (!ok) { res.statusCode = 404; return res.end("nao encontrado"); }
  res.setHeader("Content-Type", TIPOS[path.extname(f)] || "application/octet-stream");
  res.end(fs.readFileSync(f));
}).listen(PORTA, () => console.log("Painel em http://localhost:" + PORTA + "   (Ctrl+C para parar)"));
