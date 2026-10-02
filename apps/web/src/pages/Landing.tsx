import { Link } from 'react-router-dom';
import { StatusBadge } from '../components';

/* ==========================================================================
   Public landing page.

   Every claim on this page is traceable to the shipped implementation:
   - intent pipeline stages      → packages/stellar/src/pipeline.ts, README.md
   - policy decision states      → PolicyDecision.result        (src/types.ts)
   - execution states            → ExecutionStatus              (src/types.ts)
   - approval states             → ApprovalStatus               (src/types.ts)
   - policy rule fields          → PolicyRules                  (src/types.ts)
   - schedule lifecycle          → ScheduleRecord/ScheduleStatus (src/types.ts)
   - approval + execution tables → pages/Approvals.tsx, pages/Executions.tsx
   ========================================================================== */

const REPO_URL = 'https://github.com/SaboLabs/4evergent';

const PIPELINE = [
  { label: 'Agent', note: 'Identity + Stellar address', gate: '' },
  { label: 'Intent', note: 'Typed payment or trustline', gate: '' },
  { label: 'Policy', note: 'Deterministic rule evaluation', gate: 'policy' },
  { label: 'Approval', note: 'Human gate above threshold', gate: 'approval' },
  { label: 'Simulation', note: 'Simulated before signing', gate: '' },
  { label: 'Execution', note: 'Sequence-coordinated submit', gate: '' },
  { label: 'Stellar', note: 'Testnet transaction', gate: '' },
  { label: 'Activity', note: 'Recorded history', gate: 'terminal' },
];

const CAPABILITIES = [
  {
    title: 'Agents',
    detail:
      'A persistent identity, a Stellar address, declared capabilities, and an active / paused / disabled lifecycle.',
    key: 'agent',
  },
  {
    title: 'Policies',
    detail:
      'Per-transaction and daily limits, allowed assets, destinations and contract IDs, plus an approval threshold. Evaluated deterministically.',
    key: 'policy',
  },
  {
    title: 'Intents',
    detail:
      'Typed payment and trustline intents, schema-validated before anything reaches the chain. Raw XDR is rejected at the API.',
    key: 'intent',
  },
  {
    title: 'Simulation',
    detail:
      'Each transaction is simulated before signing. The simulation result is stored on the activity and execution record.',
    key: 'simulation',
  },
  {
    title: 'Approval',
    detail:
      'Intents above the configured threshold stop at a human gate. Pending approvals expire if nobody acts.',
    key: 'approval',
  },
  {
    title: 'Execution',
    detail:
      'Sequence-coordinated submission per Stellar account, with attempts, retry scheduling, and a dead-letter state.',
    key: 'execution',
  },
  {
    title: 'Schedules',
    detail:
      'Recurring intents bound to an agent, with next-run tracking and pause, resume or disable controls.',
    key: 'schedule',
  },
  {
    title: 'Audit trail',
    detail:
      'Every intent, policy decision, simulation outcome and transaction is recorded in the activity and execution history.',
    key: 'audit',
  },
];

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
        <div className="landing-topbar-actions">
          <a
            className="btn btn-ghost btn-sm landing-topbar-link"
            href={REPO_URL}
            target="_blank"
            rel="noreferrer noopener"
          >
            Repository
          </a>
          <Link to="/login" className="btn btn-primary btn-sm">
            Sign In
          </Link>
        </div>
      </header>

      <main className="main main-narrow landing-main">
        {/* ---------------------------------------------------------------- */}
        {/* Hero                                                             */}
        {/* ---------------------------------------------------------------- */}
        <section className="landing-hero">
          <p className="landing-eyebrow">
            Agent execution framework for Stellar Testnet
          </p>
          <h1 className="landing-title">
            Agents that act,
            <br />
            under control.
          </h1>
          <p className="landing-lede">
            4evergent is an open-source framework for running agents with
            permissioned Stellar wallets. The model proposes a typed intent; a
            deterministic policy engine — independent of the model — decides
            whether it is allowed, denied, or requires a human approval before
            anything is signed.
          </p>

          <div className="landing-cta-row">
            <Link to="/login" className="btn btn-primary">
              Open the dashboard
            </Link>
            <a
              className="btn btn-secondary"
              href={REPO_URL}
              target="_blank"
              rel="noreferrer noopener"
            >
              Read the source
            </a>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Signature: execution pipeline                                    */}
        {/* ---------------------------------------------------------------- */}
        <section className="landing-section" aria-labelledby="pipeline-heading">
          <h2 id="pipeline-heading" className="landing-h2">
            One path from intent to transaction
          </h2>
          <p className="landing-section-note">
            Every intent traverses the same ordered pipeline. Nothing skips the
            policy stage, and nothing is signed before simulation.
          </p>

          <ol className="landing-pipeline">
            {PIPELINE.map((step, i) => (
              <li
                className="landing-pipeline-step"
                key={step.label}
                data-gate={step.gate}
              >
                <span className="landing-pipeline-index" aria-hidden="true">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span className="landing-pipeline-body">
                  <span className="landing-pipeline-label">{step.label}</span>
                  <span className="landing-pipeline-note">{step.note}</span>
                </span>
              </li>
            ))}
          </ol>

          <div className="landing-decisions">
            <div className="landing-decision">
              <span className="landing-decision-name">allow</span>
              <span className="landing-decision-note">
                Passes policy, proceeds to execution
              </span>
            </div>
            <div className="landing-decision landing-decision-warn">
              <span className="landing-decision-name">requires_approval</span>
              <span className="landing-decision-note">
                Holds at the human gate until approved
              </span>
            </div>
            <div className="landing-decision landing-decision-err">
              <span className="landing-decision-name">deny</span>
              <span className="landing-decision-note">
                Rejected by policy, never signed
              </span>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Real product surface                                             */}
        {/* ---------------------------------------------------------------- */}
        <section className="landing-section" aria-labelledby="surface-heading">
          <h2 id="surface-heading" className="landing-h2">
            The control plane behind it
          </h2>
          <p className="landing-section-note">
            The framework ships with an operational dashboard. The columns,
            status values and table components below are taken from the shipped
            Approvals and Executions views.
          </p>

          <div className="landing-surface">
            <div className="landing-surface-bar">
              <span className="landing-surface-title">Approvals</span>
              <span className="landing-surface-meta">pending_approval</span>
            </div>
            <div className="table-wrapper">
              <table className="table">
                <caption className="landing-caption">
                  Structural preview of the Approvals view
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Approval</th>
                    <th scope="col">Agent</th>
                    <th scope="col">Intent</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Asset</th>
                    <th scope="col">Expires</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <code>a91f4c02</code>
                    </td>
                    <td>
                      <code>7d20be31</code>
                    </td>
                    <td>payment</td>
                    <td className="amount">250.00</td>
                    <td>USDC</td>
                    <td className="muted">in 22h</td>
                    <td>
                      <StatusBadge status="pending_approval" />
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <code>3c88e7b4</code>
                    </td>
                    <td>
                      <code>7d20be31</code>
                    </td>
                    <td>trustline</td>
                    <td className="muted">—</td>
                    <td>AQUA</td>
                    <td className="muted">in 21h</td>
                    <td>
                      <StatusBadge status="approved" />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="landing-surface-bar landing-surface-bar-split">
              <span className="landing-surface-title">Executions</span>
              <span className="landing-surface-meta">
                queued → executing → submitted → confirmed
              </span>
            </div>
            <div className="table-wrapper">
              <table className="table">
                <caption className="landing-caption">
                  Structural preview of the Executions view
                </caption>
                <thead>
                  <tr>
                    <th scope="col">ID</th>
                    <th scope="col">Intent</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Status</th>
                    <th scope="col">Attempt</th>
                    <th scope="col">Next Retry</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <code>e4b1a077</code>
                    </td>
                    <td>payment</td>
                    <td className="amount">120.00 USDC</td>
                    <td>
                      <StatusBadge status="confirmed" />
                    </td>
                    <td>1</td>
                    <td className="muted">—</td>
                  </tr>
                  <tr>
                    <td>
                      <code>e4b1a081</code>
                    </td>
                    <td>payment</td>
                    <td className="amount">48.50 USDC</td>
                    <td>
                      <StatusBadge status="executing" />
                    </td>
                    <td>2</td>
                    <td className="muted">—</td>
                  </tr>
                  <tr>
                    <td>
                      <code>e4b1a090</code>
                    </td>
                    <td>trustline</td>
                    <td className="muted">—</td>
                    <td>
                      <StatusBadge status="failed" />
                    </td>
                    <td>3</td>
                    <td className="muted">retry scheduled</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <p className="landing-fineprint">
            Illustrative rows. Columns, status values and table components are
            taken from the shipped dashboard views.
          </p>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Capabilities                                                     */}
        {/* ---------------------------------------------------------------- */}
        <section className="landing-section" aria-labelledby="capabilities-heading">
          <h2 id="capabilities-heading" className="landing-h2">
            What the framework gives you
          </h2>
          <p className="landing-section-note">
            Each of these is an implemented part of the execution path, not a
            roadmap item.
          </p>

          <ul className="landing-cap-grid">
            {CAPABILITIES.map((c) => (
              <li className="landing-cap" key={c.key}>
                <span className="landing-cap-title">{c.title}</span>
                <span className="landing-cap-detail">{c.detail}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Stellar / testnet context                                        */}
        {/* ---------------------------------------------------------------- */}
        <section className="landing-section" aria-labelledby="stellar-heading">
          <h2 id="stellar-heading" className="landing-h2">
            Testnet first
          </h2>
          <div className="landing-facts">
            <div className="landing-fact">
              <span className="landing-fact-key">Network</span>
              <span className="landing-fact-value">Stellar Testnet</span>
            </div>
            <div className="landing-fact">
              <span className="landing-fact-key">Before signing</span>
              <span className="landing-fact-value">Simulation required</span>
            </div>
            <div className="landing-fact">
              <span className="landing-fact-key">Intent types</span>
              <span className="landing-fact-value">payment · trustline</span>
            </div>
            <div className="landing-fact">
              <span className="landing-fact-key">Live submission</span>
              <span className="landing-fact-value">Disabled unless LIVE_SUBMIT=1</span>
            </div>
          </div>
          <p className="landing-section-note landing-section-note-tight">
            There are no mainnet assumptions in this build, no token, and no
            speculative economics. Transactions are simulated and are not
            suitable for production value.
          </p>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Final CTA                                                        */}
        {/* ---------------------------------------------------------------- */}
        <section className="landing-final" aria-labelledby="final-heading">
          <h2 id="final-heading" className="landing-h2">
            Run it yourself
          </h2>
          <p className="landing-section-note">
            Operators sign in to the dashboard. Developers read the source and
            run it against Testnet.
          </p>
          <div className="landing-cta-row landing-cta-row-left">
            <Link to="/login" className="btn btn-primary">
              Open the dashboard
            </Link>
            <a
              className="btn btn-secondary"
              href={REPO_URL}
              target="_blank"
              rel="noreferrer noopener"
            >
              Repository
            </a>
          </div>
        </section>
      </main>

      <footer className="topbar landing-footer">
        <div className="landing-footer-inner">
          <span className="muted landing-footer-text">
            4evergent — autonomous agents with policy-controlled execution on
            Stellar.
          </span>
          <a
            className="landing-footer-link"
            href={REPO_URL}
            target="_blank"
            rel="noreferrer noopener"
          >
            Source
          </a>
        </div>
      </footer>
    </div>
  );
}
