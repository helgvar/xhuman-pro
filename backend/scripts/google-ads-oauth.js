#!/usr/bin/env node
/**
 * Google Ads OAuth bootstrap — uso one-time.
 *
 * Prerequisiti:
 *  1. Hai creato un OAuth2 Client (Desktop application o Web app) su
 *     https://console.cloud.google.com/apis/credentials nel progetto che vuoi
 *     usare per Google Ads. Per "Desktop" il redirect_uri è automaticamente
 *     "urn:ietf:wg:oauth:2.0:oob" oppure http://localhost.
 *  2. Hai abilitato "Google Ads API" su quel progetto.
 *  3. Hai i valori client_id e client_secret.
 *
 * Cosa fa lo script:
 *  1. Costruisce un URL di consenso con scope https://www.googleapis.com/auth/adwords
 *  2. Ti chiede di aprirlo in browser, autorizzare con l'account Google
 *     che ha accesso all'MCC, e copiare il codice (parametro ?code=...)
 *  3. Scambia il code per refresh_token + access_token
 *  4. Stampa il refresh_token + comando SQL per metterlo in global_config
 *
 * Esempio uso:
 *   GOOGLE_ADS_CLIENT_ID=xxx GOOGLE_ADS_CLIENT_SECRET=yyy node scripts/google-ads-oauth.js
 */

const readline = require('readline');
const https = require('https');
const { URLSearchParams } = require('url');

const CLIENT_ID = process.env.GOOGLE_ADS_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_ADS_REDIRECT_URI || 'urn:ietf:wg:oauth:2.0:oob';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('ERROR: imposta GOOGLE_ADS_CLIENT_ID e GOOGLE_ADS_CLIENT_SECRET come env vars');
  console.error('Esempio: GOOGLE_ADS_CLIENT_ID=xxx.apps.googleusercontent.com GOOGLE_ADS_CLIENT_SECRET=yyy node scripts/google-ads-oauth.js');
  process.exit(1);
}

const SCOPE = 'https://www.googleapis.com/auth/adwords';

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',
  scope: SCOPE,
  access_type: 'offline',
  prompt: 'consent',
}).toString();

console.log('\n=== Google Ads OAuth bootstrap ===\n');
console.log('1) Apri questo URL nel browser e autorizza con l\'account Google che ha accesso all\'MCC:');
console.log('\n   ' + authUrl + '\n');
console.log('2) Dopo l\'autorizzazione, Google ti mostra un codice. Copialo e incollalo qui sotto.');
console.log('   (Se hai usato redirect localhost, copia il valore del parametro `code=` dall\'URL)\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Codice autorizzazione: ', (code) => {
  code = code.trim();
  rl.close();
  if (!code) { console.error('Nessun codice fornito.'); process.exit(1); }

  const body = new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  }).toString();

  const req = https.request({
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }, (resp) => {
    let data = '';
    resp.on('data', chunk => data += chunk);
    resp.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(data); } catch { console.error('Risposta non-JSON:', data); process.exit(1); }
      if (parsed.error) {
        console.error('\nERRORE token exchange:', parsed);
        process.exit(1);
      }
      console.log('\n=== Token ottenuti ===\n');
      console.log('refresh_token:', parsed.refresh_token);
      console.log('access_token (effimero):', parsed.access_token);
      console.log('expires_in:', parsed.expires_in, 'sec');
      console.log('\n=== Salvataggio in global_config ===\n');
      console.log('Esegui sul DB (criptato a cura tua, oppure in chiaro se la colonna lo permette):\n');
      console.log(`INSERT INTO global_config (config_key, config_value, description)`);
      console.log(`VALUES ('google_ads_oauth_refresh_token', '${parsed.refresh_token}', 'Refresh token OAuth per Google Ads API, ottenuto via scripts/google-ads-oauth.js')`);
      console.log(`ON CONFLICT (config_key) DO UPDATE SET config_value=EXCLUDED.config_value, updated_at=NOW();`);
      console.log('\nRicorda anche di settare in global_config:');
      console.log('  - google_ads_developer_token (da https://ads.google.com/aw/apicenter)');
      console.log('  - google_ads_oauth_client_id  (il client_id usato sopra)');
      console.log('  - google_ads_oauth_client_secret  (il client_secret usato sopra)');
      console.log('  - google_ads_login_customer_id  (CID MCC senza trattini, opzionale)');
      console.log('E in tenant_configs per ciascun tenant:');
      console.log('  - google_ads_customer_id  (CID singolo account)\n');
    });
  });
  req.on('error', e => { console.error('Request error:', e.message); process.exit(1); });
  req.write(body);
  req.end();
});
