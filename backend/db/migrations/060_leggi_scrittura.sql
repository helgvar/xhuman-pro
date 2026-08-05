-- 060: LE LEGGI AL MOMENTO DELLA SCRITTURA (capo 14/7: "risuccederà?")
-- Tre leggi che finora vivevano nei motori (e ogni tanto un motore le
-- dimenticava) diventano trigger DB: valgono per OGNI scrittore, per sempre.
--
-- L1. MAI RIALZI (regola aurea 10/7, universale): nessuna raccomandazione
--     sopra il prezzo vivo (applied/exported/sell), da QUALSIASI sorgente.
--     Harvest, calibratore, o il motore che inventeranno l'anno prossimo:
--     tutti sbattono qui.
-- L2. CHI VENDE IN RETE NON SI CONDANNA (quadra 8/7 + tiro-alla-fune 14/7):
--     killer/quarantene/REMOVE su SKU con ordini di rete 15g = veto al
--     momento dell'INSERT. Niente più giri persi in attesa del winback.
--     (Eccezione: quarantene DELIBERATE manual_override — dieta costi.)
-- L3. I DELETE ANONIMI NON TOCCANO IL LAVORO DI SESSIONE/CAPO: cancellare
--     righe manual/pulizia/scavalco/pin senza firmarsi = veto + verbale.

-- ============ L1: MAI RIALZI (universale) ============
CREATE OR REPLACE FUNCTION trg_veto_rialzi_universale_fn() RETURNS TRIGGER AS $$
DECLARE
  v_vivo NUMERIC;
BEGIN
  IF NEW.recommended_price IS NOT NULL THEN
    SELECT COALESCE(p.applied_price, p.exported_price, p.sell_price) INTO v_vivo
    FROM products p WHERE p.tenant_id = NEW.tenant_id AND p.sku = NEW.sku;
    IF v_vivo IS NOT NULL AND NEW.recommended_price > v_vivo + 0.005 THEN
      INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
      VALUES (NEW.tenant_id, NEW.sku, 'veto_arbitro', 'recommended_price',
              v_vivo::text || ' (prezzo vivo)', NEW.recommended_price::text || ' (RIALZO bloccato)',
              COALESCE(NULLIF(current_setting('xhp.writer', true), ''), 'anonimo'),
              'L1 regola aurea: mai raccomandare sopra il prezzo vivo', NEW.action_source);
      NEW.recommended_price := NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_veto_rialzi_universale ON feed_actions;
CREATE TRIGGER trg_veto_rialzi_universale BEFORE INSERT OR UPDATE ON feed_actions
FOR EACH ROW EXECUTE FUNCTION trg_veto_rialzi_universale_fn();

-- ============ L2: CHI VENDE IN RETE NON SI CONDANNA ============
CREATE OR REPLACE FUNCTION vende_in_rete_15g(p_sku TEXT) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id = o.id
    WHERE oi.sku = p_sku AND o.order_date >= NOW() - INTERVAL '15 days'
      AND o.order_status NOT IN ('canceled','closed'))
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION trg_veto_condanna_vendente_fn() RETURNS TRIGGER AS $$
BEGIN
  -- Campi per-tabella via JSON (fix 14/7: NEW.manual_override compilava male
  -- su feed_killers/feed_actions che non hanno la colonna → INSERT falliti)
  IF TG_TABLE_NAME = 'feed_quarantine'
     AND COALESCE((row_to_json(NEW)->>'manual_override')::boolean, false) THEN
    RETURN NEW;  -- dieta deliberata: la rete non ripaga i click locali
  END IF;
  IF TG_TABLE_NAME = 'feed_actions'
     AND COALESCE(row_to_json(NEW)->>'action','') <> 'REMOVE' THEN
    RETURN NEW;
  END IF;
  IF vende_in_rete_15g(NEW.sku) THEN
    INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
    VALUES (NEW.tenant_id, NEW.sku, 'veto_arbitro', TG_TABLE_NAME, NULL, 'condanna bloccata',
            COALESCE(NULLIF(current_setting('xhp.writer', true), ''), 'anonimo'),
            'L2: lo SKU vende in RETE 15g - non si condanna (quadra 8/7)', NULL);
    RETURN NULL;  -- insert soppresso
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_veto_condanna_vendente_k ON feed_killers;
CREATE TRIGGER trg_veto_condanna_vendente_k BEFORE INSERT ON feed_killers
FOR EACH ROW EXECUTE FUNCTION trg_veto_condanna_vendente_fn();
DROP TRIGGER IF EXISTS trg_veto_condanna_vendente_q ON feed_quarantine;
CREATE TRIGGER trg_veto_condanna_vendente_q BEFORE INSERT ON feed_quarantine
FOR EACH ROW EXECUTE FUNCTION trg_veto_condanna_vendente_fn();
DROP TRIGGER IF EXISTS trg_veto_condanna_vendente_r ON feed_actions;
CREATE TRIGGER trg_veto_condanna_vendente_r BEFORE INSERT ON feed_actions
FOR EACH ROW WHEN (NEW.action = 'REMOVE') EXECUTE FUNCTION trg_veto_condanna_vendente_fn();

-- ============ L3: DELETE ANONIMI SU FONTI PROTETTE = VETO ============
CREATE OR REPLACE FUNCTION trg_arbitro_delete_fn() RETURNS TRIGGER AS $$
DECLARE
  v_writer TEXT := COALESCE(NULLIF(current_setting('xhp.writer', true), ''), 'anonimo');
BEGIN
  IF v_writer = 'anonimo'
     AND (COALESCE(OLD.action_source,'') IN ('manual_pepita','manual','capo_pin','muro_scavalco')
          OR OLD.action_source LIKE 'pulizia_%') THEN
    INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
    VALUES (OLD.tenant_id, OLD.sku, 'veto_arbitro', 'delete',
            COALESCE(OLD.recommended_price::text, OLD.action), 'DELETE bloccato', v_writer,
            'L3: fonte protetta - i delete anonimi non toccano il lavoro di sessione/capo', OLD.action_source);
    RETURN NULL;  -- delete soppresso
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;

-- Ordinamento: questo trigger (nome 'aa_') scatta PRIMA di trg_arbitro_azioni,
-- che continua a VERBALIZZARE i delete legittimi.
DROP TRIGGER IF EXISTS aa_trg_arbitro_delete ON feed_actions;
CREATE TRIGGER aa_trg_arbitro_delete BEFORE DELETE ON feed_actions
FOR EACH ROW EXECUTE FUNCTION trg_arbitro_delete_fn();

INSERT INTO schema_migrations (filename)
SELECT '060_leggi_scrittura.sql'
WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE filename='060_leggi_scrittura.sql');
