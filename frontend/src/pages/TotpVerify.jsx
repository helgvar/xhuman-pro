import React, { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function TotpVerify() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login } = useAuth();
  const tempToken = location.state?.tempToken;

  const [totpCode, setTotpCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  if (!tempToken) {
    navigate('/login');
    return null;
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/totp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tempToken, totpCode }),
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

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900 px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-brand-400">Verifica 2FA</h1>
          <p className="text-gray-400 mt-2">Inserisci il codice da Google Authenticator</p>
        </div>

        <form onSubmit={handleSubmit} className="bg-gray-800 rounded-2xl p-8 shadow-xl">
          {error && (
            <div className="bg-red-900/50 border border-red-500 text-red-300 px-4 py-3 rounded-lg mb-6 text-sm">
              {error}
            </div>
          )}

          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Codice a 6 cifre
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
            {loading ? 'Verifica...' : 'Accedi'}
          </button>

          <button
            type="button"
            onClick={() => navigate('/login')}
            className="w-full mt-3 py-2 text-gray-400 hover:text-gray-300 text-sm transition-colors"
          >
            Torna al login
          </button>
        </form>
      </div>
    </div>
  );
}
