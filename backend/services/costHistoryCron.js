/**
 * REGISTRI STORICI — costi E prezzi (6/8/2026).
 *
 * Il file si chiama ancora costHistoryCron perche' e' nato per i soli costi.
 * Adesso guida DUE registri, `costi` e `prezzi`, con lo stesso motore.
 *
 * IL PROBLEMA CHE HA ALLARGATO IL LAVORO
 * Il capo, davanti al grafico di Farmabooster: "non e' possibile lactoflorene
 * ha sempre venduto in utile rispetto al costo del momento. devi importare per
 * tutti i tenant l'history price e cost da farmabooster altrimenti non ne
 * uscirai mai".
 *
 * Aveva ragione. LACTOFLORENE REPAIR IBS, venduto il 13/7 a 8,85 ivati. Costo
 * di oggi: 13,17. Ogni analisi retroattiva lo dava a -4,32, un prodotto che
 * vende in perdita. Il costo del 13/7 era 7,667 e il prezzo 9,54: margine
 * +1,87. Il costo e' salito DOPO la vendita. Su MPF a 30 giorni erano 54 SKU
 * dichiarati sotto costo per -460 EUR, nessuno dei quali era una misura.
 *
 * Un margine ha due gambe, e devono essere prese ENTRAMBE al momento della
 * vendita. Il registro costi da solo non basta: senza il prezzo di quel giorno
 * si finisce a confrontare il costo storico col prezzo di listino di adesso, e
 * l'errore cambia solo di segno.
 *
 * LE DUE SORGENTI
 *  1. `/costhistory` e `/pricehistory` di Farmabooster — il passato. Su MPF
 *     3.198 pagine di costi e 1.559 di prezzi, finestra di 31 giorni. E' l'unico
 *     posto dove i giorni gia' passati esistono ancora. Filtrano solo per
 *     `code`: nessun filtro data. Per prenderli tutti si va in serie.
 *  2. Il gradino dentro il sync prodotti (farmaboosterProducts.js) — il
 *     presente. Gratis, gira a ogni sync, non chiama API in piu'.
 *
 * IL DISEGNO CHE HA CHIESTO IL CAPO
 * "l'history la devi importare una sola volta poi ogni giorno fai il rotate
 * cancelli il primo e importi l'ultimo".
 *
 *   backfill (una volta)  ->  gradino nel sync (ogni ora)  ->  rotazione (ogni notte)
 *
 * Il backfill riempie i 31 giorni. Da li' in poi il passato non si riscarica
 * mai piu': il presente lo fissa il gradino del sync, e la rotazione butta il
 * giorno che esce dalla finestra. Niente 4.757 pagine al giorno per tenant.
 *
 * LA TRAPPOLA DELLA ROTAZIONE
 * "cancelli il primo" non si puo' prendere alla lettera su una funzione a
 * gradini. Se il prezzo e' 9,21 dal 7/7 al 12/7, l'UNICA riga che lo dice e'
 * quella del 7/7: cancellarla non toglie un giorno, toglie il valore di tutti
 * i giorni fino al gradino dopo. Prima di tagliare bisogna ri-ancorare — il
 * gradino attivo al nuovo pavimento viene riscritto CON la data del pavimento,
 * e solo dopo si cancella cio' che sta sotto. La serie resta identica, la
 * finestra si accorcia davvero. Vedi ruotaRegistro().
 *
 * IL GRADINO
 * Si scrive solo quando il valore CAMBIA. FB manda una riga al giorno per
 * (codice[, grossista]) anche a valore fermo: milioni di righe che ripetono lo
 * stesso numero. La serie a gradini e' identica — il valore di un giorno
 * qualunque e' l'ultima riga con data <= quel giorno — e il volume crolla.
 *
 * Il gradino si estrae UN CODICE PER VOLTA, non riga per riga. Le pagine
 * arrivano raggruppate per codice ma dentro il codice l'ordine delle date non
 * e' garantito, e un confronto nell'ordine di arrivo scrive gradini falsi: un
 * valore vecchio letto dopo uno nuovo sembra una variazione, e la variazione
 * vera che stava in mezzo sparisce. Quindi si accumulano tutte le righe del
 * codice — anche a cavallo di due pagine — si ordinano per data, e solo allora
 * si guardano i salti.
 *
 * A FETTE
 * Una spazzata intera e' ore. Un giro ne fa un pezzo, poi segna a che pagina e'
 * arrivato e si ferma; il giro dopo riprende da li'. Senza checkpoint un errore
 * a pagina 2.000 buttava via due ore e ricominciava da capo — che e' esattamente
 * come e' morta la prima spazzata. Fra una pagina e l'altra c'e' una pausa: la
 * coda Farmabooster e' la stessa del sync prodotti.
 *
 * LA GUARDIA
 * Guarda il BATTITO, non il dato. Guardare il dato darebbe falsi allarmi ogni
 * volta che i valori semplicemente non cambiano per quattro ore — e un allarme
 * che urla quando tutto va bene e' un allarme che si impara a ignorare. Il
 * battito si scrive a ogni passata riuscita, che abbia trovato variazioni o no.
 *
 * La grazia d'avvio serve allo stesso scopo: appena riavviato nessun tenant ha
 * ancora battuto, e dieci "MAI" sarebbero solo il rumore dell'accensione.
 */

const { pool } = require('../db/pool');
const { getFarmaboosterConfig, apiCall } = require('./farmaboosterClient');
const { sendTelegram } = require('./telegramNotifier');

const SOGLIA_BATTITO_ORE = 4;      // ordine del capo
const ETA_SPAZZATA_ORE = 20;       // sotto questa, il tenant e' fresco: si salta
const MAX_PAGINE = 6000;           // paracadute: MPF ne ha 3.198 sui costi
const BATCH_RIGHE = 2000;          // sotto il limite di parametri di Postgres
const GRAZIA_AVVIO_MS = 2 * 60 * 60 * 1000;
const ORA_NOTTE_DA = 1;            // ora italiana: dopo il refresh TP di mezzanotte
const ORA_NOTTE_A = 6;             // ora italiana: prima dei cicli delle 06:00
const PAUSA_PAGINA_MS = 300;       // respiro fra i blocchi: la coda FB e' quella del sync
const BUDGET_GIRO_MIN = 50;        // fetta massima per giro, poi checkpoint e si riprende
const PAGINE_PARALLELE = 3;        // quante pagine in volo insieme (la coda FB ne regge 3)
const TENTATIVI_PAGINA = 3;        // riprove su errore di rete o token scaduto

// Finestra tenuta dal registro. FB ne serve 31: tenerne di piu' non si puo'
// (il passato oltre non esiste da nessuna parte), tenerne di meno butterebbe
// giorni che abbiamo pagato per scaricare. Le analisi girano a 15/30 giorni,
// quindi 31 le copre tutte.
const GIORNI_TENUTA = 31;

const AVVIATO_A = Date.now();
let lavoroInCorso = false;

// Lucchetto in DB, non in memoria. Il backfill dura ore e gira in un processo
// SUO (docker exec staccato), quindi `lavoroInCorso` — che e' una variabile di
// modulo — non lo vede il backend. Senza questo, all'una di notte la spazzata
// del backend attaccherebbe lo stesso tenant e lo stesso registro che il
// backfill sta gia' leggendo: scritture idem-potenti, ma due checkpoint che si
// pestano e mezza notte di pagine rilette. Il lucchetto e' a scadenza cosi' un
// backfill morto male non blocca il loop per sempre.
// health_config.tenant_id e' NOT NULL con FK su tenants, quindi non esiste una
// riga "di sistema": il lucchetto si posa su tutti i tenant attivi in un colpo
// solo e si rinnova a ogni registro finito. Chi lo legge chiede solo se ce n'e'
// almeno uno vivo.
const CHIAVE_LUCCHETTO = 'storico_backfill_in_corso';
const LUCCHETTO_VALIDO_MIN = 180;

async function prendiLucchetto() {
  await pool.query(`
    INSERT INTO health_config (tenant_id, config_key, config_value, updated_at)
    SELECT t.id, $1, NOW()::text, NOW() FROM tenants t WHERE t.status = 'active'
    ON CONFLICT (tenant_id, config_key)
    DO UPDATE SET config_value = NOW()::text, updated_at = NOW()
  `, [CHIAVE_LUCCHETTO]);
}

async function mollaLucchetto() {
  await pool.query('DELETE FROM health_config WHERE config_key = $1', [CHIAVE_LUCCHETTO]);
}

async function lucchettoAttivo() {
  const { rows } = await pool.query(`
    SELECT 1 FROM health_config
    WHERE config_key = $1 AND updated_at > NOW() - ($2 || ' minutes')::interval
    LIMIT 1
  `, [CHIAVE_LUCCHETTO, LUCCHETTO_VALIDO_MIN]);
  return rows.length > 0;
}

const dormi = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * I due registri. Stessa forma, stesso motore: cambiano l'endpoint e i nomi dei
 * campi che manda FB.
 *
 * Tutti e due hanno una source, ma la riempiono in modo diverso. I costi la
 * portano dentro la riga, uno per grossista (CEF, Winfarm, Farvima, Sofarma,
 * Guacci). I prezzi no, perche' /pricehistory manda un prezzo solo per codice:
 * quel prezzo e' il Prezzo al Pubblico di FB, e va marcato come tale
 * (`fb_pubblico`) perche' NON e' l'unico prezzo che ci interessa. Su
 * LACTOFLORENE il 13/7 il listino era 9,54 e l'incasso 8,85: `applied_price` e
 * `exported_price` sono altre due serie, le scrive il gradino dentro il sync
 * prodotti sulla stessa tabella con la loro source.
 */
const REGISTRI = {
  costi: {
    nome: 'costi',
    endpoint: 'costhistory',
    tabella: 'product_cost_history',
    colonnaValore: 'costo',
    campoCodice: 'cost_history_code',
    campoData: 'cost_history_date',
    campoValore: 'cost_history_cost',
    sourceFissa: null,          // arriva dalla riga: e' il grossista
    chiavePagina: 'cost_history_page',
    chiaveSpazzata: 'cost_history_sweep_at',
  },
  prezzi: {
    nome: 'prezzi',
    endpoint: 'pricehistory',
    tabella: 'product_price_history',
    colonnaValore: 'prezzo',
    campoCodice: 'price_history_code',
    campoData: 'price_history_date',
    campoValore: 'price_history_price',
    sourceFissa: 'fb_pubblico', // FB manda un prezzo solo: il listino pubblico
    chiavePagina: 'price_history_page',
    chiaveSpazzata: 'price_history_sweep_at',
  },
};

/** Battito dei registri: lo scrivono sia la spazzata sia il gradino nel sync. */
async function battito(tenantId, chiave = 'cost_history_beat_at') {
  await pool.query(`
    INSERT INTO health_config (tenant_id, config_key, config_value, updated_at)
    VALUES ($1, $2, NOW()::text, NOW())
    ON CONFLICT (tenant_id, config_key)
    DO UPDATE SET config_value = NOW()::text, updated_at = NOW()
  `, [tenantId, chiave]);
}

/** A che pagina era arrivata la fetta precedente. 1 = si ricomincia da capo. */
async function leggiCheckpoint(tenantId, reg) {
  const { rows } = await pool.query(
    'SELECT config_value FROM health_config WHERE tenant_id = $1 AND config_key = $2',
    [tenantId, reg.chiavePagina]
  );
  const n = parseInt(rows[0] && rows[0].config_value, 10);
  return Number.isFinite(n) && n > 1 ? n : 1;
}

async function scriviCheckpoint(tenantId, reg, pagina) {
  await pool.query(`
    INSERT INTO health_config (tenant_id, config_key, config_value, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (tenant_id, config_key)
    DO UPDATE SET config_value = EXCLUDED.config_value, updated_at = NOW()
  `, [tenantId, reg.chiavePagina, String(pagina)]);
}

/**
 * Gradini di un singolo codice: le sue righe ordinate per data, un salto alla
 * volta. Si tiene la prima data della finestra come ancora — serve a sapere da
 * dove parte la serie — e poi solo i valori che cambiano davvero.
 *
 * Si raggruppa sempre per source. Sui prezzi il gruppo e' uno solo, ma il
 * raggruppamento resta perche' e' la stessa domanda con un gruppo solo.
 */
function gradiniDelCodice(righe, tenantId, reg, buffer) {
  const perSource = new Map();
  for (const r of righe) {
    if (!perSource.has(r.source)) perSource.set(r.source, []);
    perSource.get(r.source).push(r);
  }
  let cambiate = 0;
  for (const [source, lista] of perSource) {
    lista.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
    let prec;
    for (const r of lista) {
      // NUMERIC(12,4) in colonna, 5 decimali dall'API: si confronta sul quarto.
      if (prec !== undefined && Math.abs(prec - r.valore) < 0.00005) continue;
      prec = r.valore;
      cambiate++;
      buffer.push({
        tenant: tenantId, sku: r.sku, data: r.data, source, valore: r.valore.toFixed(4),
      });
    }
  }
  return cambiate;
}

/**
 * Una pagina, con riprove.
 *
 * Il token FB dura 50 minuti e una spazzata ne dura tre ore: a un certo punto
 * arriva un 401, sempre. farmaboosterClient il token scaduto lo butta gia' da
 * solo, ma poi rilancia l'errore e non riprova — la chiamata successiva
 * rifarebbe il login e andrebbe. Senza questa riprova la prima spazzata lunga e'
 * morta esattamente cosi', a poche pagine dall'inizio, portandosi via il buffer
 * non ancora scritto.
 *
 * Vale anche per i buchi di rete: una pagina persa su tremila non giustifica di
 * buttare l'ora di lavoro che la precede.
 */
async function chiediPagina(tenantId, config, reg, pagina) {
  let ultimo;
  for (let tentativo = 1; tentativo <= TENTATIVI_PAGINA; tentativo++) {
    try {
      return await apiCall(tenantId, config, reg.endpoint, { page: pagina });
    } catch (err) {
      ultimo = err;
      if (tentativo === TENTATIVI_PAGINA) break;
      const attesa = 2000 * tentativo;
      console.log(`[Storico:${reg.nome}] pagina ${pagina}: ${err.message} — riprovo fra ${attesa}ms (${tentativo}/${TENTATIVI_PAGINA - 1})`);
      await dormi(attesa);
    }
  }
  throw ultimo;
}

/** Scarica righe cambiate in blocco. */
async function scaricaBatch(righe, reg) {
  if (righe.length === 0) return 0;
  const valori = [];
  const params = [];
  righe.forEach((r, i) => {
    const b = i * 5;
    valori.push(`($${b + 1}, $${b + 2}, $${b + 3}::date, $${b + 4}, $${b + 5}, NOW())`);
    params.push(r.tenant, r.sku, r.data, r.source, r.valore);
  });
  const { rowCount } = await pool.query(`
    INSERT INTO ${reg.tabella} (tenant_id, sku, data, source, ${reg.colonnaValore}, updated_at)
    VALUES ${valori.join(',')}
    ON CONFLICT (tenant_id, sku, data, source)
    DO UPDATE SET ${reg.colonnaValore} = EXCLUDED.${reg.colonnaValore}, updated_at = NOW()
  `, params);
  return rowCount;
}

/**
 * Una fetta di spazzata di un registro per un tenant.
 *
 * Le pagine si chiedono a blocchi di PAGINE_PARALLELE ma si LAVORANO in ordine
 * di pagina. La distinzione conta: una pagina sola per volta misurata su MPF
 * fa 3,6 secondi a pagina — quasi tutto attesa della risposta FB — cioe' tre ore
 * per i soli costi di un tenant e due giorni pieni per la rete. In parallelo
 * l'attesa si sovrappone; l'ordine di lavorazione resta quello delle pagine
 * perche' il gradino ha bisogno delle righe di un codice tutte insieme e nella
 * sequenza giusta.
 *
 * Finito il budget di tempo segna la pagina e torna: la fetta dopo riprende.
 * Se una pagina muore anche dopo le riprove, quello che c'e' nel buffer si
 * scrive lo stesso e il checkpoint resta dov'era: un errore costa la fetta, non
 * le ore che la precedono.
 */
async function spazzaTenant(tenantId, tenantName, registro = 'costi', opzioni = {}) {
  const reg = typeof registro === 'string' ? REGISTRI[registro] : registro;
  if (!reg) throw new Error(`registro sconosciuto: ${registro}`);
  const tag = `[Storico:${reg.nome}]`;
  const budgetMs = (opzioni.budgetMin || BUDGET_GIRO_MIN) * 60 * 1000;
  const t0 = Date.now();
  const config = await getFarmaboosterConfig(tenantId);

  let pagina = await leggiCheckpoint(tenantId, reg);
  if (pagina > 1) console.log(`${tag} ${tenantName}: riprendo da pagina ${pagina}`);

  const parallele = opzioni.parallele || PAGINE_PARALLELE;
  let totPagine = null, lette = 0, cambiate = 0, scritte = 0;
  let buffer = [];
  let pendente = null;      // codice in corso: { codice, pagInizio, righe }
  let completata = false;
  let morta = null;

  try {
    while (pagina <= MAX_PAGINE) {
      // Quante ne posso chiedere insieme senza sforare il totale noto.
      let quante = parallele;
      if (totPagine) quante = Math.min(quante, totPagine - pagina + 1);
      if (quante <= 0) { completata = true; break; }

      const blocco = await Promise.all(
        Array.from({ length: quante }, (_, i) => chiediPagina(tenantId, config, reg, pagina + i))
      );

      if (totPagine === null) {
        totPagine = parseInt(blocco[0].total_pages || 0) || 0;
        console.log(`${tag} ${tenantName}: ${blocco[0].total_records} record su ${totPagine} pagine`);
      }

      let vuota = false;
      for (let i = 0; i < blocco.length; i++) {
        const pag = pagina + i;
        const dati = Array.isArray(blocco[i].data) ? blocco[i].data : [];
        if (dati.length === 0) { vuota = true; break; }

        for (const riga of dati) {
          lette++;
          const sku = String(riga[reg.campoCodice] || '').trim();
          const source = reg.sourceFissa || String(riga.source || '').trim();
          const valore = parseFloat(riga[reg.campoValore]);
          // Zero e' assenza di dato, non un valore: non entra nel registro.
          if (!sku || !source || !(valore > 0)) continue;
          const data = String(riga[reg.campoData] || '').slice(0, 10);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) continue;

          if (!pendente || pendente.codice !== sku) {
            if (pendente) cambiate += gradiniDelCodice(pendente.righe, tenantId, reg, buffer);
            pendente = { codice: sku, pagInizio: pag, righe: [] };
          }
          pendente.righe.push({ sku, source, data, valore });
        }
      }

      if (buffer.length >= BATCH_RIGHE) {
        scritte += await scaricaBatch(buffer, reg);
        buffer = [];
      }

      const ultimaLetta = pagina + blocco.length - 1;
      if (vuota || (totPagine && ultimaLetta >= totPagine)) { completata = true; break; }

      pagina = ultimaLetta + 1;
      if (Date.now() - t0 > budgetMs) break;
      if (Math.floor(pagina / 250) !== Math.floor((pagina - blocco.length) / 250)) {
        console.log(`${tag} ${tenantName}: pagina ${pagina}/${totPagine}, ${cambiate} variazioni finora`);
      }
      await dormi(PAUSA_PAGINA_MS);
    }
  } catch (err) {
    // Non si rilancia: sotto c'e' il salvataggio del buffer e del checkpoint.
    // Rilanciare qui butterebbe le righe gia' lette — e' cosi' che la prima
    // spazzata lunga e' morta, con un 401 da token scaduto.
    morta = err;
    console.error(`${tag} ${tenantName}: interrotta a pagina ${pagina} — ${err.message}`);
  }

  // Il codice in corso si chiude solo se la spazzata e' arrivata in fondo. Se e'
  // finito il tempo lo si butta e si riparte dalla pagina dove era cominciato:
  // meta' codice darebbe una serie tagliata a meta'.
  if (completata && pendente) cambiate += gradiniDelCodice(pendente.righe, tenantId, reg, buffer);
  scritte += await scaricaBatch(buffer, reg);

  const min = Math.round((Date.now() - t0) / 60000);
  if (completata) {
    await scriviCheckpoint(tenantId, reg, 1);
    await battito(tenantId, reg.chiaveSpazzata);
    await battito(tenantId);
    console.log(`${tag} ${tenantName}: spazzata COMPLETA — ${lette} righe lette, ${cambiate} variazioni, ${scritte} scritte, ${min} min`);
  } else {
    const ripresa = pendente ? pendente.pagInizio : pagina;
    await scriviCheckpoint(tenantId, reg, ripresa);
    // Battito solo se si e' fermata per fine budget: un giro andato bene. Se e'
    // morta su un errore no — li' la guardia deve poterlo vedere.
    if (!morta) await battito(tenantId);
    console.log(`${tag} ${tenantName}: fetta ${morta ? 'INTERROTTA' : 'finita'} a pagina ${pagina}/${totPagine} — ${cambiate} variazioni, ${scritte} scritte, ${min} min, riprendo da ${ripresa}`);
  }
  return { registro: reg.nome, lette, cambiate, scritte, minuti: min, completata, pagina, errore: morta ? morta.message : null };
}

/**
 * ROTAZIONE — "ogni giorno fai il rotate cancelli il primo e importi l'ultimo".
 *
 * L'ultimo lo importa il gradino dentro il sync prodotti, ogni ora. Qui si
 * cancella il primo, che su una funzione a gradini non e' un DELETE e basta.
 *
 * Se il valore e' fermo da dieci giorni, l'unica riga che lo dice e' quella di
 * dieci giorni fa. Cancellarla non toglie un giorno dalla finestra: toglie il
 * valore di tutti i giorni fino al gradino successivo, e prezzo_al()/costo_al()
 * cominciano a rispondere NULL su giorni che invece conosciamo benissimo.
 *
 * Quindi due passi, dentro una transazione perche' fra l'uno e l'altro il
 * registro sarebbe monco:
 *   1. ANCORA — per ogni serie, l'ultimo gradino sotto il pavimento viene
 *      riscritto con la data del pavimento. Se in quel giorno esiste gia' un
 *      gradino vero, vince quello (DO NOTHING): e' una misura, l'ancora e' una
 *      proiezione.
 *   2. TAGLIO — via tutto cio' che sta sotto il pavimento.
 * La serie resta identica da pavimento in avanti; sotto non si chiede piu'.
 */
async function ruotaRegistro(tenantId, tenantName, registro, giorniTenuta = GIORNI_TENUTA) {
  const reg = typeof registro === 'string' ? REGISTRI[registro] : registro;
  const tag = `[Storico:${reg.nome}]`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pavimento = `((NOW() AT TIME ZONE 'Europe/Rome')::date - $2::int)`;

    const { rowCount: ancorate } = await client.query(`
      INSERT INTO ${reg.tabella} (tenant_id, sku, data, source, ${reg.colonnaValore}, updated_at)
      SELECT DISTINCT ON (h.sku, h.source)
             h.tenant_id, h.sku, ${pavimento}, h.source, h.${reg.colonnaValore}, NOW()
      FROM ${reg.tabella} h
      WHERE h.tenant_id = $1 AND h.data < ${pavimento}
      ORDER BY h.sku, h.source, h.data DESC
      ON CONFLICT (tenant_id, sku, data, source) DO NOTHING
    `, [tenantId, giorniTenuta]);

    const { rowCount: tagliate } = await client.query(`
      DELETE FROM ${reg.tabella}
      WHERE tenant_id = $1 AND data < ${pavimento}
    `, [tenantId, giorniTenuta]);

    await client.query('COMMIT');
    if (ancorate || tagliate) {
      console.log(`${tag} ${tenantName}: rotazione — ${ancorate} ancorate al pavimento, ${tagliate} righe vecchie tolte (tenuta ${giorniTenuta}gg)`);
    }
    return { ancorate, tagliate };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`${tag} ${tenantName}: rotazione fallita — ${err.message}`);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * BACKFILL — l'importazione una-tantum che ha ordinato il capo, su TUTTI i
 * tenant e TUTTI e due i registri.
 *
 * Non guarda la finestra notturna: e' un'operazione che si lancia a mano una
 * volta e deve andare fino in fondo. Va in serie, un tenant e un registro alla
 * volta, per non prendersi piu' di uno dei tre slot della coda Farmabooster —
 * il sync prodotti continua a girare mentre questo lavora.
 *
 * Riprende da solo: ogni registro ha il suo checkpoint, quindi se cade a meta'
 * basta rilanciarlo. I tenant gia' completi entro ETA_SPAZZATA_ORE si saltano
 * a meno di forzare.
 */
async function backfillTutti(opzioni = {}) {
  if (lavoroInCorso) {
    console.log('[Storico] un lavoro e\' gia\' in corso, backfill non avviato');
    return null;
  }
  const registri = opzioni.registri || ['costi', 'prezzi'];
  // Fette da 2 ore: sotto la validita' del lucchetto (3h), che si rinnova a
  // ogni registro finito. Una fetta piu' lunga del lucchetto lo lascerebbe
  // scadere a meta' lavoro e la spazzata notturna entrerebbe lo stesso.
  const budgetMin = opzioni.budgetMin || 120;
  const forza = opzioni.forza === true;

  // Ordine per click degli ultimi 30 giorni, non alfabetico: il backfill dura
  // ore e chi sta fermo puo' aspettare. Cosi' i tenant su cui si decide davvero
  // hanno il registro pieno per primi, e non serve tenere una lista di nomi in
  // codice che invecchia da sola.
  const { rows: tenants } = await pool.query(`
    SELECT t.id, t.name,
           COALESCE((SELECT SUM(z.clicks) FROM zombie_clicks z
                     WHERE z.tenant_id = t.id
                       AND z.fetch_date >= ((NOW() AT TIME ZONE 'Europe/Rome')::date - 30)), 0) AS click30
    FROM tenants t WHERE t.status = 'active'
    ORDER BY click30 DESC, t.name
  `);

  lavoroInCorso = true;
  const esito = [];
  const t0 = Date.now();
  await prendiLucchetto();
  console.log(`[Storico] BACKFILL avviato — ${tenants.length} tenant x ${registri.length} registri`);
  // Registro fuori, tenant dentro: prima i COSTI di tutta la rete, poi i
  // prezzi. La gamba rotta e' il costo — e' quella che ha prodotto 54 falsi
  // sotto-costo — e finche' manca a un tenant quel tenant non si puo' misurare.
  // Con l'ordine inverso l'ultima farmacia avrebbe aspettato il registro prezzi
  // di tutte le altre prima di avere il proprio costo.
  try {
    for (const nome of registri) {
      for (const t of tenants) {
        await prendiLucchetto();   // rinnovo: il giro dura ore
        const reg = REGISTRI[nome];
        if (!forza) {
          const { rows } = await pool.query(
            'SELECT updated_at FROM health_config WHERE tenant_id = $1 AND config_key = $2',
            [t.id, reg.chiaveSpazzata]
          );
          const ultima = rows[0] && rows[0].updated_at;
          if (ultima && (Date.now() - new Date(ultima).getTime()) < ETA_SPAZZATA_ORE * 3600 * 1000) {
            console.log(`[Storico:${nome}] ${t.name}: gia' fresco, salto`);
            esito.push({ tenant: t.name, registro: nome, saltato: true });
            continue;
          }
        }
        try {
          // Un registro puo' richiedere piu' fette: si insiste finche' non e'
          // completo o finche' una fetta non fa piu' progresso (paracadute
          // contro un checkpoint che non avanza).
          let giri = 0, ultimaPagina = -1, r;
          do {
            r = await spazzaTenant(t.id, t.name, nome, { budgetMin });
            giri++;
            if (r.pagina === ultimaPagina) {
              console.error(`[Storico:${nome}] ${t.name}: nessun progresso a pagina ${r.pagina}, fermo`);
              break;
            }
            ultimaPagina = r.pagina;
          } while (!r.completata && giri < 20);
          esito.push({ tenant: t.name, registro: nome, ...r });
        } catch (err) {
          console.error(`[Storico:${nome}] ${t.name}: FALLITO — ${err.message}`);
          esito.push({ tenant: t.name, registro: nome, errore: err.message });
        }
      }
    }
  } finally {
    lavoroInCorso = false;
    try { await mollaLucchetto(); } catch (e) { console.error('[Storico] lucchetto:', e.message); }
  }
  const min = Math.round((Date.now() - t0) / 60000);
  const ok = esito.filter(e => e.completata).length;
  console.log(`[Storico] BACKFILL finito in ${min} min — ${ok}/${esito.length} completi`);
  try {
    await sendTelegram([
      `📚 BACKFILL STORICI finito — ${ok}/${esito.length} completi in ${min} min`,
      '',
      ...esito.map(e => e.saltato
        ? `• ${e.tenant} ${e.registro}: gia' fresco`
        : e.errore
          ? `• ${e.tenant} ${e.registro}: ERRORE ${e.errore}`
          : `• ${e.tenant} ${e.registro}: ${e.cambiate} variazioni, ${e.minuti} min`),
      '',
      'Da adesso margine e sotto-costo si misurano sul valore del giorno della vendita.',
    ].join('\n'));
  } catch (e) { console.error('[Storico] telegram:', e.message); }
  return esito;
}

/**
 * Un giro del loop notturno: una fetta sul (tenant, registro) piu' stantio.
 *
 * Uno alla volta, e solo di notte. Dopo il backfill questo serve solo come
 * riconciliazione: il presente lo tiene il gradino dentro il sync prodotti,
 * ogni ora. Ma passa per la stessa coda Farmabooster del sync (tre slot in
 * tutto): di giorno rallenterebbe di un terzo proprio il sync che porta i
 * valori freschi alle decisioni.
 */
async function runCostHistorySweep() {
  if (lavoroInCorso) {
    console.log('[Storico] lavoro precedente ancora in corso, salto il giro');
    return null;
  }
  const oraItalia = parseInt(new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome', hour: '2-digit', hour12: false,
  }).format(new Date()), 10);

  if (oraItalia < ORA_NOTTE_DA || oraItalia >= ORA_NOTTE_A) {
    return null;   // silenzio: e' solo giorno, non e' un guasto
  }

  if (await lucchettoAttivo()) {
    console.log('[Storico] backfill in corso in un altro processo, salto il giro');
    return null;
  }

  const { rows } = await pool.query(`
    SELECT t.id, t.name,
           MAX(hc.updated_at) FILTER (WHERE hc.config_key = 'cost_history_sweep_at')  AS ultima_costi,
           MAX(hc.updated_at) FILTER (WHERE hc.config_key = 'price_history_sweep_at') AS ultima_prezzi
    FROM tenants t
    LEFT JOIN health_config hc ON hc.tenant_id = t.id
    WHERE t.status = 'active'
    GROUP BY t.id, t.name
  `);

  // Un candidato per ogni coppia (tenant, registro): si sceglie il piu' vecchio
  // fra tutti, cosi' i due registri non si affamano a vicenda.
  const scaduto = (d) => !d || (Date.now() - new Date(d).getTime()) > ETA_SPAZZATA_ORE * 3600 * 1000;
  const candidati = [];
  for (const t of rows) {
    if (scaduto(t.ultima_costi)) candidati.push({ ...t, registro: 'costi', ultima: t.ultima_costi });
    if (scaduto(t.ultima_prezzi)) candidati.push({ ...t, registro: 'prezzi', ultima: t.ultima_prezzi });
  }
  candidati.sort((a, b) => {
    if (!a.ultima) return -1;
    if (!b.ultima) return 1;
    return new Date(a.ultima) - new Date(b.ultima);
  });
  const candidato = candidati[0];

  if (!candidato) {
    // Tutti freschi: e' il momento buono per la rotazione, che costa solo DB.
    await ruotaTutti();
    console.log('[Storico] tutti i registri freschi, nessuna spazzata');
    return null;
  }
  const eta = candidato.ultima
    ? `${Math.round((Date.now() - new Date(candidato.ultima).getTime()) / 3600000)}h`
    : 'mai';
  console.log(`[Storico:${candidato.registro}] spazzo ${candidato.name} (ultima: ${eta})`);
  lavoroInCorso = true;
  try {
    return await spazzaTenant(candidato.id, candidato.name, candidato.registro);
  } catch (err) {
    console.error(`[Storico:${candidato.registro}] ${candidato.name} fallita: ${err.message}`);
    // Nessun battito: la guardia lo vedra' e avvisera'.
    return null;
  } finally {
    lavoroInCorso = false;
  }
}

/** Rotazione di tutti i tenant e tutti i registri. Solo DB, nessuna API. */
async function ruotaTutti(giorniTenuta = GIORNI_TENUTA) {
  const { rows } = await pool.query("SELECT id, name FROM tenants WHERE status = 'active' ORDER BY name");
  let tagliate = 0;
  for (const t of rows) {
    for (const nome of Object.keys(REGISTRI)) {
      try {
        const r = await ruotaRegistro(t.id, t.name, nome, giorniTenuta);
        tagliate += r.tagliate;
      } catch (e) { /* gia' loggato, la rotazione non deve fermare il loop */ }
    }
  }
  return { tagliate };
}

/**
 * GUARDIA — il capo: "se si ferma e non e' aggiornato una volta ogni 4 ore
 * almeno ci avvisa".
 *
 * Guarda il battito, non il dato: se i valori non cambiano per quattro ore il
 * registro e' comunque sano, e un allarme in quel caso sarebbe un falso.
 */
async function runCostHistoryGuard() {
  const { rows } = await pool.query(`
    SELECT t.name,
           ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(hc.updated_at)
             FILTER (WHERE hc.config_key = 'cost_history_beat_at'))) / 3600, 1) AS ore_battito,
           ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(hc.updated_at)
             FILTER (WHERE hc.config_key = 'cost_history_sweep_at'))) / 3600, 1) AS ore_costi,
           ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(hc.updated_at)
             FILTER (WHERE hc.config_key = 'price_history_sweep_at'))) / 3600, 1) AS ore_prezzi
    FROM tenants t
    LEFT JOIN health_config hc ON hc.tenant_id = t.id
    WHERE t.status = 'active'
    GROUP BY t.id, t.name
    ORDER BY t.name
  `);

  // Un battito assente vale come guasto solo a grazia scaduta: prima e' l'avvio.
  const inGrazia = (Date.now() - AVVIATO_A) < GRAZIA_AVVIO_MS;
  const fermi = rows.filter(r => (r.ore_battito === null
    ? !inGrazia
    : parseFloat(r.ore_battito) > SOGLIA_BATTITO_ORE));

  if (fermi.length === 0) {
    const maiBattuti = rows.filter(r => r.ore_battito === null).length;
    const coda = inGrazia && maiBattuti
      ? ` (${maiBattuti} non ancora battuti, in grazia d'avvio)`
      : '';
    console.log(`[Storico] guardia OK — ${rows.length} tenant, battito entro ${SOGLIA_BATTITO_ORE}h${coda}`);
    return { allarme: false, fermi: [] };
  }

  const righe = fermi.map(r => {
    const b = r.ore_battito === null ? 'MAI' : `${r.ore_battito}h fa`;
    const c = r.ore_costi === null ? 'costi mai' : `costi ${r.ore_costi}h`;
    const p = r.ore_prezzi === null ? 'prezzi mai' : `prezzi ${r.ore_prezzi}h`;
    return `• ${r.name}: ultimo aggiornamento ${b} (${c}, ${p})`;
  });
  const msg = [
    `🧊 REGISTRI STORICI FERMI — ${fermi.length}/${rows.length} tenant oltre le ${SOGLIA_BATTITO_ORE}h`,
    '',
    ...righe,
    '',
    'Senza valori freschi ogni decisione su margine e sotto-costo viaggia alla cieca.',
    'Controllare: sync prodotti in errore, o API Farmabooster /costhistory /pricehistory non raggiungibili.',
  ].join('\n');
  console.error(`[Storico] GUARDIA IN ALLARME: ${fermi.length} tenant fermi`);
  try { await sendTelegram(msg); } catch (e) { console.error('[Storico] telegram:', e.message); }
  return { allarme: true, fermi: fermi.map(f => f.name) };
}

let cronStarted = false;

function startCostHistoryCron() {
  if (cronStarted) return;
  cronStarted = true;

  // Loop di spazzata: bussa ogni ora, ma entra solo nella finestra notturna e
  // solo se non c'e' gia' un lavoro in corso. Il tick e' orario e non di quattro
  // ore perche' un tick da quattro ore, agganciato all'istante del boot,
  // potrebbe non cadere mai dentro la finestra.
  setTimeout(() => {
    runCostHistorySweep().catch(e => console.error('[Storico] sweep err:', e.message));
    setInterval(() => {
      runCostHistorySweep().catch(e => console.error('[Storico] sweep err:', e.message));
    }, 60 * 60 * 1000);
  }, 10 * 60 * 1000);

  // Guardia: ogni ora. Piu' fitta della soglia, cosi' uno stop di 4 ore si vede
  // entro 5 e non entro 8.
  setTimeout(() => {
    runCostHistoryGuard().catch(e => console.error('[Storico] guardia err:', e.message));
    setInterval(() => {
      runCostHistoryGuard().catch(e => console.error('[Storico] guardia err:', e.message));
    }, 60 * 60 * 1000);
  }, 20 * 60 * 1000);

  console.log(`[Storico] loop attivo — registri costi+prezzi, spazzata notturna ${ORA_NOTTE_DA}-${ORA_NOTTE_A} ITA a fette da ${BUDGET_GIRO_MIN} min con checkpoint, ${PAUSA_PAGINA_MS}ms fra le pagine; rotazione a ${GIORNI_TENUTA}gg; guardia ogni ora (soglia ${SOGLIA_BATTITO_ORE}h)`);
}

module.exports = {
  REGISTRI,
  spazzaTenant,
  ruotaRegistro,
  ruotaTutti,
  backfillTutti,
  runCostHistorySweep,
  runCostHistoryGuard,
  startCostHistoryCron,
  battito,
};
