-- Daily feed product tracking: "conto corrente" per prodotto
-- Accumula giorno per giorno: click, costo, ordini, revenue
-- Permette decisioni basate su dati reali giornalieri

CREATE TABLE IF NOT EXISTS feed_daily_tracking (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku VARCHAR(50) NOT NULL,
  track_date DATE NOT NULL,

  -- Click del giorno
  clicks INTEGER DEFAULT 0,
  click_cost NUMERIC(10,2) DEFAULT 0,

  -- Ordini del giorno (da Magento)
  orders INTEGER DEFAULT 0,
  revenue NUMERIC(10,2) DEFAULT 0,
  margin_earned NUMERIC(10,2) DEFAULT 0,

  -- Saldo giornaliero (margin_earned - click_cost)
  daily_balance NUMERIC(10,2) DEFAULT 0,

  -- Saldo cumulativo (dall'attivazione TP)
  cumulative_balance NUMERIC(10,2) DEFAULT 0,

  -- Contesto prodotto (snapshot del giorno)
  stock_source VARCHAR(10), -- 'erp', 'supplier', 'both'
  margin_pct NUMERIC(5,1),
  scraper_position INTEGER,
  competitor_count INTEGER,
  sales_30d_aggregated NUMERIC(10,1),
  is_seasonal BOOLEAN DEFAULT false,

  created_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(tenant_id, sku, track_date)
);

CREATE INDEX IF NOT EXISTS idx_fdt_tenant_date ON feed_daily_tracking(tenant_id, track_date);
CREATE INDEX IF NOT EXISTS idx_fdt_tenant_sku ON feed_daily_tracking(tenant_id, sku);
CREATE INDEX IF NOT EXISTS idx_fdt_balance ON feed_daily_tracking(tenant_id, cumulative_balance);

-- Killer products: prodotti che non convertono per nessun seller
CREATE TABLE IF NOT EXISTS feed_killers (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku VARCHAR(50) NOT NULL,

  -- Dati cross-seller
  total_sellers INTEGER DEFAULT 0,
  global_demand NUMERIC(10,1) DEFAULT 0, -- sales_30d_aggregated
  avg_position NUMERIC(5,1),

  -- Perche e killer
  reason TEXT,

  -- Stato
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  quarantine_until TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,

  UNIQUE(tenant_id, sku)
);

-- Feed daily summary: fotografia globale del feed per giorno
CREATE TABLE IF NOT EXISTS feed_daily_summary (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  summary_date DATE NOT NULL,

  -- Budget
  total_clicks INTEGER DEFAULT 0,
  total_cost NUMERIC(10,2) DEFAULT 0,
  cumulative_cost NUMERIC(10,2) DEFAULT 0, -- dall'attivazione
  budget_remaining NUMERIC(10,2),

  -- Revenue
  total_orders INTEGER DEFAULT 0,
  total_revenue NUMERIC(10,2) DEFAULT 0,
  cumulative_revenue NUMERIC(10,2) DEFAULT 0,

  -- Incidenza
  daily_incidence NUMERIC(5,2), -- costo/revenue del giorno
  cumulative_incidence NUMERIC(5,2), -- dall'attivazione

  -- Feed composition
  products_in_feed INTEGER DEFAULT 0,
  products_with_clicks INTEGER DEFAULT 0,
  products_with_orders INTEGER DEFAULT 0,
  products_zero_signal INTEGER DEFAULT 0,
  killers_detected INTEGER DEFAULT 0,

  -- Azioni del giorno
  removed_count INTEGER DEFAULT 0,
  added_count INTEGER DEFAULT 0,
  price_cuts_count INTEGER DEFAULT 0,

  created_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(tenant_id, summary_date)
);
