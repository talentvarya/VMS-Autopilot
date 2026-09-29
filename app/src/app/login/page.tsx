'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

/**
 * Phase G.1 - real Supabase Auth. Sign-up exists here so the owner can create their own first
 * real Admin account (nobody but them types their own password, and it only ever goes to
 * Supabase's own Auth API, never anywhere this app can read it back).
 */
export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'sign_in' | 'sign_up'>('sign_in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setBusy(true);
    const supabase = createClient();
    try {
      if (mode === 'sign_in') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.push('/');
        router.refresh();
      } else {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setInfo('Account created. If your project requires email confirmation, check your inbox, then sign in.');
        setMode('sign_in');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0b1220', padding: 16 }}>
      <form
        onSubmit={handleSubmit}
        style={{ width: '100%', maxWidth: 360, background: '#111a2e', borderRadius: 12, padding: 32, color: '#e6e9f0', boxShadow: '0 20px 60px rgba(0,0,0,0.35)' }}
      >
        <h1 style={{ fontSize: 20, marginBottom: 4 }}>VMS Autopilot</h1>
        <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 24 }}>
          {mode === 'sign_in' ? 'Sign in to your agency workspace' : 'Create your Admin account'}
        </p>

        <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>Email</label>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #2a3652', background: '#0b1220', color: '#e6e9f0', marginBottom: 14 }}
        />

        <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>Password</label>
        <input
          type="password"
          required
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #2a3652', background: '#0b1220', color: '#e6e9f0', marginBottom: 18 }}
        />

        {error && <p style={{ color: '#ff8080', fontSize: 13, marginBottom: 14 }}>{error}</p>}
        {info && <p style={{ color: '#7fd8a0', fontSize: 13, marginBottom: 14 }}>{info}</p>}

        <button
          type="submit"
          disabled={busy}
          style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: 'none', background: '#5b6cf6', color: 'white', fontWeight: 600, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}
        >
          {busy ? 'Please wait…' : mode === 'sign_in' ? 'Sign in' : 'Create account'}
        </button>

        <button
          type="button"
          onClick={() => { setMode(mode === 'sign_in' ? 'sign_up' : 'sign_in'); setError(null); setInfo(null); }}
          style={{ width: '100%', marginTop: 12, padding: '8px 12px', borderRadius: 8, border: '1px solid #2a3652', background: 'transparent', color: '#a9b4cc', cursor: 'pointer', fontSize: 13 }}
        >
          {mode === 'sign_in' ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
        </button>
      </form>
    </div>
  );
}
