import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { storeSubject, clearAuth } from '../auth';

interface LoginProps {
  onSuccess: () => void;
}

interface AuthConfig {
  email: boolean;
  google: boolean;
  stellar: boolean;
  registration: boolean;
}

import { isConnected, requestAccess, signMessage } from '@stellar/freighter-api';

const TESTNET_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';

/**
 * Freighter wallet integration via the official @stellar/freighter-api package.
 * The legacy `window.freighterApi` global was removed in Freighter v5.x —
 * detection now uses the package's `isConnected()` / `requestAccess()`.
 */
async function getFreighterAddress(): Promise<string> {
  const connected = await isConnected();
  if (!connected.isConnected) throw new Error('wallet_not_found');
  // requestAccess shows the Freighter approval popup on first use and returns
  // the authorized public address. isConnected only proves the extension exists.
  const access = await requestAccess();
  if (access.error) throw new Error(access.error.message);
  if (!access.address) throw new Error('no_address');
  return access.address;
}

async function freighterSign(message: string, address: string): Promise<string> {
  const result = await signMessage(message, {
    networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
    address,
  });
  if (result.error) throw new Error(result.error.message);
  // V4 extension returns base64 string; V3 returns bytes (buffer polyfill).
  const signed = result.signedMessage;
  if (signed == null) throw new Error('sign_failed');
  if (typeof signed === 'string') return signed;
  return btoa(String.fromCharCode(...Array.from(signed as unknown as Uint8Array)));
}

export default function Login({ onSuccess }: LoginProps) {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const paramsRef = useRef(new URLSearchParams(window.location.search));

  useEffect(() => {
    api
      .authConfig()
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);

  // Google callback redirects here with ?auth_error=... — surface it.
  useEffect(() => {
    const err = paramsRef.current.get('auth_error');
    if (err) setError('Google sign-in failed. Please try again.');
  }, []);

  const finish = useCallback(
    (subject: string) => {
      clearAuth(); // never keep a legacy bearer token after a real login
      storeSubject(subject);
      onSuccess();
    },
    [onSuccess]
  );

  const handleEmailSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setBusy(true);
      setError(null);
      try {
        const res =
          mode === 'register'
            ? await api.register({ email, password })
            : await api.loginEmail({ email, password });
        finish(res.subject);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Authentication failed.';
        setError(
          msg === 'invalid_credentials'
            ? 'Invalid email or password.'
            : msg === 'email_registered'
              ? 'That email is already registered. Sign in instead.'
              : msg === 'weak_password'
                ? 'Password must be at least 8 characters.'
                : msg === 'invalid_email'
                  ? 'Enter a valid email address.'
                  : 'Authentication failed.'
        );
      } finally {
        setBusy(false);
      }
    },
    [mode, email, password, finish]
  );

  const handleGoogle = useCallback(() => {
    // Full-page navigation to the API's OAuth start endpoint. The server
    // appends its own state/nonce; the callback sets the session cookie and
    // redirects back to the app.
    window.location.href = `${api.authStartUrl()}`;
  }, []);

  const handleStellar = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const address = await getFreighterAddress();
      const challenge = await api.stellarChallenge(address);
      const signature = await freighterSign(challenge.message, address);
      const res = await api.stellarVerify({
        publicKey: address,
        challengeId: challenge.challengeId,
        signature,
      });
      finish(res.subject);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Wallet authentication failed.';
      setError(
        msg === 'wallet_not_found'
          ? 'Stellar wallet not found. Install Freighter to continue.'
          : msg === 'user_rejected' || msg === 'sign_failed'
          ? 'Signing was rejected in your wallet.'
          : 'Wallet authentication failed.'
      );
    } finally {
      setBusy(false);
    }
  }, [finish]);

  return (
    <div className="auth-screen">
      <div className="auth-box">
        <div className="auth-logo">▲</div>
        <h1>4evergent</h1>
        <p className="muted">Autonomous financial agents, with policy-controlled execution.</p>

        <div className="auth-providers">
          {config?.google && (
            <button type="button" className="auth-provider" onClick={handleGoogle} disabled={busy}>
              <span className="auth-provider-icon" aria-hidden="true">G</span>
              Continue with Google
            </button>
          )}
          {config?.stellar && (
            <button type="button" className="auth-provider" onClick={handleStellar} disabled={busy}>
              <span className="auth-provider-icon" aria-hidden="true">✦</span>
              Connect Stellar wallet
            </button>
          )}
          {config && !config.google && (
            <p className="muted auth-provider-note">
              Google sign-in is not configured on this server.
            </p>
          )}
        </div>

        {config && (config.google || config.stellar) && (
          <div className="auth-divider" role="separator" aria-label="or">
            <span>or</span>
          </div>
        )}

        <form onSubmit={handleEmailSubmit} className="auth-email-form">
          <div className="auth-field">
            <label htmlFor="login-email">Email</label>
            <input
              id="login-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              required
            />
          </div>
          <div className="auth-field">
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              minLength={8}
              required
            />
          </div>

          {error && <div className="error-banner" role="alert">{error}</div>}

          <button type="submit" className="auth-submit" disabled={busy}>
            {busy ? 'Authenticating…' : mode === 'register' ? 'Create account' : 'Sign in'}
          </button>
        </form>

        {config?.registration && (
          <p className="auth-help">
            <button
              type="button"
              className="auth-switch"
              onClick={() => {
                setMode(mode === 'login' ? 'register' : 'login');
                setError(null);
              }}
            >
              {mode === 'login' ? 'Create an account' : 'Sign in instead'}
            </button>
          </p>
        )}

        <p className="auth-help">
          <Link to="/" className="muted">
            ← Back to home
          </Link>
        </p>
      </div>
    </div>
  );
}
