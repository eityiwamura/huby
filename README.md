# ⚡ Huby — Marketing Intelligence com IA

Plataforma de análise de marketing digital para agências. Integra Reportei API, Claude AI e Evolution API (WhatsApp) para análise automatizada de clientes.

## Stack
- **Backend:** Node.js + Express
- **Banco:** PostgreSQL
- **IA:** Anthropic Claude (claude-sonnet-4-20250514)
- **Dados:** Reportei API v2
- **WhatsApp:** Evolution API
- **Deploy:** EasyPanel / Docker

## Instalação

### 1. Clonar e configurar
```bash
git clone https://github.com/eityiwamura/huby.git
cd huby
cp .env.example .env
# Editar .env com suas credenciais
```

### 2. Banco de dados
```bash
# Criar banco no PostgreSQL
createdb huby

# Aplicar schema
psql huby < db/schema.sql
```

### 3. Instalar dependências e rodar
```bash
npm install
npm start
```

### 4. Deploy no EasyPanel
- Criar nova aplicação no EasyPanel
- Vincular ao repositório GitHub
- Configurar variáveis de ambiente (copiar do .env.example)
- Configurar PostgreSQL como serviço separado
- Porta: 3000

## Acesso inicial
- URL: http://seu-servidor:3000
- Email: admin@huby.local
- Senha: **huby@2024** ← trocar imediatamente no primeiro acesso

## Módulos

### Clientes
- Cadastro com sincronização automática de integrações do Reportei
- Sugestão de ticket médio por IA
- Suporte a clientes políticos (vereadores, deputados)

### Análise IA
- Tráfego pago (Meta Ads, Google Ads, TikTok Ads)
- Orgânico (Instagram, Facebook, TikTok, LinkedIn)
- SEO + Google Meu Negócio
- Cross-channel (visão integrada)
- Análise política

### Alertas automáticos
- CPL/CPC alto
- Zero conversões
- ROAS baixo
- Frequência alta (Meta)
- Baixo engajamento
- Sem postagens
- Queda de seguidores
- Diagnóstico IA em cada alerta
- Entrega via WhatsApp

### Relatórios
- Criação automática no Reportei
- Análise IA com destaques
- Entrega via WhatsApp (link + resumo)
- Agendamento semanal e mensal

### Chat contextual
- Chat com IA por cliente
- Contexto completo (setor, integrações, benchmarks)
- Histórico da sessão

## Variáveis de ambiente necessárias
```
PORT=3000
DATABASE_URL=postgresql://...
ANTHROPIC_API_KEY=...
REPORTEI_TOKEN=...
EVOLUTION_API_URL=...
EVOLUTION_API_KEY=...
EVOLUTION_INSTANCE=suporte
SESSION_SECRET=...
```
