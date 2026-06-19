// ===========================================================================
// INOVANDO MKT — Motor do Command Center (roda no GitHub Actions, a cada 30 min)
// Lê o quadro Trello -> pega as colunas entre "CLIENTES ATIVOS" e "FIM!" ->
// descobre a conta Meta de cada cliente -> puxa os dados do Meta Ads ->
// escreve o arquivo dados.json (o GitHub Actions faz o commit depois).
//
// As chaves vêm dos "Secrets" do repositório (não ficam no código):
//   TRELLO_KEY, TRELLO_TOKEN, META_TOKEN
// (BOARD_ID e META_VER já têm padrão abaixo.)
// ===========================================================================

const fs = require("fs");

const TRELLO_KEY   = process.env.TRELLO_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
const META_TOKEN   = process.env.META_TOKEN;
const BOARD_ID     = process.env.BOARD_ID || "6PSbYWKT";
const META_VER     = process.env.META_VER || "v25.0";

// Mapa cliente (coluna do Trello) -> ID da conta de anúncio do Meta (sem "act_").
// Cliente novo no Trello sem ID aqui aparece como "Sem conta" até alguém mapear
// (ou até colocar "act_NUMERO" num cartão da coluna — o motor lê isso também).
const MAP = {
  "souzagneri":"1599437730832316","odonto chueh":"776932710078790","dent-x":"495685006882489",
  "ortodonto":"2046299446147904","instituto clinico especializado":"1705373906851759","i clinico especializado":"1705373906851759",
  "gama clinic":"681487721360272","otica optima":"969933572256897","geracao de minas":"3517126421796226",
  "rr spa mobile":"877905779872333","chacara da serra":"1343108897056888","lucks lanches":"724989819654241",
  "padaria rainha da sul":"892357802999114","rainha da sul":"892357802999114","uniao de minas":"1076173037436485",
  "cafeina urbana arquitetura":"973988312272175","cafeina urbana":"973988312272175","servemei":"2416703108676525",
  "espaco amar":"312676821930863","amar":"312676821930863","ata":"37012127715052483","ata deco":"37012127715052483",
  "acai bacaceo":"2117547009034350","bacacio acai":"2117547009034350","breno rodrigues":"952366480052425",
  "tenorios":"730924665516463","tenorios burger":"730924665516463","master clean pro":"1499544194883369","master clean pro aju":"1499544194883369"
};

// Segmento por cliente (opcional, só pra exibir bonito no painel)
const SEG = {
  "souzagneri":"Odontologia","odonto chueh":"Odontologia","dent-x":"Odontologia","ortodonto":"Odontologia",
  "instituto clinico especializado":"Odontologia","gama clinic":"Estética/Clínica","otica optima":"Ótica",
  "geracao de minas":"Restaurante","rr spa mobile":"Estética Automotiva","chacara da serra":"Eventos/Lazer",
  "lucks lanches":"Restaurante","rainha da sul":"Padaria","padaria rainha da sul":"Padaria","uniao de minas":"Restaurante",
  "cafeina urbana":"Arquitetura","cafeina urbana arquitetura":"Arquitetura","servemei":"App/Consultoria MEI",
  "amar":"Estética/Integrativa","espaco amar":"Estética/Integrativa","ata":"Tapeçaria/Decoração","ata deco":"Tapeçaria/Decoração",
  "acai bacaceo":"Alimentação","bacacio acai":"Alimentação","breno rodrigues":"Personal/Fight","tenorios":"Hamburgueria",
  "tenorios burger":"Hamburgueria","master clean pro":"Produtos de Limpeza","master clean pro aju":"Produtos de Limpeza",
  "villa macarrone":"Restaurante Italiano","tapioca alagoana":"Restaurante"
};

const norm = s => (s||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"")
  .replace(/[\(\)\[\]\/@]/g," ").replace(/plano (ouro|start)/g," ")
  .replace(/[0-9]+/g," ").replace(/\s+/g," ").trim();

async function getJSON(url){
  const r = await fetch(url);
  if(!r.ok) throw new Error("HTTP "+r.status+" em "+url.split("?")[0]);
  return r.json();
}

(async () => {
  if(!TRELLO_KEY || !TRELLO_TOKEN || !META_TOKEN){
    console.error("Faltam segredos: defina TRELLO_KEY, TRELLO_TOKEN e META_TOKEN nos Secrets do repositório.");
    process.exit(1);
  }

  // 1) colunas do Trello, ordenadas, entre os marcadores
  const lists = await getJSON(`https://api.trello.com/1/boards/${BOARD_ID}/lists?fields=name,pos&key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`);
  lists.sort((a,b)=>a.pos-b.pos);
  const iStart = lists.findIndex(l=>/clientes ativos/i.test(l.name));
  const iEnd   = lists.findIndex(l=>/^fim/i.test(l.name.trim()));
  const ativos = (iStart>=0 && iEnd>iStart) ? lists.slice(iStart+1, iEnd) : lists;

  const clientes = [];
  for(const l of ativos){
    const chave = norm(l.name);
    let acc = MAP[chave];
    if(!acc){ for(const k of Object.keys(MAP)){ if(chave.includes(k)){ acc=MAP[k]; break; } } }
    // fallback: procura "act_NUMERO" nos cartões da coluna
    if(!acc){
      try{
        const cards = await getJSON(`https://api.trello.com/1/lists/${l.id}/cards?fields=name,desc&key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`);
        for(const c of cards){ const m=((c.name||"")+" "+(c.desc||"")).match(/act_(\d{6,})/i); if(m){ acc=m[1]; break; } }
      }catch(e){}
    }

    const base = {
      nome: l.name.split("(")[0].split("/")[0].trim(),
      seg: SEG[chave] || "—",
      plano: (/ouro/i.test(l.name)?"Ouro":/start/i.test(l.name)?"Start":"—"),
      ig: (l.name.match(/@[a-zA-Z0-9_.]+/)||["—"])[0],
      acc: acc || "—", status: "SEM_CONTA",
      spend:0, impr:0, reach:0, clicks:0, ctr:0, cpc:0, cpm:0, freq:0, linkClicks:0, pay:true, camps:[]
    };
    if(!acc){ clientes.push(base); continue; }

    try{
      const r = await getJSON(`https://graph.facebook.com/${META_VER}/act_${acc}/insights?fields=spend,impressions,reach,clicks,ctr,cpc,cpm,frequency&date_preset=last_7d&access_token=${META_TOKEN}`);
      const d = (r.data && r.data[0]) || null;
      if(!d){ base.status="DORMENTE"; clientes.push(base); continue; }
      base.spend=+d.spend||0; base.impr=+d.impressions||0; base.reach=+d.reach||0;
      base.clicks=+d.clicks||0; base.ctr=+d.ctr||0; base.cpc=+d.cpc||0; base.cpm=+d.cpm||0; base.freq=+d.frequency||0;
      base.status = base.spend>0 ? "ATIVO" : "DORMENTE";

      if(base.spend>0){
        const rc = await getJSON(`https://graph.facebook.com/${META_VER}/act_${acc}/insights?level=campaign&fields=campaign_name,spend,impressions,clicks,ctr,cpc&date_preset=last_7d&sort=spend_descending&limit=5&access_token=${META_TOKEN}`);
        base.camps = (rc.data||[]).map(k=>({ n:k.campaign_name, spend:+k.spend||0, impr:+k.impressions||0,
          clicks:+k.clicks||0, ctr:+k.ctr||0, cpc:+k.cpc||0 }));
      }
    }catch(e){ base.status="API_PENDENTE"; }
    clientes.push(base);
  }

  const agora = new Date().toLocaleString("pt-BR",{ timeZone:"America/Sao_Paulo" });
  const payload = { atualizadoEm:"Atualizado em "+agora, periodo:{ label:"Últimos 7 dias" }, clientes };
  fs.writeFileSync("dados.json", JSON.stringify(payload, null, 2));
  console.log(`OK: ${clientes.length} clientes (${clientes.filter(c=>c.status==="ATIVO").length} ativos) gravados em dados.json`);
})().catch(e => { console.error("Falha no motor:", e.message); process.exit(1); });
