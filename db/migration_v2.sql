-- MIGRAÇÃO V2 — Novas funcionalidades

-- Perfil da agência
CREATE TABLE IF NOT EXISTS agency_settings (
  id SERIAL PRIMARY KEY,
  agency_name VARCHAR(150) DEFAULT 'Minha Agência',
  logo_url VARCHAR(255),
  primary_color VARCHAR(7) DEFAULT '#5b6ef5',
  reportei_token VARCHAR(255),
  evolution_api_url VARCHAR(255),
  evolution_api_key VARCHAR(255),
  evolution_instance VARCHAR(100),
  anthropic_api_key VARCHAR(255),
  updated_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO agency_settings (agency_name) VALUES ('Minha Agência') ON CONFLICT DO NOTHING;

-- Adicionar colunas de controle de acesso aos usuários
ALTER TABLE users ADD COLUMN IF NOT EXISTS client_access INTEGER[] DEFAULT '{}';
-- client_access = array de IDs de clientes que o usuário pode acessar
-- array vazio = acesso a todos (admin/manager)
-- array com IDs = acesso restrito (analista ou cliente)

ALTER TABLE users ADD COLUMN IF NOT EXISTS user_type VARCHAR(20) DEFAULT 'agency'
  CHECK (user_type IN ('agency', 'client'));
-- agency = usuário da agência
-- client = usuário do cliente (acesso restrito)

ALTER TABLE users ADD COLUMN IF NOT EXISTS client_id INTEGER REFERENCES clients(id);
-- para user_type = 'client', qual cliente ele representa

-- Senha temporária / primeiro acesso
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT false;

-- Relatórios salvos
CREATE TABLE IF NOT EXISTS saved_reports (
  id SERIAL PRIMARY KEY,
  uuid UUID DEFAULT gen_random_uuid() UNIQUE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  title VARCHAR(255) NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  report_data JSONB,
  pdf_path VARCHAR(255),
  public_token VARCHAR(64) UNIQUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_saved_reports_client ON saved_reports(client_id);
CREATE INDEX IF NOT EXISTS idx_saved_reports_token ON saved_reports(public_token);
