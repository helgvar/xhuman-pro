import React, { useState, useEffect } from 'react';
import { authFetch } from '../utils/tokenManager';
import { useAuth } from '../contexts/AuthContext';

const CONFIG_FIELDS = [
  // Farmabooster API
  { key: 'farmabooster_api_url', label: 'API URL', type: 'text', group: 'Farmabooster API' },
  { key: 'farmabooster_api_email', label: 'API Email', type: 'text', group: 'Farmabooster API' },
  { key: 'farmabooster_api_password', label: 'API Password', type: 'password', group: 'Farmabooster API' },
  // Magento 2
  { key: 'magento_base_url', label: 'Base URL', type: 'text', group: 'Magento 2' },
  { key: 'magento_api_token', label: 'Integration Token', type: 'password', group: 'Magento 2' },
  { key: 'magento_store_code', label: 'Store Code', type: 'text', group: 'Magento 2' },
  // Google Analytics
  { key: 'ga4_property_id', label: 'Property ID', type: 'text', group: 'Google Analytics' },
  { key: 'ga4_service_account_email', label: 'Service Account Email', type: 'text', group: 'Google Analytics' },
  { key: 'ga4_credentials_json', label: 'Service Account JSON', type: 'password', group: 'Google Analytics' },
  // Google Merchant Center
  { key: 'google_merchant_id', label: 'Merchant ID', type: 'text', group: 'Google Merchant Center' },
  { key: 'google_merchant_account_id', label: 'Account ID', type: 'text', group: 'Google Merchant Center' },
  // Google Drive
  { key: 'google_drive_folder_id', label: 'Folder ID', type: 'text', group: 'Google Drive' },
  { key: 'google_drive_service_account', label: 'Service Account Email', type: 'text', group: 'Google Drive' },
  // Google OAuth (condiviso)
  { key: 'google_oauth_client_id', label: 'OAuth Client ID', type: 'text', group: 'Google OAuth' },
  { key: 'google_oauth_client_secret', label: 'OAuth Client Secret', type: 'password', group: 'Google OAuth' },
  { key: 'google_oauth_refresh_token', label: 'OAuth Refresh Token', type: 'password', group: 'Google OAuth' },
  { key: 'google_project_id', label: 'Project ID', type: 'text', group: 'Google OAuth' },
  // Trovaprezzi
  { key: 'trovaprezzi_feed_url', label: 'Feed URL Sorgente', type: 'text', group: 'Trovaprezzi' },
  { key: 'trovaprezzi_feed_separator', label: 'Separatore CSV', type: 'text', group: 'Trovaprezzi' },
  { key: 'trovaprezzi_shipping_cost', label: 'Costo Spedizione', type: 'text', group: 'Trovaprezzi' },
  { key: 'trovaprezzi_output_format', label: 'Formato Output', type: 'text', group: 'Trovaprezzi' },
  // Trovaprezzi Zombie
  { key: 'trovaprezzi_username', label: 'Username', type: 'text', group: 'Trovaprezzi Zombie' },
  { key: 'trovaprezzi_password', label: 'Password', type: 'password', group: 'Trovaprezzi Zombie' },
  { key: 'trovaprezzi_seller_name', label: 'Nome Seller', type: 'text', group: 'Trovaprezzi Zombie' },
  // AI
  { key: 'claude_api_key', label: 'Claude API Key', type: 'password', group: 'AI (Claude)' },
  { key: 'claude_model', label: 'Modello', type: 'select', group: 'AI (Claude)', options: [
    { value: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { value: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' },
    { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
    { value: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku' },
    { value: 'claude-3-opus-20240229', label: 'Claude 3 Opus' },
  ] },
  // Telegram
  { key: 'telegram_bot_token', label: 'Bot Token', type: 'password', group: 'Telegram' },
  { key: 'telegram_chat_id', label: 'Chat ID', type: 'text', group: 'Telegram' },
];

export default function TenantConfig() {
  const { effectiveTenantId } = useAuth();
  const [config, setConfig] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (effectiveTenantId) loadConfig();
  }, [effectiveTenantId]);

  async function loadConfig() {
    try {
      const res = await authFetch(`/api/tenants/${effectiveTenantId}/config`);
      const data = await res.json();
      setConfig(data.config || {});
    } catch {
      setMessage('Errore nel caricamento configurazione');
    } finally {
      setLoading(false);
    }
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setMessage('');
    try {
      const toSave = {};
      const urlsAutoFixed = [];
      for (const field of CONFIG_FIELDS) {
        let value = config[field.key];
        if (value && value !== '********') {
          // Notifica + auto-fix campi URL senza schema (https://)
          const isUrlField = /url/i.test(field.key);
          if (isUrlField && !/^https?:\/\//i.test(String(value).trim())) {
            const fixed = 'https://' + String(value).trim().replace(/^\/+/, '');
            urlsAutoFixed.push(`${field.label}: "${value}" → "${fixed}"`);
            value = fixed;
            setConfig(prev => ({ ...prev, [field.key]: fixed }));
          }
          toSave[field.key] = value;
        }
      }

      if (urlsAutoFixed.length > 0) {
        const proceed = window.confirm(
          'Attenzione: i seguenti URL non includevano "https://" e sono stati corretti automaticamente:\n\n' +
          urlsAutoFixed.join('\n') +
          '\n\nVuoi salvare con i valori corretti?'
        );
        if (!proceed) { setSaving(false); return; }
      }

      const res = await authFetch(`/api/tenants/${effectiveTenantId}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: toSave }),
      });

      if (res.ok) {
        setMessage('Configurazione salvata');
      } else {
        const data = await res.json();
        setMessage(data.error || 'Errore nel salvataggio');
      }
    } catch {
      setMessage('Errore nel salvataggio');
    } finally {
      setSaving(false);
    }
  }

  if (!effectiveTenantId) {
    return <div className="text-gray-400 text-center py-20">Seleziona un tenant</div>;
  }

  const groups = [...new Set(CONFIG_FIELDS.map(f => f.group))];

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-800">Configurazione</h1>
        <p className="text-gray-500 mt-1">Configura le integrazioni per questo tenant</p>
      </div>

      {message && (
        <div className={`px-4 py-3 rounded-lg mb-6 text-sm ${message.toLowerCase().includes('errore') || message.toLowerCase().includes('error') ? 'bg-red-100 text-red-800 border border-red-300' : 'bg-green-100 text-green-800 border border-green-300'}`}>
          {message}
        </div>
      )}

      {loading ? (
        <div className="text-gray-500 text-center py-12">Caricamento...</div>
      ) : (
        <form onSubmit={handleSave}>
          {groups.map(group => (
            <div key={group} className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
              <h2 className="text-lg font-semibold text-gray-800 mb-4">{group}</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {CONFIG_FIELDS.filter(f => f.group === group).map(field => (
                  <div key={field.key}>
                    <label className="block text-sm font-medium text-gray-700 mb-1">{field.label}</label>
                    {field.type === 'select' ? (
                      <select
                        value={config[field.key] || ''}
                        onChange={e => setConfig({ ...config, [field.key]: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-transparent text-sm bg-white"
                      >
                        <option value="">Seleziona {field.label}</option>
                        {field.options.map(opt => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={field.type}
                        value={config[field.key] || ''}
                        onChange={e => setConfig({ ...config, [field.key]: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-transparent text-sm"
                        placeholder={field.type === 'password' ? '••••••••' : `Inserisci ${field.label}`}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={saving}
              className="px-6 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 font-medium"
            >
              {saving ? 'Salvataggio...' : 'Salva configurazione'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
