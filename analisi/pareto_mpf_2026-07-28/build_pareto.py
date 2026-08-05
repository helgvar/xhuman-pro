import csv, json, html as H

rows = list(csv.DictReader(open('pareto_mpf.csv')))

def f(x):
    try: return round(float(x), 2)
    except: return None
def n(x):
    try: return int(float(x))
    except: return None

data = []
for r in rows:
    data.append({
        "sku": r["sku"],
        "prod": r["prod"],
        "brand": r["brand"],
        "rev": f(r["rev90"]),
        "nt": n(r["n_ten"]),
        "no": n(r["n_ord"]),
        "fonte": r["fonte"],
        "stk": n(r["erp_stock"]),
        "sup": n(r["supplier_stock"]),
        "pos": n(r["pos"]),
        "costo": f(r["costo"]),
        "comp": f(r["comp_min"]),
        "target": f(r["target_price"]),
        "ric": f(r["ricarico_target_pct"]),
        "cut": f(r["cut_needed"]),
        "v": r["verdetto"],
    })

# ordering of verdetto for grouping
order = {"STANDALONE":0,"REINSERISCI_prezzo_fb":1,"VIA_PC":2,"NO_SCRAPER_48h":3,"NON_POSIZIONABILE":4}
data.sort(key=lambda d:(order.get(d["v"],9), -(d["rev"] or 0)))

# aggregate
from collections import defaultdict
agg=defaultdict(lambda:[0,0.0])
for d in data:
    agg[d["v"]][0]+=1; agg[d["v"]][1]+=(d["rev"] or 0)

posiz = ["STANDALONE","REINSERISCI_prezzo_fb","VIA_PC"]
tot_pos = sum(agg[v][0] for v in posiz)
rev_pos = sum(agg[v][1] for v in posiz)

payload = json.dumps(data, ensure_ascii=False)

meta = {v:{"n":agg[v][0],"rev":round(agg[v][1])} for v in agg}

VLABEL = {
 "STANDALONE":"Standalone",
 "REINSERISCI_prezzo_fb":"Reinserisci (prezzo FB)",
 "VIA_PC":"Via PC",
 "NO_SCRAPER_48h":"No scraper 48h",
 "NON_POSIZIONABILE":"Non posizionabile",
}

html = f"""<title>Pareto MPF — fuori feed, reinseribili</title>
<style>
:root{{
  --bg:#f6f7f5; --panel:#ffffff; --ink:#14201a; --muted:#5c6b62; --line:#e2e7e1;
  --emer:#0f7a52; --emer-soft:#e4f3ea; --amber:#b5730a; --amber-soft:#f8eed8;
  --red:#a3352b; --red-soft:#f4e2df; --slate:#4a5a6a; --slate-soft:#e8edf1;
  --chip:#eef2ee; --shadow:0 1px 2px rgba(20,32,26,.06),0 2px 8px rgba(20,32,26,.04);
}}
@media (prefers-color-scheme:dark){{
  :root{{ --bg:#0e1512; --panel:#151d19; --ink:#e6ede8; --muted:#93a49a; --line:#243029;
   --emer:#3fbf88; --emer-soft:#122a1f; --amber:#e0a640; --amber-soft:#2c2413;
   --red:#e08278; --red-soft:#2c1a17; --slate:#9db3c6; --slate-soft:#1a232c; --chip:#1c2620;
   --shadow:0 1px 2px rgba(0,0,0,.3);}}
}}
:root[data-theme="light"]{{ --bg:#f6f7f5; --panel:#ffffff; --ink:#14201a; --muted:#5c6b62; --line:#e2e7e1; --emer:#0f7a52; --emer-soft:#e4f3ea; --amber:#b5730a; --amber-soft:#f8eed8; --red:#a3352b; --red-soft:#f4e2df; --slate:#4a5a6a; --slate-soft:#e8edf1; --chip:#eef2ee; }}
:root[data-theme="dark"]{{ --bg:#0e1512; --panel:#151d19; --ink:#e6ede8; --muted:#93a49a; --line:#243029; --emer:#3fbf88; --emer-soft:#122a1f; --amber:#e0a640; --amber-soft:#2c2413; --red:#e08278; --red-soft:#2c1a17; --slate:#9db3c6; --slate-soft:#1a232c; --chip:#1c2620; }}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}}
.wrap{{max-width:1280px;margin:0 auto;padding:28px 20px 80px}}
.tabnum{{font-variant-numeric:tabular-nums}}
header h1{{font-size:22px;margin:0 0 4px;letter-spacing:-.01em}}
header p{{margin:0;color:var(--muted);font-size:13px}}
.eyebrow{{text-transform:uppercase;letter-spacing:.09em;font-size:11px;font-weight:600;color:var(--emer)}}
.cards{{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:20px 0 8px}}
.card{{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px;box-shadow:var(--shadow)}}
.card .k{{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600}}
.card .v{{font-size:26px;font-weight:700;margin-top:4px;letter-spacing:-.02em}}
.card .s{{font-size:12px;color:var(--muted);margin-top:2px}}
.card.hero{{border-color:var(--emer);background:linear-gradient(180deg,var(--emer-soft),var(--panel))}}
.card.hero .v{{color:var(--emer)}}
.toolbar{{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:18px 0 12px}}
.toolbar input[type=search]{{flex:1;min-width:200px;padding:9px 12px;border:1px solid var(--line);border-radius:9px;background:var(--panel);color:var(--ink);font-size:13px}}
.chips{{display:flex;flex-wrap:wrap;gap:6px}}
.chip{{cursor:pointer;user-select:none;padding:6px 11px;border-radius:20px;border:1px solid var(--line);background:var(--panel);font-size:12px;font-weight:600;color:var(--muted)}}
.chip.on{{color:#fff;border-color:transparent}}
.chip[data-v="STANDALONE"].on{{background:var(--emer)}}
.chip[data-v="REINSERISCI_prezzo_fb"].on{{background:var(--slate)}}
.chip[data-v="VIA_PC"].on{{background:var(--amber)}}
.chip[data-v="NO_SCRAPER_48h"].on{{background:#7a7a7a}}
.chip[data-v="NON_POSIZIONABILE"].on{{background:var(--red)}}
.count{{margin-left:auto;color:var(--muted);font-size:12px}}
.tblwrap{{overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:var(--panel);box-shadow:var(--shadow)}}
table{{border-collapse:collapse;width:100%;min-width:1040px;font-size:13px}}
th,td{{padding:8px 10px;text-align:right;white-space:nowrap;border-bottom:1px solid var(--line)}}
th{{position:sticky;top:0;background:var(--panel);cursor:pointer;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:700;z-index:2}}
th:first-child,td:first-child,th.l,td.l{{text-align:left}}
th.sorted::after{{content:" ▾";color:var(--emer)}}
th.sorted.asc::after{{content:" ▴"}}
tbody tr:hover{{background:var(--chip)}}
.pill{{display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;letter-spacing:.02em}}
.p-STANDALONE{{background:var(--emer-soft);color:var(--emer)}}
.p-REINSERISCI_prezzo_fb{{background:var(--slate-soft);color:var(--slate)}}
.p-VIA_PC{{background:var(--amber-soft);color:var(--amber)}}
.p-NO_SCRAPER_48h{{background:var(--chip);color:var(--muted)}}
.p-NON_POSIZIONABILE{{background:var(--red-soft);color:var(--red)}}
.fonte-M{{color:var(--emer);font-weight:600}}
.fonte-g{{color:var(--muted)}}
.prod{{max-width:260px;overflow:hidden;text-overflow:ellipsis}}
.sku{{color:var(--muted);font-variant-numeric:tabular-nums}}
.note{{margin:16px 0 0;color:var(--muted);font-size:12px;line-height:1.6}}
.wave{{background:var(--panel);border:1px solid var(--emer);border-radius:12px;padding:16px 18px;margin:18px 0;box-shadow:var(--shadow)}}
.wave h3{{margin:0 0 6px;font-size:14px;color:var(--emer)}}
.wave ol{{margin:8px 0 0;padding-left:20px}} .wave li{{margin:3px 0}}
</style>
<div class="wrap">
<header>
<div class="eyebrow">MPF · Pareto rete · fuori feed</div>
<h1>Pareto disponibili &amp; reinseribili — Personal Farma</h1>
<p>Top 80% fatturato RETE (90gg) · disponibili MPF (magazzino o grossista) · oggi FUORI dal feed · giudizio floor-safe su competitor esterno fresco ≤48h. Dati DB reali {len(data)} SKU.</p>
</header>

<div class="cards">
<div class="card hero"><div class="k">Posizionabili floor-safe</div><div class="v tabnum">{tot_pos:,}</div><div class="s">€{round(rev_pos):,} fatturato rete 90gg</div></div>
<div class="card"><div class="k">Standalone</div><div class="v tabnum" style="color:var(--emer)">{meta.get('STANDALONE',{}).get('n',0):,}</div><div class="s">già sotto competitor · €{meta.get('STANDALONE',{}).get('rev',0):,}</div></div>
<div class="card"><div class="k">Reinserisci · prezzo FB</div><div class="v tabnum" style="color:var(--slate)">{meta.get('REINSERISCI_prezzo_fb',{}).get('n',0):,}</div><div class="s">mai prezzato · FB floor-safe · €{meta.get('REINSERISCI_prezzo_fb',{}).get('rev',0):,}</div></div>
<div class="card"><div class="k">Via PC</div><div class="v tabnum" style="color:var(--amber)">{meta.get('VIA_PC',{}).get('n',0):,}</div><div class="s">cut centesimi · €{meta.get('VIA_PC',{}).get('rev',0):,}</div></div>
<div class="card"><div class="k">Non posizionabile</div><div class="v tabnum" style="color:var(--red)">{meta.get('NON_POSIZIONABILE',{}).get('n',0):,}</div><div class="s">deserto · mercato al costo</div></div>
</div>

<div class="wave">
<h3>Prima ondata consigliata (gradualità: no migliaia di colpo)</h3>
<p style="margin:0;color:var(--muted);font-size:12.5px">Reinserisci STANDALONE + VIA_PC ordinati per fatturato rete, in blocchi da ~500-1000/ciclo, misura 24-48h. Le REINSERISCI-prezzo-FB richiedono che FB prezzi floor-safe (verificabile post-build). Nessuna scrittura fatta: audit-only, aspetto tuo via.</p>
</div>

<div class="toolbar">
<input type="search" id="q" placeholder="Cerca SKU, prodotto, brand…">
<div class="chips" id="chips"></div>
</div>
<div class="toolbar" style="margin-top:-4px">
<span class="count" id="count"></span>
</div>

<div class="tblwrap">
<table id="t">
<thead><tr>
<th class="l" data-c="sku">SKU</th>
<th class="l" data-c="prod">Prodotto</th>
<th class="l" data-c="fonte">Fonte</th>
<th data-c="stk">Stk</th>
<th data-c="sup">Gross</th>
<th data-c="rev">Rev rete 90g</th>
<th data-c="nt">Farm</th>
<th data-c="no">Ord</th>
<th data-c="costo">Costo</th>
<th data-c="comp">Comp min</th>
<th data-c="target">Target</th>
<th data-c="ric">Ric% target</th>
<th data-c="cut">Cut</th>
<th data-c="pos">Pos TP</th>
<th class="l" data-c="v">Verdetto</th>
</tr></thead>
<tbody id="tb"></tbody>
</table>
</div>
<p class="note">Floor ricarico per fascia costo: &lt;10€ 18% · 10–30€ 14% · &gt;30€ 12%. <b>Target</b> = miglior competitor esterno −1cent. <b>Ric% target</b> = ricarico a quel prezzo (sempre ≥ floor per i posizionabili). <b>Standalone</b>: prezzo attuale già ≤ target. <b>Reinserisci-prezzo-FB</b>: mai venduto su MPF (prezzo ignoto) ma floor-safe raggiungibile. <b>Via PC</b>: serve taglio (colonna Cut) restando floor-safe. Merchant nostra rete esclusi dal competitor (no guerra interna).</p>
</div>

<script>
const DATA={payload};
const VL={json.dumps(VLABEL, ensure_ascii=False)};
const VS=["STANDALONE","REINSERISCI_prezzo_fb","VIA_PC","NO_SCRAPER_48h","NON_POSIZIONABILE"];
const active=new Set(["STANDALONE","REINSERISCI_prezzo_fb","VIA_PC"]);
let sortC="rev",sortAsc=false;
const chips=document.getElementById('chips');
VS.forEach(v=>{{const c=document.createElement('div');c.className='chip'+(active.has(v)?' on':'');c.dataset.v=v;
 const cnt=DATA.filter(d=>d.v===v).length;c.textContent=VL[v]+' '+cnt;
 c.onclick=()=>{{active.has(v)?active.delete(v):active.add(v);c.classList.toggle('on');render();}};chips.appendChild(c);}});
const q=document.getElementById('q');q.oninput=render;
document.querySelectorAll('#t th').forEach(th=>{{th.onclick=()=>{{const c=th.dataset.c;if(sortC===c)sortAsc=!sortAsc;else{{sortC=c;sortAsc=false;}}render();}};}});
function eur(x){{return x==null?'—':'€'+x.toLocaleString('it-IT',{{maximumFractionDigits:2}});}}
function num(x){{return x==null?'—':x.toLocaleString('it-IT',{{maximumFractionDigits:2}});}}
function render(){{
 const term=q.value.trim().toLowerCase();
 let rows=DATA.filter(d=>active.has(d.v));
 if(term)rows=rows.filter(d=>(d.sku+' '+(d.prod||'')+' '+(d.brand||'')).toLowerCase().includes(term));
 rows.sort((a,b)=>{{let x=a[sortC],y=b[sortC];if(typeof x==='string'||typeof y==='string'){{x=(x||'');y=(y||'');return sortAsc?String(x).localeCompare(y):String(y).localeCompare(x);}}x=x==null?-Infinity:x;y=y==null?-Infinity:y;return sortAsc?x-y:y-x;}});
 document.querySelectorAll('#t th').forEach(th=>{{th.classList.toggle('sorted',th.dataset.c===sortC);th.classList.toggle('asc',th.dataset.c===sortC&&sortAsc);}});
 const tb=document.getElementById('tb');
 tb.innerHTML=rows.slice(0,1500).map(d=>`<tr>
 <td class="l sku">${{d.sku}}</td>
 <td class="l prod" title="${{(d.prod||'').replace(/"/g,'&quot;')}}">${{d.prod||''}}${{d.brand?` <span style="color:var(--muted);font-size:11px">${{d.brand}}</span>`:''}}</td>
 <td class="l ${{d.fonte==='MAGAZZINO'?'fonte-M':'fonte-g'}}">${{d.fonte==='MAGAZZINO'?'Magazzino':'grossista'}}</td>
 <td class="tabnum">${{d.stk??'—'}}</td>
 <td class="tabnum">${{d.sup??'—'}}</td>
 <td class="tabnum"><b>${{eur(d.rev)}}</b></td>
 <td class="tabnum">${{d.nt??'—'}}</td>
 <td class="tabnum">${{d.no??'—'}}</td>
 <td class="tabnum">${{eur(d.costo)}}</td>
 <td class="tabnum">${{eur(d.comp)}}</td>
 <td class="tabnum">${{eur(d.target)}}</td>
 <td class="tabnum">${{d.ric==null?'—':num(d.ric)+'%'}}</td>
 <td class="tabnum">${{d.cut?('−'+eur(d.cut)):'—'}}</td>
 <td class="tabnum">${{d.pos??'—'}}</td>
 <td class="l"><span class="pill p-${{d.v}}">${{VL[d.v]}}</span></td>
 </tr>`).join('');
 const shown=Math.min(rows.length,1500);
 const rev=rows.reduce((s,d)=>s+(d.rev||0),0);
 document.getElementById('count').textContent=`${{rows.length.toLocaleString('it-IT')}} SKU · €${{Math.round(rev).toLocaleString('it-IT')}} rev rete 90g`+(rows.length>1500?` (mostrati primi ${{shown}})`:'');
}}
render();
</script>"""

open('pareto_mpf.html','w').write(html)
print("written", len(html), "bytes; rows", len(data))
