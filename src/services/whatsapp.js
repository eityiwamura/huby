const axios = require('axios');
require('dotenv').config();

const evolution = axios.create({
  baseURL: process.env.EVOLUTION_API_URL,
  headers: {
    apikey: process.env.EVOLUTION_API_KEY,
    'Content-Type': 'application/json',
  },
  timeout: 15000,
});

const INSTANCE = process.env.EVOLUTION_INSTANCE || 'suporte';

// ─────────────────────────────────────────
// ENVIAR MENSAGEM DE TEXTO
// ─────────────────────────────────────────

async function sendText(phone, message) {
  const number = formatPhone(phone);
  const { data } = await evolution.post(`/message/sendText/${INSTANCE}`, {
    number,
    text: message,
  });
  return data;
}

// ─────────────────────────────────────────
// ENVIAR ALERTA FORMATADO
// ─────────────────────────────────────────

async function sendAlert(phone, alert) {
  const severityEmoji = { critical: '🔴', warning: '🟡', info: '🟢' };
  const emoji = severityEmoji[alert.severity] || '⚠️';

  let message = `${emoji} *Alerta Huby — ${alert.client_name}*\n\n`;
  message += `*${alert.title}*\n`;
  message += `${alert.message}\n`;

  if (alert.ai_diagnosis) {
    message += `\n📋 *Diagnóstico:*\n${alert.ai_diagnosis}\n`;
  }
  if (alert.ai_action) {
    message += `\n🎯 *Ação recomendada:*\n${alert.ai_action}\n`;
  }

  message += `\n_${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}_`;

  return await sendText(phone, message);
}

// ─────────────────────────────────────────
// ENVIAR RELATÓRIO
// ─────────────────────────────────────────

async function sendReport(phone, report) {
  let message = `📊 *Relatório ${report.report_type === 'weekly' ? 'Semanal' : 'Mensal'} — ${report.client_name}*\n\n`;
  message += `📅 Período: ${formatDate(report.period_start)} a ${formatDate(report.period_end)}\n\n`;

  if (report.highlights) {
    message += `*Destaques do período:*\n${report.highlights}\n\n`;
  }

  if (report.reportei_external_url) {
    message += `🔗 *Relatório completo:*\n${report.reportei_external_url}\n\n`;
  }

  if (report.top_actions) {
    message += `🎯 *Próximas ações recomendadas:*\n${report.top_actions}\n\n`;
  }

  message += `_Gerado por Huby — ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}_`;

  return await sendText(phone, message);
}

// ─────────────────────────────────────────
// UTILITÁRIOS
// ─────────────────────────────────────────

function formatPhone(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('55')) return digits;
  return `55${digits}`;
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('pt-BR');
}

module.exports = { sendText, sendAlert, sendReport };
