import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useState, useEffect, useCallback } from 'react';
import { getStoredToken, storeAuth, clearAuth, getStoredSubject } from './auth';
import { api } from './api';
import Landing from './pages/Landing';
import Overview from './pages/Overview';
import Agents from './pages/Agents';
import AgentDetail from './pages/AgentDetail';
import Activity from './pages/Activity';
import ActivityDetail from './pages/ActivityDetail';
import Approvals from './pages/Approvals';
import ApprovalDetail from './pages/ApprovalDetail';
import Executions from './pages/Executions';
import ExecutionDetail from './pages/ExecutionDetail';
import Submit from './pages/Submit';

/* ==========================================================================
   Auth inline form (login screen shown when unauthenticated)
   ========================================================================== */

function AuthInline() {
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleLogin = useCallback(async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setLoginError(null);

    const formData = new FormData(e.currentTarget);
    const token = formData.get('token') as string;

    if (!token || token.trim().length === 0) {
      setLoginError('Please enter a token');
      setLoading(false);
      return;
    }

    storeAuth(token.trim(), 'pending');

    try {
      // Validate against a PROTECTED endpoint (not public /health).
      await api.listAgents();
      const subject = getStoredSubject() ?? 'authenticated-user';
      storeAuth(token.trim(), subject);
      navigate('/overview');
    } catch (_err) {
      clearAuth();
      setLoginError('Invalid token or authentication failed.');
    } finally {
      setLoading(false);
    }
  }, [navigate]);

  return (
    <div className="auth-screen">
      <form className="auth-box" onSubmit={handleLogin}>
        <div className="auth-logo">▲</div>
        <h1>4evergent</h1>
        <p className="muted">Autonomous financial agents, with policy-controlled execution.</p>

        <div className="auth-field">
          <label htmlFor="token">Access Token</label>
          <input
            id="token"
            name="token"
            type="password"
            placeholder="Enter your Bearer token"
            autoComplete="off"
            autoFocus
          />
        </div>

        {loginError && <div className="error-banner">{loginError}</div>}

        <button type="submit" disabled={loading} className="auth-submit">
          {loading ? 'Authenticating...' : 'Sign In'}
        </button>

        <div className="auth-help">
          <p className="muted">Development: Any non-empty token works with DevAuthProvider.</p>
          <p className="muted">Production: Use a valid API key or JWT.</p>
        </div>
      </form>
    </div>
  );
}

/* ==========================================================================
   Require Auth — validates session against a protected endpoint
   ========================================================================== */

function RequireAuth({ children }: { children: React.ReactNode }) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const token = getStoredToken();
    if (!token) {
      setAuthenticated(false);
      return;
    }
    // Validate against a PROTECTED endpoint (not public /health).
    api.listAgents()
      .then(() => setAuthenticated(true))
      .catch(() => {
        clearAuth();
        setAuthenticated(false);
      });
  }, []);

  useEffect(() => {
    if (authenticated === false) {
      navigate('/', { state: { from: location.pathname } });
    }
  }, [authenticated, navigate, location.pathname]);

  if (authenticated === null) {
    return (
      <div className="auth-screen">
        <div className="auth-box">
          <div className="auth-logo">▲</div>
          <h1>4evergent</h1>
          <p className="muted">Verifying session...</p>
        </div>
      </div>
    );
  }

  if (authenticated === false) {
    return <AuthInline />;
  }

  return <>{children}</>;
}

/* ==========================================================================
   Layout
   ========================================================================== */

function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const currentPath = location.pathname;

  const navItems = [
    { path: '/overview', label: 'Overview', section: 'OPERATE' },
    { path: '/approvals', label: 'Approvals', section: 'OPERATE' },
    { path: '/executions', label: 'Executions', section: 'OPERATE' },
    { path: '/activity', label: 'Activity', section: 'OPERATE' },
    { path: '/submit', label: 'Submit Intent', section: 'OPERATE' },
    { path: '/agents', label: 'Agents', section: 'CONFIGURE' },
  ];

  const sections = [
    { label: 'OPERATE', items: navItems.filter(i => i.section === 'OPERATE') },
    { label: 'CONFIGURE', items: navItems.filter(i => i.section === 'CONFIGURE') },
  ];

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-left">
          <div className="brand">
            <span className="brand-mark">▲</span>
            <span className="brand-name">4evergent</span>
          </div>
          <span className="env-badge">Testnet</span>
        </div>
        <OperatorBadge />
      </header>
      <div className="shell-body">
        <nav className="sidebar" aria-label="Main navigation">
          {sections.map((section) => (
            <div key={section.label}>
              <div className="nav-section-title">{section.label}</div>
              {section.items.map((item) => (
                <a
                  key={item.path}
                  href={item.path}
                  className={`nav-item ${currentPath.startsWith(item.path) ? 'active' : ''}`}
                  aria-current={currentPath.startsWith(item.path) ? 'page' : undefined}
                >
                  <span className="nav-text">{item.label}</span>
                </a>
              ))}
            </div>
          ))}
        </nav>
        <main className="main">
          {children}
        </main>
      </div>
    </div>
  );
}

function OperatorBadge() {
  const [subject, setSubject] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    setSubject(getStoredSubject());
  }, []);

  const handleLogout = useCallback(() => {
    clearAuth();
    navigate('/');
  }, [navigate]);

  return (
    <div className="topbar-right">
      {subject && <span className="operator-badge" title={`Operator: ${subject}`}>{subject}</span>}
      <button className="logout-btn" onClick={handleLogout} title="Sign out">
        Sign Out
      </button>
    </div>
  );
}

/* ==========================================================================
   Main App Router
   ========================================================================== */

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public landing page */}
        <Route path="/" element={<Landing />} />

        {/* Protected application */}
        <Route
          path="/*"
          element={
            <RequireAuth>
              <Layout>
                <Routes>
                  <Route path="/overview" element={<Overview />} />
                  <Route path="/approvals" element={<Approvals />} />
                  <Route path="/approvals/:approvalId" element={<ApprovalDetail />} />
                  <Route path="/executions" element={<Executions />} />
                  <Route path="/executions/:executionId" element={<ExecutionDetail />} />
                  <Route path="/activity" element={<Activity />} />
                  <Route path="/agents/:agentId/activity/:activityId" element={<ActivityDetail />} />
                  <Route path="/agents" element={<Agents />} />
                  <Route path="/agents/:agentId" element={<AgentDetail />} />
                  <Route path="/submit" element={<Submit />} />
                  <Route path="/login" element={<Navigate to="/overview" replace />} />
                  <Route path="*" element={<Navigate to="/overview" replace />} />
                </Routes>
              </Layout>
            </RequireAuth>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
