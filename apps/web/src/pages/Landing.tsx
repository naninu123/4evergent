import { useState } from 'react';
import { Link } from 'react-router-dom';
import BrandMark from '../components/landing/BrandMark';
import {
  GATES,
  RULES,
  DECISIONS,
  CAPABILITIES,
  TOOLING,
  LIMITS,
  STEPS,
  DOCS,
  REPO,
} from '../components/landing/content';

function cx(...classes: (string | false | undefined)[]) {
  return classes.filter(Boolean).join(' ');
}

const VERDICT_LABEL = { allow: 'PASS', deny: 'DENY', hold: 'HOLD' } as const;

export default function Landing() {
  const [selectedGateId, setSelectedGateId] = useState(GATES[0]?.id ?? '');
  const [selectedToolId, setSelectedToolId] = useState(TOOLING[0]?.id ?? '');

  const gate = GATES.find((g) => g.id === selectedGateId) ?? GATES[0];
  const tool = TOOLING.find((t) => t.id === selectedToolId) ?? TOOLING[0];

  /** Arrow-key + home/end navigation over a tablist, per WAI-ARIA. */
  const tabKeys = (ids: string[], select: (id: string) => void) => (
    e: React.KeyboardEvent<HTMLButtonElement>,
  ) => {
    const i = ids.indexOf(e.currentTarget.id);
    if (i < 0) return;
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % ids.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = ids.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const id = ids[next];
    if (!id) return;
    select(id);
    document.getElementById(id)?.focus();
  };

  const gateIds = GATES.map((g) => `gate-tab-${g.id}`);
  const toolIds = TOOLING.map((t) => `tool-tab-${t.id}`);

  return (
    <div className="lg">
      <a className="lg-skip" href="#main">Skip to main content</a>
      <header className="lg-topbar">
        <div className="lg-wrap">
          <div className="lg-brand">
            <BrandMark />
            <span>4evergent</span>
          </div>
          <nav className="lg-nav" aria-label="Primary">
            <a href="#threat-model">Threat model</a>
            <a href="#security">Policy engine</a>
            <a href="#capabilities">Capabilities</a>
            <a href="#architecture">Architecture</a>
          </nav>
          <Link to="/login" className="lg-cta">Open dashboard</Link>
        </div>
      </header>

      <main id="main" tabIndex={-1}>
        {/* ===== Hero ===== */}
        <section className="lg-hero">
          <div className="lg-wrap">
            <div className="lg-hero-grid">
              <div>
                <p className="lg-mono-label">Autonomous agents on the Stellar network</p>
                <h1>Agents that can spend, <em>only inside the envelope you wrote.</em></h1>
                <p className="lg-hero-sub">
                  4evergent is a framework for AI agents that hold permissioned Stellar wallets. The
                  agent produces a typed intent. A deterministic policy engine — never the LLM —
                  decides whether that intent is allowed, denied, or held for human approval. Every
                  transaction is simulated before it is signed, and the signer is not reachable from
                  the agent path.
                </p>
                <div className="lg-hero-actions">
                  <Link to="/login" className="lg-cta">Open dashboard</Link>
                  <a href={DOCS.architecture} className="lg-cta lg-cta-ghost">
                    Read the architecture
                  </a>
                </div>
                <div className="lg-hero-meta">
                  <div>
                    <b>Gateway between the agent and the ledger</b>
                    Intent → policy → simulation → signature
                  </div>
                  <div>
                    <b>Agent registry on Stellar Testnet</b>
                    One contract, deployed
                  </div>
                </div>
              </div>

              <div className="lg-rail">
                <div className="lg-rail-head">
                  <span className="lg-mono-label">TransactionPipeline.execute()</span>
                  <span className="lg-rail-chip">8 gates</span>
                </div>
                <ol className="lg-rail-steps">
                  {GATES.map((g) => (
                    <li key={g.id} className="lg-rail-step">
                      <span className="lg-rail-idx">{g.id}</span>
                      <span className="lg-rail-name">{g.name}</span>
                      <span className={cx('lg-vd', `lg-vd--${g.verdict}`)}>
                        {VERDICT_LABEL[g.verdict]}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </div>
        </section>

        {/* ===== Threat model ===== */}
        <section className="lg-section" id="threat-model">
          <div className="lg-wrap">
            <p className="lg-mono-label">The core problem</p>
            <h2>An agent with direct signing authority is an agent you can talk into anything.</h2>
            <div className="lg-problem-grid">
              <blockquote className="lg-quote">
                An autonomous LLM with direct wallet access can be manipulated, jailbroken, or simply
                drift toward unintended behavior.
              </blockquote>
              <div className="lg-problem-card">
                <h3>A prompt is not a policy</h3>
                <p>
                  Instructions the agent can read are instructions the agent can argue around. If the
                  decision-maker is also the thing being constrained, there is no constraint.
                </p>
              </div>
              <div className="lg-problem-card">
                <h3>Signing is unrecoverable</h3>
                <p>
                  Once a Stellar transaction is finalized there is no undo. Losing the signer to the
                  same layer that produces the intent leaves nothing between a bad decision and a
                  settlement.
                </p>
              </div>
              <div className="lg-problem-card">
                <h3>Approval needs evidence</h3>
                <p>
                  “Ask a human” is only a gate if the human can see the intent, the rule it hit, and
                  the simulation result. That record has to be durable, and it has to be safe to share.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ===== Gate chain, interactive ===== */}
        <section className="lg-section" id="pipeline">
          <div className="lg-wrap">
            <p className="lg-mono-label">How it works</p>
            <h2>One entry point, eight gates, first failure wins.</h2>
            <p className="lg-lede">
              <code>TransactionPipeline.execute()</code> is the only public entry point. No gate is
              exposed as a method a caller can chain around, so a policy deny or a failed simulation
              cannot be stepped over. Select a gate:
            </p>

            <div className="lg-gates" role="tablist" aria-label="Transaction pipeline gates">
              {GATES.map((g, i) => (
                <button
                  key={g.id}
                  id={`gate-tab-${g.id}`}
                  type="button"
                  role="tab"
                  aria-selected={g.id === selectedGateId}
                  aria-controls="gate-panel"
                  tabIndex={g.id === selectedGateId ? 0 : -1}
                  className="lg-gate-btn"
                  onClick={() => setSelectedGateId(g.id)}
                  onKeyDown={tabKeys(gateIds, (id) =>
                    setSelectedGateId(id.replace('gate-tab-', '')),
                  )}
                >
                  {g.name}
                  <span className="lg-sr">(gate {i + 1} of {GATES.length})</span>
                </button>
              ))}
            </div>

            {gate && (
              <div
                className="lg-gate-detail"
                id="gate-panel"
                role="tabpanel"
                aria-labelledby={`gate-tab-${gate.id}`}
                tabIndex={0}
              >
                <div>
                  <p className="lg-gate-actor">{gate.actor}</p>
                  <h3>{gate.name}</h3>
                  <p>{gate.summary}</p>
                </div>
                <div className="lg-gate-side">
                  <div className="lg-gate-outcome">
                    <span className="lg-mono-label">Recorded outcome</span>
                    <b>{gate.outcome}</b>
                  </div>
                  <div className={cx('lg-gate-verdict', `lg-gate-verdict--${gate.verdict}`)}>
                    <span className="lg-mono-label">Gate verdict on failure</span>
                    <b>{VERDICT_LABEL[gate.verdict]}</b>
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* ===== Policy engine ===== */}
        <section className="lg-section lg-sheet" id="security">
          <div className="lg-wrap">
            <p className="lg-mono-label">The policy engine</p>
            <h2>Rules are data. Evaluation is a pure function.</h2>
            <div className="lg-sheet-grid">
              <div>
                <p className="lg-sheet-lede">
                  <code>PolicyEngine.evaluate(intent, agentId)</code> takes a typed intent and the
                  agent’s current rules and returns <code>allow</code>, <code>deny</code>, or{' '}
                  <code>requires_approval</code>. No network call, no model call, no randomness —
                  the same intent against the same rules always produces the same decision. An
                  agent’s stored policy overrides the defaults; rules the agent omits fall back to
                  the base set.
                </p>
                <table className="lg-rules">
                  <caption>Evaluation order in evaluateWithRules()</caption>
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      <th scope="col">Rule</th>
                      <th scope="col">What it checks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {RULES.map((r) => (
                      <tr key={r.order}>
                        <td>{r.order}</td>
                        <td><code>{r.rule}</code></td>
                        <td>{r.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div>
                <table className="lg-rules">
                  <caption>DEFAULT_RULES shipped with the framework</caption>
                  <thead>
                    <tr>
                      <th scope="col">Limit</th>
                      <th scope="col">Default</th>
                      <th scope="col">Scope</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr><td>maxTxAmount</td><td>100 XLM</td><td>Per transaction, per asset</td></tr>
                    <tr><td>dailySpendingLimit</td><td>500 XLM</td><td>Per agent, UTC day</td></tr>
                    <tr><td>approval threshold</td><td>50 XLM</td><td>At or above → human review</td></tr>
                    <tr><td>allowedAssets</td><td>XLM</td><td>Empty list = unrestricted</td></tr>
                    <tr><td>allowedDestinations</td><td>empty</td><td>Empty list = unrestricted</td></tr>
                    <tr><td>allowedContractIds</td><td>empty</td><td>Contract calls are denied regardless</td></tr>
                  </tbody>
                </table>

                <div className="lg-decisions">
                  {DECISIONS.map((d) => (
                    <p key={d.label} className={cx('lg-decision', `lg-decision--${d.kind}`)}>
                      <b>{d.label}</b>
                      <span>{d.reason}</span>
                    </p>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ===== Capabilities ===== */}
        <section className="lg-section" id="capabilities">
          <div className="lg-wrap">
            <p className="lg-mono-label">Capabilities</p>
            <h2>Two intent types ship executable. The rest are closed by default.</h2>
            <p className="lg-lede">
              A capability is a named, policy-governed action. Every type below validates and reaches
              the policy engine; what differs is the default the policy ships with.
            </p>
            <div className="lg-table-scroll">
              <table className="lg-cap-table">
                <thead>
                  <tr>
                    <th scope="col">Intent type</th>
                    <th scope="col">Pipeline</th>
                    <th scope="col">Policy default</th>
                    <th scope="col">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {CAPABILITIES.map((c) => (
                    <tr key={c.intent}>
                      <td><code>{c.intent}</code></td>
                      <td>
                        <span className={cx('lg-state', `lg-state--${c.state}`)}>{c.stateLabel}</span>
                      </td>
                      <td>
                        {c.intent === 'payment' || c.intent === 'trustline'
                          ? 'allowed'
                          : 'denied'}
                      </td>
                      <td>{c.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="lg-after-note">
              Path payments, token issuance, and contract invocation are not implemented —{' '}
              <a href={DOCS.capabilities}>docs/capabilities.md</a>.
            </p>
          </div>
        </section>

        {/* ===== Architecture ===== */}
        <section className="lg-section" id="architecture">
          <div className="lg-wrap">
            <p className="lg-mono-label">Architecture</p>
            <h2>A pnpm monorepo where the boundaries are the security model.</h2>
            <div className="lg-arch-grid">
              <div>
                <pre className="lg-code">
{`apps/
  web/       React dashboard — reads state, submits intents
  api/       owns the pipeline; /agents/:id/intents is the entry point
  cli/       operator client over HTTP — never signs

packages/
  agent-core/  intent validation + Stellar read adapter
  policy/      PolicyEngine — pure, deterministic
  stellar/     pipeline, builder, simulator, submitter, Signer
  database/    activity, approvals, executions, schedules
  shared/      types and schemas

contracts/
  agent-registry/  Soroban: agent identity on-chain`}
                </pre>
                <p className="lg-after-note">
                  Contracts keep their own Cargo workspace and pinned toolchain, so the Rust build
                  never inherits the Node toolchain.
                </p>
              </div>
              <div>
                <pre className="lg-code">
{`agent proposes               code
  └─ Intent (typed)          shared/types.ts
       │
       ├─ validate           IntentValidator
       ├─ decide             PolicyEngine      ← pure
       ├─ construct          TransactionBuilder
       ├─ simulate           Horizon           ← mandatory
       ├─ sign               Signer            ← not reachable
       │                                       from the agent
       ├─ submit             StellarSubmitter
       └─ record             ActivityStore`}
                </pre>
                <p className="lg-after-note">
                  The frontend never receives keys, seeds, or raw signing capability; the dashboard
                  shows the decision, not the rules that produced it.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ===== Tooling ===== */}
        <section className="lg-section" id="docs">
          <div className="lg-wrap">
            <p className="lg-mono-label">Tooling</p>
            <h2>Three ways in: HTTP, CLI, and the contract itself.</h2>

            <div className="lg-tabs" role="tablist" aria-label="Developer tooling">
              {TOOLING.map((t) => (
                <button
                  key={t.id}
                  id={`tool-tab-${t.id}`}
                  type="button"
                  role="tab"
                  aria-selected={t.id === selectedToolId}
                  aria-controls="tool-panel"
                  tabIndex={t.id === selectedToolId ? 0 : -1}
                  className="lg-tab"
                  onClick={() => setSelectedToolId(t.id)}
                  onKeyDown={tabKeys(toolIds, (id) => setSelectedToolId(id.replace('tool-tab-', '')))}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {tool && (
              <div
                className="lg-tabpanel"
                id="tool-panel"
                role="tabpanel"
                aria-labelledby={`tool-tab-${tool.id}`}
                tabIndex={0}
              >
                <pre className="lg-code">{tool.code}</pre>
                <p className="lg-tab-note">
                  {tool.note} <a href={tool.noteHref}>{tool.noteText}</a>
                </p>
              </div>
            )}
          </div>
        </section>

        {/* ===== Get started ===== */}
        <section className="lg-section" id="start">
          <div className="lg-wrap">
            <p className="lg-mono-label">Get started</p>
            <h2>Node 22+, pnpm 10+, no secrets required to build.</h2>
            <p className="lg-lede">
              The test suite runs on deterministic mocks and in-process HTTP servers. A funded testnet
              account is only needed for the opt-in live path, which stays disabled until you set{' '}
              <code>LIVE_SUBMIT=1</code>.
            </p>
            <div className="lg-steps">
              {STEPS.map((s) => (
                <div key={s.label} className="lg-step">
                  <span className="lg-step-label">{s.label}</span>
                  <h3>{s.title}</h3>
                  <pre className="lg-code lg-code--tight">{s.code}</pre>
                </div>
              ))}
            </div>
            <p className="lg-after-note">
              Full walkthrough, including funding a testnet account and the live end-to-end script:{' '}
              <a href={DOCS.testnet}>docs/testnet.md</a>.
            </p>
          </div>
        </section>

        {/* ===== Known limits ===== */}
        <section className="lg-section" id="limits">
          <div className="lg-wrap">
            <p className="lg-mono-label">Known limits</p>
            <h2>What this is not, yet.</h2>
            <p className="lg-lede">
              The repository documents its own boundaries. These are the ones that matter before you
              point an agent at anything.
            </p>
            <div className="lg-limits">
              {LIMITS.map((l) => (
                <div key={l.title} className="lg-limit">
                  <b>{l.title}</b>
                  <span>{l.detail}</span>
                </div>
              ))}
            </div>
            <p className="lg-after-note">
              The project records its decisions as ADRs — see{' '}
              <a href={DOCS.architecture}>docs/architecture.md</a> and{' '}
              <a href={DOCS.roadmap}>docs/roadmap.md</a>.
            </p>
          </div>
        </section>
      </main>

      <footer className="lg-footer">
        <div className="lg-wrap">
          <p>4evergent — MIT licensed. Testnet first, no project token.</p>
          <nav className="lg-footer-links" aria-label="Repository">
            <a href={REPO}>GitHub</a>
            <a href={DOCS.readme}>README</a>
            <a href={DOCS.security}>Security model</a>
            <a href={DOCS.api}>API</a>
            <a href={DOCS.changelog}>Changelog</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
