# BRIEF DI PROGETTO — Sito web xHumanPro
**Versione 1.0 — 8 luglio 2026 · Documento per il designer/sviluppatore**

---

## 1. COS'È XHUMANPRO (il contesto che devi capire prima di disegnare)

xHumanPro è una **piattaforma SaaS di intelligenza commerciale per farmacie e parafarmacie online italiane** che vendono sui comparatori di prezzo (Trovaprezzi in primis, Google Shopping in roadmap di comunicazione).

Il problema che risolve: le farmacie online pagano ogni click dei comparatori (~€0,27+IVA l'uno) su cataloghi di decine di migliaia di prodotti, con prezzi che cambiano più volte al giorno e concorrenti che si muovono in massa. Gestire a mano cosa esporre, a che prezzo, e quando ritirarsi è **umanamente impossibile**: si spreca budget su prodotti che non venderanno mai, si perdono posizioni sui prodotti che vendono, e nessuno se ne accorge finché il fatturato non crolla.

xHumanPro è il **copilota AI che governa tutto il ciclo**: decide quali prodotti esporre, a che prezzo (al centesimo, in entrambe le direzioni), rileva i cali e le anomalie in ore invece che in settimane, e trasforma i dati (click reali, ordini reali, posizioni scrappate, margini) in azioni automatiche quotidiane.

**Il nome**: xHuman = oltre l'umano (scala e velocità che un team umano non può reggere) + Pro = professionale, al servizio del farmacista. L'umano resta al comando: la piattaforma esegue, misura e propone; le scelte strategiche restano al titolare.

---

## 2. OBIETTIVO DEL SITO

**Primario**: generare richieste di demo qualificate da titolari/manager di farmacie online italiane (form + calendario).
**Secondari**: dare credibilità al prodotto (numeri, metodo, tecnologia), spiegare un prodotto complesso in modo semplice, posizionare xHumanPro come categoria nuova ("intelligenza commerciale per comparatori"), supportare il passaparola B2B (pagine linkabili e leggibili da un titolare NON tecnico).

**KPI del sito**: richieste demo / mese; tempo di lettura pagina "Come funziona"; % scroll della home.

---

## 3. TARGET

**Persona primaria — Il Titolare** (50-80% delle decisioni): farmacista titolare 35-60 anni con e-commerce attivo, fattura 0,5–10M €/anno online, spende 2.000–30.000 €/mese in comparatori. NON è tecnico. Parla di "incidenza", "ricarico", "posizioni su Trovaprezzi". Diffida delle promesse da agenzia. È bombardato da fornitori. Il suo dolore: *"spendo tanto e non so se rende"*, *"il mio concorrente è sempre un centesimo sotto"*, *"me ne accorgo sempre troppo tardi"*.

**Persona secondaria — L'E-commerce Manager**: 25-40 anni, gestisce operativamente Magento/feed/campagne. Tecnico quanto basta. Cerca strumenti che gli tolgano lavoro manuale e gli diano argomenti col titolare.

**Linguaggio**: italiano, concreto, da banco — non da conference. Ogni claim va tradotto in euro, ore risparmiate o posizioni guadagnate.

---

## 4. POSIZIONAMENTO E MESSAGGI CHIAVE

**Value proposition (bozza da raffinare col copy):**
> *"Il copilota AI che fa rendere ogni centesimo speso su Trovaprezzi. Prezzi al centesimo giusto, prodotti giusti in vetrina, sprechi tagliati — ogni giorno, in automatico, sotto il tuo controllo."*

**I 5 messaggi portanti (uno per sezione della home):**

1. **"Ogni click che paghi deve avere una possibilità di vendere."** — La piattaforma taglia i prodotti che bruciano budget senza vendere (pesando il MARGINE di ognuno, non soglie uguali per tutti) e rimette in vetrina quelli che il mercato chiede.
2. **"Un centesimo prima degli altri. In entrambe le direzioni."** — Quando i concorrenti scendono, insegue al centesimo. Quando SALGONO, recupera margine salendo con loro. L'AI calibra il prezzo di equilibrio pesando i concorrenti prima e dopo, la rotazione del prodotto e i trend di domanda.
3. **"Quello che a mano scopri in tre settimane, qui lo vedi in 24 ore."** — Monitor continui: cali di vendite (ogni 2 ore), posizioni perse, rincari anomali, linee di brand che spariscono dalla vetrina, prodotti che ripartono su altri canali. Con avvisi solo quando serve decidere.
4. **"Il margine prima del fatturato."** — Ogni decisione è pesata sul margine assoluto del singolo prodotto: la piattaforma sa quale posizione in classifica rende di più per OGNI prodotto (non sempre la prima!) e ce lo porta.
5. **"Tu comandi, lei esegue."** — Brand protetti intoccabili, floor di ricarico invalicabili, ogni azione tracciata e reversibile, log completo di ogni ingresso/uscita dal feed. L'automazione ha i guardrail scolpiti nel database.

**Differenzianti vs alternative** (agenzia / repricer generici / fare a mano): decisioni sul margine e non sul fatturato apparente; dati REALI (ordini del gestionale, click effettivi del comparatore, posizioni scrappate — mai stime); ciclo completo esposizione+prezzo+monitoraggio in un solo sistema; reazione in ore; costruito SOLO per la farmacia online italiana.

---

## 5. STRUTTURA DEL SITO (sitemap proposta)

```
Home
├── Come funziona        (il ciclo quotidiano, passo passo, per non tecnici)
├── Cosa fa              (le capacità, raggruppate in 4 pilastri — v. sez. 6)
├── Risultati            (numeri e mini-casi anonimi, metodologia di misura)
├── Per chi è            (titolare vs e-commerce manager: due tagli dello stesso racconto)
├── Prezzi               (placeholder: modello a canone per tenant — da definire col cliente)
├── Chi siamo / Metodo   (filosofia: "la bibbia del margine", umano al comando)
├── Richiedi una demo    (form + calendario)
└── Legal (Privacy GDPR, Cookie, Termini)
```

**Home — flusso narrativo suggerito (scroll):**
1. HERO: value prop + 3 numeri forti + CTA "Richiedi una demo" · visual: dashboard reale stilizzata
2. IL PROBLEMA: 3 dolori in 3 card ("spendi al buio", "sei sempre secondo di un centesimo", "te ne accorgi tardi")
3. LA SOLUZIONE — i 4 pilastri (v. sez. 6) con micro-animazioni
4. COME LAVORA IN UN GIORNO: timeline 24h (alba: dati freschi → mattina: diagnosi e prezzi → giornata: monitor ogni 2h → notte: report) — questa sezione è d'oro per far capire il prodotto
5. NUMERI/PROVE (v. sez. 7)
6. GUARDRAIL & CONTROLLO (fiducia: floor, brand protetti, log, reversibilità)
7. CTA finale + FAQ brevi (6-8 domande)

---

## 6. I 4 PILASTRI DEL PRODOTTO (contenuto per "Cosa fa")

*(Tradotti in linguaggio cliente — il designer NON deve usare i nomi tecnici interni)*

**A. La Vetrina Intelligente** — Decide ogni giorno quali prodotti esporre sul comparatore: dentro chi ha posizione competitiva, domanda o margine forte; fuori chi brucia click senza vendere. Recupera automaticamente i prodotti che ricominciano a vendere su altri canali e le "pepite" nascoste nel listino (alta marginalità già in posizione visibile e mai esposte).

**B. Il Prezzo al Centesimo** — Segue i concorrenti in discesa (mai un euro più del necessario) e li segue IN SALITA (margine recuperato quando il mercato lo consente). Un'AI dedicata calibra i casi difficili: pesa il concorrente prima e quello dopo, quanto vende il prodotto, se la categoria è in trend — e trova l'equilibrio tra appetibilità e margine. Aggiornamento a ogni giro di dati freschi (4 volte al giorno).

**C. La Sentinella** — Monitor continui su vendite (ogni 2 ore), posizioni in classifica, rincari anomali causati dai movimenti di massa dei concorrenti, copertura delle linee di brand, prodotti vincenti con stock in esaurimento. Avvisi su Telegram/email solo quando c'è una decisione da prendere: zero rumore.

**D. Il Registro di Bordo** — Ogni prodotto ha la sua storia tracciata: quando è entrato in vetrina, quando è uscito, perché, a che prezzo, con che risultato. Ogni azione è reversibile. I vincoli del titolare (brand intoccabili, ricarichi minimi) sono scolpiti a livello di database: nessun automatismo può violarli.

---

## 7. PROVE E NUMERI (sezione "Risultati")

*(Numeri reali della rete in produzione — da presentare ANONIMIZZATI e con la dicitura "risultati misurati su rete reale, giugno-luglio 2026". Il cliente finale approverà la lista definitiva.)*

- **10 farmacie online** gestite in produzione, **>350.000 prodotti** valutati ogni giorno
- **-20% di spesa comparatore in 24h** su un tenant, a parità di ordini (taglio chirurgico dei prodotti che bruciavano budget senza vendere)
- **+73% di fatturato in un giorno** su un tenant dopo pulizia degli sprechi e rilancio dei prodotti giusti — con METÀ della spesa precedente
- **Crollo di mercato del 26 giugno** (rincaro di massa dei listini causato dai movimenti dei concorrenti): diagnosticato, quantificato (700 prodotti colpiti) e curato con 286 ripristini di prezzo — recupero della parità in 48h e sorpasso della baseline in 8 giorni. Oggi lo stesso evento verrebbe rilevato e corretto **in 24 ore, automaticamente**
- **4.265 prodotti con domanda provata** ritrovati e rimessi in vetrina da un singolo audit (condanne "scadute" mai riprocessate)
- Recupero medio di **margine su ogni vendita** grazie al prezzo "1 centesimo prima degli altri" invece di sconti generici

*(Placeholder: 2-3 testimonianze titolari, da raccogliere; logo farmacie SOLO previa autorizzazione)*

---

## 8. DIREZIONE DESIGN

**Personalità visiva**: precisione + controllo + energia. È un cruscotto di comando per chi maneggia soldi veri ogni giorno: deve sembrare **strumentazione professionale**, non startup giocattolo né gestionale anni 2000.

**Riferimenti di tono** (non da copiare, da respirare): Linear.app (pulizia e densità), Stripe (fiducia tecnica spiegata semplice), dashboard finanziarie (i numeri come protagonisti).

**Palette** — vincoli TASSATIVI:
- ⛔ **VIETATO ASSOLUTO: viola, indaco, porpora, lilla e qualsiasi tonalità intermedia** — in nessun elemento, mai (vincolo di brand non negoziabile)
- Direzione consigliata: **verde profondo/smeraldo** (salute + denaro + semaforo "vai") come primario, **antracite/quasi-nero** per la struttura, **bianco caldo** per i fondi, un **arancio/ambra** come accento per alert e CTA. Rosso solo semantico (perdite/alert)
- Dark mode benvenuta per le sezioni "dashboard" (è come i clienti la usano la sera)

**Tipografia**: sans moderna e leggibilissima (es. Inter/Söhne-like) + **monospazio/tabulare per TUTTI i numeri** (i numeri sono il prodotto: devono essere belli). Gerarchie nette, molta aria.

**Visual chiave da produrre**:
1. Hero: dashboard stilizzata (NON screenshot crudo) con 3-4 widget riconoscibili: classifica posizioni, margine/€, alert Telegram, trend categoria
2. La "timeline delle 24 ore" (sezione Come lavora) — illustrata, è il pezzo forte
3. Il "centesimo prima degli altri": micro-animazione di una classifica prezzi dove il nostro sale/scende di 1 cent — spiega il prodotto meglio di 1000 parole
4. Prima/dopo di un feed: nuvola di prodotti che si riordina (grigio = spreco eliminato, verde = pepite entrate)
5. Icone/pittogrammi coerenti per i 4 pilastri

**Screenshot reali**: la piattaforma ha una dashboard React esistente (dark sidebar, pagine Trovaprezzi/Ordini/Ottimizzazione) — il designer riceverà accesso demo per trarne composizioni stilizzate. NON pubblicare dati reali dei clienti: tutti i numeri negli screenshot vanno sostituiti con dati fittizi verosimili.

---

## 9. REQUISITI UX & TECNICI

- **Responsive totale** (i titolari leggono dal telefono, la sera)
- **Performance**: LCP < 2s, animazioni leggere (CSS/Lottie, no video pesanti in hero)
- **SEO**: struttura semantica; keyword primarie: *ottimizzazione Trovaprezzi, gestione feed Trovaprezzi farmacia, ridurre costi Trovaprezzi, repricing farmacia online*; blog/risorse in roadmap fase 2 (predisporre il CMS)
- **CMS**: preferenza per soluzione headless o comunque editabile dal team senza sviluppatore (testi, numeri della sezione Risultati, FAQ)
- **Form demo**: nome, farmacia, sito, spesa mensile comparatori (range), telefono/email + integrazione calendario (Cal.com/Calendly); notifica via email/Telegram
- **GDPR**: consensi, cookie banner sobrio, privacy policy (fornita dal cliente)
- **Analytics**: GA4 + eventi su CTA/scroll/form
- Lingua: **solo italiano** al lancio (EN in fase 2 — predisporre i18n)

---

## 10. COSA NON FARE

- Niente viola/indaco/porpora — ripetuto perché è IL vincolo
- Niente gergo tecnico interno (killer, pepite, sweep, cohort...) esposto al cliente: usare il linguaggio della sezione 6
- Niente promesse assolute ("raddoppia il fatturato") — solo numeri misurati con contesto
- Niente stock photo di farmacisti sorridenti col camice: o dati/prodotto o niente
- Niente muri di testo: ogni sezione deve reggersi su titolo + visual + 3 righe
- Non nominare i clienti reali senza autorizzazione scritta

---

## 11. DELIVERABLE RICHIESTI AL DESIGNER

1. Moodboard + 2 direzioni visive (1 round di feedback)
2. Design system essenziale (colori, type scale, componenti, icone pilastri)
3. Home completa (desktop+mobile) in alta fedeltà
4. Le 4 pagine interne chiave (Come funziona, Cosa fa, Risultati, Demo)
5. Micro-animazioni chiave (classifica del centesimo, timeline 24h) anche solo come prototipo
6. Handoff sviluppo (Figma ordinato) — lo sviluppo può essere dello stesso fornitore o interno: predisporre per entrambi

**Materiali che forniremo**: accesso demo alla piattaforma, questa lista numeri aggiornata, logo attuale (o brief separato se serve rebrand), dominio.

**Contatto di progetto**: Stefano Quitadamo — me@stefanoquitadamo.com

---

*Nota finale per il designer: questo prodotto vive di fiducia. Il sito deve far pensare "questi sanno esattamente dove vanno i miei soldi, al centesimo" — se ottieni quella sensazione in 5 secondi di hero, il resto è discesa.*
