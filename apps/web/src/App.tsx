import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useState, useEffect, useCallback } from 'react';
import { getStoredToken, clearAuth, getStoredSubject } from './auth';
import { api, ApiError } from './api';
import Login from './pages/Login';
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
   Auth — session cookie (user login) with a legacy bearer fallback
   ========================================================================== */

/**
 * Validate the current session against the API.
 * Session cookie (HttpOnly) is the primary mechanism — no API key required.
 * A legacy stored bearer token (API-key/CLI flows) still works as fallback.
 */
async function validateSession(): Promise<boolean> {
  try {
    await api.me();
    return true; // real browser session
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      // No/invalid session — try the legacy bearer path if a token exists.
      if (getStoredToken()) {
        try {
          await api.listAgents();
          return true;
        } catch {
          clearAuth();
          return false;
        }
      }
      return false;
    }
    // Network/server error: don't wipe state, but don't claim auth either.
    return false;
  }
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);

  const check = useCallback(() => {
    validateSession().then(setAuthenticated);
  }, []);

  useEffect(() => {
    check();
  }, [check]);

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
    return <Login onSuccess={() => setAuthenticated(true)} />;
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
                  aria-label={item.label}
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

  const handleLogout = useCallback(async () => {
    // Invalidate the server-side session (cookie) — not just local state.
    try {
      await api.logout();
    } catch {
      // best-effort: local clear below still runs
    }
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
