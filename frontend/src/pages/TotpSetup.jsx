import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function TotpSetup() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login } = useAuth();
  const tempToken = location.state?.tempToken;

  const [qrCodeUrl, setQrCodeUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [verifyToken, setVerifyToken] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState('loading');

  useEffect(() => {
    if (!tempToken) {
      navigate('/login');
      return;
    }

    fetch('/api/auth/totp/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tempToken }),
    })
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          setError(data.error);
          setStep('error');
          return;
        }
        setQrCodeUrl(data.qrCodeUrl);
        setSecret(data.secret);
        setVerifyToken(data.tempToken);
        setStep('qr');
      })
      .catch(() => {
        setError('Errore di connessione');
        setStep('error');
      });
  }, [tempToken, navigate]);

  const handleVerify = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/totp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tempToken: verifyToken, totpCode }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Codice non valido');
        setLoading(false);
        return;
      }

      login(data.accessToken, data.refreshToken, data.user);
      navigate('/', { replace: true });
    } catch {
      setError('Errore di connessione');
      setLoading(false);
    }
  };

  if (step === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900">
        <div className="text-gray-400">Generazione QR code...</div>
      </div>
    );
  }

  if (step === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900 px-4">
        <div className="bg-gray-800 rounded-2xl p-8 max-w-md w-full text-center">
          <div className="text-red-400 mb-4">{error}</div>
          <button onClick={() => navigate('/login')} className="text-brand-400 hover:underline">
            Torna al login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900 px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-brand-400">Configura 2FA</h1>
          <p className="text-gray-400 mt-2">Scansiona il QR code con Google Authenticator</p>
        </div>

        <div className="bg-gray-800 rounded-2xl p-8 shadow-xl">
          <div className="flex justify-center mb-6">
            {qrCodeUrl && (
              <img src={qrCodeUrl} alt="QR Code 2FA" className="w-48 h-48 rounded-lg" />
            )}
          </div>

          <div className="mb-6">
            <p className="text-xs text-gray-400 text-center mb-1">Oppure inserisci manualmente:</p>
            <div className="bg-gray-700 rounded-lg p-3 text-center">
              <code className="text-sm text-brand-300 break-all select-all">{secret}</code>
            </div>
          </div>

          <form onSubmit={handleVerify}>
            {error && (
              <div className="bg-red-900/50 border border-red-500 text-red-300 px-4 py-3 rounded-lg mb-4 text-sm">
                {error}
              </div>
            )}

            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Inserisci il codice a 6 cifre
              </label>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-white text-center text-2xl tracking-[0.5em] placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
                placeholder="000000"
                required
                autoFocus
              />
            </div>

            <button
              type="submit"
              disabled={loading || totpCode.length !== 6}
              className="w-full py-3 bg-brand-600 hover:bg-brand-700 disabled:bg-brand-800 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition-colors"
            >
              {loading ? 'Verifica...' : 'Verifica e accedi'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
