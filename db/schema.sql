-- HUBY — Schema PostgreSQL v1
-- Plataforma de Marketing Intelligence com IA

-- Extensões
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─────────────────────────────────────────
-- USUÁRIOS (time da agência)
-- ─────────────────────────────────────────
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(120) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) DEFAULT 'analyst' CHECK (role IN ('admin','manager','analyst')),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- CLIENTES
-- ─────────────────────────────────────────
CREATE TABLE clients (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  slug VARCHAR(150) UNIQUE NOT NULL,
  sector VARCHAR(50) NOT NULL CHECK (sector IN (
    'clinica','odontologia','ecommerce','infoproduto',
    'varejo_local','advocacia','imobiliaria','educacao',
    'alimentacao','beleza','politico','outro'
  )),
  business_type VARCHAR(100),          -- descrição livre do negócio
  city VARCHAR(100),
  state CHAR(2),
  phone VARCHAR(30),                   -- WhatsApp para receber alertas/relatórios
  logo_url VARCHAR(255),

  -- Dados financeiros (sugeridos por IA ou informados)
  avg_ticket DECIMAL(10,2),            -- ticket médio em R$
  avg_ticket_suggested DECIMAL(10,2),  -- sugestão da IA
  avg_ticket_source VARCHAR(20) DEFAULT 'manual' CHECK (avg_ticket_source IN ('manual','ai_suggested','confirmed')),

  -- Dados políticos (preenchidos quando sector = 'politico')
  political_mandate VARCHAR(30) CHECK (political_mandate IN ('vereador','deputado_estadual','deputado_federal','senador','prefeito',NULL)),
  political_party VARCHAR(50),
  political_next_election INTEGER,     -- ano da próxima eleição
  political_base_description TEXT,     -- descrição da base eleitoral
  political_causes TEXT,               -- principais bandeiras

  -- Vínculo com Reportei
  reportei_project_id INTEGER,         -- ID do projeto no Reportei
  reportei_last_sync TIMESTAMP,

  -- Config de relatórios
  report_weekly BOOLEAN DEFAULT false,
  report_monthly BOOLEAN DEFAULT true,
  report_day_of_month INTEGER DEFAULT 1,  -- dia do mês para relatório mensal
  report_send_whatsapp BOOLEAN DEFAULT true,

  -- Responsável interno
  responsible_user_id INTEGER REFERENCES users(id),

  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- CONCORRENTES DOS CLIENTES
-- ─────────────────────────────────────────
CREATE TABLE client_competitors (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name VARCHAR(150) NOT NULL,
  instagram_url VARCHAR(255),
  facebook_url VARCHAR(255),
  tiktok_url VARCHAR(255),
  website_url VARCHAR(255),
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- INTEGRAÇÕES POR CLIENTE (sync com Reportei)
-- ─────────────────────────────────────────
CREATE TABLE client_integrations (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  reportei_integration_id INTEGER NOT NULL,  -- ID da integração no Reportei
  slug VARCHAR(60) NOT NULL,                 -- ex: facebook_ads, instagram_business
  name VARCHAR(150),                         -- nome da conta no Reportei
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active','expired','revoked','unknown')),

  -- Controle de monitoramento
  is_monitored BOOLEAN DEFAULT true,
  alerts_enabled BOOLEAN DEFAULT true,

  -- Config de alertas específicos por integração
  post_frequency_days INTEGER DEFAULT 3,     -- dias sem postar = alerta
  min_engagement_rate DECIMAL(5,2),          -- % mínimo de engajamento
  max_cpl DECIMAL(10,2),                     -- CPL máximo aceitável (tráfego pago)
  max_cpc DECIMAL(10,2),                     -- CPC máximo aceitável
  min_roas DECIMAL(5,2),                     -- ROAS mínimo aceitável

  reportei_last_sync TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  UNIQUE (client_id, reportei_integration_id)
);

-- ─────────────────────────────────────────
-- ANÁLISES DE IA
-- ─────────────────────────────────────────
CREATE TABLE ai_analyses (
  id SERIAL PRIMARY KEY,
  uuid UUID DEFAULT uuid_generate_v4() UNIQUE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),      -- quem solicitou (null = automático)

  analysis_type VARCHAR(30) NOT NULL CHECK (analysis_type IN (
    'paid_traffic','organic','seo_gmb','cross_channel',
    'competitor','opportunity','political','full'
  )),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  comparison_start DATE,
  comparison_end DATE,

  -- Dados brutos enviados para IA (JSON do Reportei)
  raw_data JSONB,

  -- Resultado da IA
  diagnosis TEXT,                    -- diagnóstico completo
  attention_points JSONB,            -- array de pontos de atenção
  working_well JSONB,                -- array do que está funcionando
  action_plan JSONB,                 -- array de ações ranqueadas
  projection TEXT,                   -- projeção dos próximos 30 dias

  -- Metadados
  model_used VARCHAR(50),
  tokens_used INTEGER,
  generation_time_ms INTEGER,
  triggered_by VARCHAR(20) DEFAULT 'manual' CHECK (triggered_by IN ('manual','scheduled','alert')),

  created_at TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- RECOMENDAÇÕES DA IA (rastreamento)
-- ─────────────────────────────────────────
CREATE TABLE ai_recommendations (
  id SERIAL PRIMARY KEY,
  analysis_id INTEGER NOT NULL REFERENCES ai_analyses(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  priority INTEGER,                  -- 1 = maior impacto
  action TEXT NOT NULL,              -- o que fazer
  reason TEXT,                       -- por que fazer
  expected_impact TEXT,              -- impacto estimado
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','accepted','ignored','done')),
  accepted_at TIMESTAMP,
  done_at TIMESTAMP,
  outcome_notes TEXT,                -- resultado após execução
  created_at TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- ALERTAS
-- ─────────────────────────────────────────
CREATE TABLE alerts (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  integration_id INTEGER REFERENCES client_integrations(id),

  alert_type VARCHAR(50) NOT NULL CHECK (alert_type IN (
    'no_post','low_engagement','no_conversions',
    'high_cpl','high_cpc','low_roas','budget_exhausted',
    'campaign_paused','high_frequency','integration_expired',
    'negative_review','follower_drop','political_deadline',
    'ad_rejected','campaign_no_budget'
  )),
  severity VARCHAR(10) DEFAULT 'warning' CHECK (severity IN ('critical','warning','info')),
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  ai_diagnosis TEXT,                 -- diagnóstico da IA
  ai_action TEXT,                    -- ação recomendada pela IA

  -- Controle de envio
  sent_whatsapp BOOLEAN DEFAULT false,
  whatsapp_sent_at TIMESTAMP,
  resolved BOOLEAN DEFAULT false,
  resolved_at TIMESTAMP,
  resolved_by INTEGER REFERENCES users(id),

  -- Dados que geraram o alerta
  metric_value DECIMAL(10,4),
  metric_threshold DECIMAL(10,4),
  metric_unit VARCHAR(20),

  created_at TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- RELATÓRIOS
-- ─────────────────────────────────────────
CREATE TABLE reports (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),

  title VARCHAR(255) NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  report_type VARCHAR(20) DEFAULT 'monthly' CHECK (report_type IN ('weekly','monthly','custom')),

  -- Reportei
  reportei_report_id INTEGER,
  reportei_external_url VARCHAR(500),

  -- Análise IA vinculada
  ai_analysis_id INTEGER REFERENCES ai_analyses(id),

  -- Entrega
  sent_whatsapp BOOLEAN DEFAULT false,
  whatsapp_sent_at TIMESTAMP,
  whatsapp_message TEXT,

  triggered_by VARCHAR(20) DEFAULT 'manual' CHECK (triggered_by IN ('manual','scheduled')),
  created_at TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- CALENDÁRIO EDITORIAL
-- ─────────────────────────────────────────
CREATE TABLE content_calendar (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  ai_analysis_id INTEGER REFERENCES ai_analyses(id),

  month INTEGER NOT NULL,
  year INTEGER NOT NULL,
  platform VARCHAR(30),              -- instagram, tiktok, facebook, etc
  content_type VARCHAR(30),          -- reels, carrossel, stories, post, live

  suggested_date DATE,
  suggested_time TIME,
  theme TEXT NOT NULL,               -- tema/assunto do conteúdo
  caption_suggestion TEXT,           -- sugestão de legenda
  hashtag_suggestions TEXT[],        -- array de hashtags
  brief_notes TEXT,                  -- notas para o criativo
  rationale TEXT,                    -- por que esse conteúdo foi sugerido

  status VARCHAR(20) DEFAULT 'suggested' CHECK (status IN ('suggested','approved','published','skipped')),
  created_at TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- BRIEFINGS DE CRIATIVO
-- ─────────────────────────────────────────
CREATE TABLE creative_briefs (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),

  title VARCHAR(255) NOT NULL,
  objective VARCHAR(50) CHECK (objective IN ('awareness','engagement','leads','sales','retention','political_image')),
  platform VARCHAR(30),
  format VARCHAR(30),                -- video, imagem, carrossel, stories

  -- Conteúdo do brief
  main_message TEXT,
  target_audience TEXT,
  tone_of_voice TEXT,
  visual_references TEXT,
  cta TEXT,
  do_list TEXT[],
  dont_list TEXT[],
  extra_notes TEXT,

  status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft','sent','in_production','done')),
  created_at TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- CHAT COM IA POR CLIENTE
-- ─────────────────────────────────────────
CREATE TABLE ai_chats (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  session_id UUID DEFAULT uuid_generate_v4(),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE ai_chat_messages (
  id SERIAL PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES ai_chats(id) ON DELETE CASCADE,
  role VARCHAR(10) NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  tokens_used INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- BENCHMARKS POR SETOR (alimentados manualmente ou por IA)
-- ─────────────────────────────────────────
CREATE TABLE sector_benchmarks (
  id SERIAL PRIMARY KEY,
  sector VARCHAR(50) NOT NULL,
  city_size VARCHAR(20) CHECK (city_size IN ('small','medium','large','capital')),
  platform VARCHAR(30),
  metric VARCHAR(50),
  min_value DECIMAL(10,4),
  avg_value DECIMAL(10,4),
  max_value DECIMAL(10,4),
  unit VARCHAR(20),
  reference_date DATE,
  source VARCHAR(100),
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- ÍNDICES
-- ─────────────────────────────────────────
CREATE INDEX idx_clients_sector ON clients(sector);
CREATE INDEX idx_clients_reportei ON clients(reportei_project_id);
CREATE INDEX idx_integrations_client ON client_integrations(client_id);
CREATE INDEX idx_integrations_slug ON client_integrations(slug);
CREATE INDEX idx_analyses_client ON ai_analyses(client_id);
CREATE INDEX idx_analyses_type ON ai_analyses(analysis_type);
CREATE INDEX idx_analyses_created ON ai_analyses(created_at DESC);
CREATE INDEX idx_alerts_client ON alerts(client_id);
CREATE INDEX idx_alerts_resolved ON alerts(resolved);
CREATE INDEX idx_reports_client ON reports(client_id);
CREATE INDEX idx_calendar_client_month ON content_calendar(client_id, year, month);
CREATE INDEX idx_chat_messages_chat ON ai_chat_messages(chat_id);

-- ─────────────────────────────────────────
-- DADOS INICIAIS — benchmarks básicos
-- ─────────────────────────────────────────
INSERT INTO sector_benchmarks (sector, city_size, platform, metric, min_value, avg_value, max_value, unit, source) VALUES
-- Meta Ads — Clínica / Saúde
('clinica', 'medium', 'facebook_ads', 'cpl', 25.00, 45.00, 90.00, 'BRL', 'mercado_br_2024'),
('clinica', 'medium', 'facebook_ads', 'cpc', 0.80, 1.80, 4.00, 'BRL', 'mercado_br_2024'),
('clinica', 'medium', 'facebook_ads', 'ctr', 0.80, 1.50, 3.00, '%', 'mercado_br_2024'),
-- Meta Ads — Odontologia
('odontologia', 'medium', 'facebook_ads', 'cpl', 30.00, 55.00, 120.00, 'BRL', 'mercado_br_2024'),
('odontologia', 'medium', 'facebook_ads', 'cpc', 1.00, 2.20, 5.00, 'BRL', 'mercado_br_2024'),
-- Meta Ads — E-commerce
('ecommerce', 'large', 'facebook_ads', 'roas', 2.00, 4.00, 8.00, 'x', 'mercado_br_2024'),
('ecommerce', 'large', 'facebook_ads', 'cpc', 0.50, 1.20, 3.00, 'BRL', 'mercado_br_2024'),
-- Instagram — Engajamento médio por setor
('clinica', 'medium', 'instagram_business', 'engagement_rate', 1.50, 3.00, 6.00, '%', 'mercado_br_2024'),
('odontologia', 'medium', 'instagram_business', 'engagement_rate', 1.80, 3.50, 7.00, '%', 'mercado_br_2024'),
('beleza', 'medium', 'instagram_business', 'engagement_rate', 2.00, 4.50, 9.00, '%', 'mercado_br_2024'),
('alimentacao', 'medium', 'instagram_business', 'engagement_rate', 1.50, 3.20, 6.50, '%', 'mercado_br_2024'),
-- Ticket médio sugerido por setor
('odontologia', 'medium', NULL, 'avg_ticket', 800.00, 2500.00, 8000.00, 'BRL', 'mercado_br_2024'),
('clinica', 'medium', NULL, 'avg_ticket', 200.00, 650.00, 2000.00, 'BRL', 'mercado_br_2024'),
('advocacia', 'medium', NULL, 'avg_ticket', 1500.00, 5000.00, 20000.00, 'BRL', 'mercado_br_2024'),
('imobiliaria', 'medium', NULL, 'avg_ticket', 180000.00, 420000.00, 900000.00, 'BRL', 'mercado_br_2024'),
('beleza', 'medium', NULL, 'avg_ticket', 80.00, 250.00, 800.00, 'BRL', 'mercado_br_2024'),
('alimentacao', 'medium', NULL, 'avg_ticket', 35.00, 85.00, 200.00, 'BRL', 'mercado_br_2024');

-- Usuário admin padrão (senha: huby@2024 — trocar no primeiro acesso)
INSERT INTO users (name, email, password_hash, role) VALUES
('Admin', 'admin@huby.local', crypt('huby@2024', gen_salt('bf')), 'admin');
