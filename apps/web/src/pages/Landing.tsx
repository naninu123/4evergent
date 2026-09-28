import { Link } from 'react-router-dom';

export default function Landing() {
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
        <Link to="/login" className="btn btn-primary btn-sm">Sign In</Link>
      </header>

      <main className="main main-narrow" style={{ paddingTop: 'var(--space-3xl)' }}>
        <section style={{ textAlign: 'center', marginBottom: 'var(--space-3xl)' }}>
          <h1 style={{ fontSize: 'var(--text-4xl)', marginBottom: 'var(--space-md)' }}>
            Autonomous financial agents,<br />
            with policy-controlled execution.
          </h1>
          <p className="muted" style={{ fontSize: 'var(--text-lg)', maxWidth: '600px', margin: '0 auto' }}>
            Create agents, define policies, submit intents, require human approval,
            execute safely, and monitor on the Stellar network.
          </p>
        </section>

        {/* Lifecycle Visualization */}
        <section style={{ marginBottom: 'var(--space-3xl)' }}>
          <div className="lifecycle-trail" style={{ justifyContent: 'center' }}>
            <div className="lifecycle-step completed">
              <span className="step-dot"></span>
              <span className="step-label">Agent</span>
            </div>
            <div className="lifecycle-divider"></div>
            <div className="lifecycle-step completed">
              <span className="step-dot"></span>
              <span className="step-label">Policy</span>
            </div>
            <div className="lifecycle-divider"></div>
            <div className="lifecycle-step completed">
              <span className="step-dot"></span>
              <span className="step-label">Intent</span>
            </div>
            <div className="lifecycle-divider"></div>
            <div className="lifecycle-step completed">
              <span className="step-dot"></span>
              <span className="step-label">Approval</span>
            </div>
            <div className="lifecycle-divider"></div>
            <div className="lifecycle-step completed">
              <span className="step-dot"></span>
              <span className="step-label">Execution</span>
            </div>
            <div className="lifecycle-divider"></div>
            <div className="lifecycle-step completed">
              <span className="step-dot"></span>
              <span className="step-label">Stellar</span>
            </div>
            <div className="lifecycle-divider"></div>
            <div className="lifecycle-step completed">
              <span className="step-dot"></span>
              <span className="step-label">Confirmation</span>
            </div>
            <div className="lifecycle-divider"></div>
            <div className="lifecycle-step completed">
              <span className="step-dot"></span>
              <span className="step-label">Activity</span>
            </div>
          </div>
        </section>

        {/* Capabilities */}
        <section style={{ marginBottom: 'var(--space-3xl)' }}>
          <div className="card-grid">
            <div className="surface">
              <div className="card-title">Create Agents</div>
              <div className="card-value">Deploy policy-controlled financial agents</div>
            </div>
            <div className="surface">
              <div className="card-title">Define Policies</div>
              <div className="card-value">Set limits, thresholds, and restrictions</div>
            </div>
            <div className="surface">
              <div className="card-title">Submit Intents</div>
              <div className="card-value">Request payments, trustlines, and more</div>
            </div>
            <div className="surface">
              <div className="card-title">Human Approval</div>
              <div className="card-value">Review and approve before execution</div>
            </div>
            <div className="surface">
              <div className="card-title">Safe Execution</div>
              <div className="card-value">Sequence-coordinated Stellar transactions</div>
            </div>
            <div className="surface">
              <div className="card-title">Audit Trail</div>
              <div className="card-value">Full activity and execution history</div>
            </div>
          </div>
        </section>

        {/* Disclaimer */}
        <section style={{ textAlign: 'center', marginTop: 'var(--space-3xl)' }}>
          <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>
            <strong>Testnet First.</strong> 4evergent is running on the Stellar Testnet.
            Transactions are simulated and not suitable for production value.
          </p>
        </section>
      </main>

      <footer className="topbar" style={{ borderTop: '1px solid var(--color-border)' }}>
        <div style={{ width: '100%', textAlign: 'center', padding: 'var(--space-sm)' }}>
          <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
            4evergent — Autonomous financial agents with policy-controlled execution.
          </span>
        </div>
      </footer>
    </div>
  );
}
