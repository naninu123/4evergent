import { Link } from 'react-router-dom';

/* ==========================================================================
   Public landing page — /
   Presentation only. Every stage, state name, field and capability below is
   traceable to the shipped implementation:

     pipeline order    apps/api/src/index.ts (policy.evaluate → approval →
                       pipeline.execute) and packages/stellar/src/pipeline.ts
                       (build → simulate → sign → submit)
     policy verdicts   types.ts  PolicyDecision.result   allow|deny|requires_approval
     approval states   types.ts  ApprovalStatus
     execution states  types.ts  ExecutionStatus  queued|executing|submitted|
                                 confirmed|failed|dead_letter
     simulation data   types.ts  SimulationResult  success|fee|operations|warnings
     policy rules      types.ts  PolicyRules
     schedule states   types.ts  ScheduleStatus   active|paused|disabled
     intent types      types.ts  IntentType; Submit.tsx offers payment+trustline;
                                 raw XDR rejected at the API
     agent lifecycle   types.ts  AgentStatus      active|paused|disabled
     live-submit gate  packages/stellar/src/submitter.ts + network-guard.ts
     MIT licence       LICENSE; docs/ (api, architecture, capabilities, cli,
                                 roadmap, security-model, testnet)

   No metrics, customers, testimonials, logos or transaction volumes are
   claimed. All rows shown are illustrative and labelled as such.
   ========================================================================== */

const REPO_URL = 'https://github.com/naninu123/4evergent';
const DOCS_URL = `${REPO_URL}/tree/main/docs`;

type StageKind = 'flow' | 'policy' | 'gate' | 'chain' | 'record';
type Stage = { label: string; desc: string; kind: StageKind };

const STAGES: Stage[] = [
  { label: 'Agent', desc: 'Identity + Stellar address', kind: 'flow' },
  { label: 'Intent', desc: 'Typed payment or trustline', kind: 'flow' },
  { label: 'Policy', desc: 'Deterministic rules, no ML', kind: 'policy' },
  { label: 'Approval', desc: 'Human gate above threshold', kind: 'gate' },
  { label: 'Simulation', desc: 'Simulated before signing', kind: 'flow' },
  { label: 'Execution', desc: 'Sequence-coordinated', kind: 'flow' },
  { label: 'Stellar', desc: 'Testnet transaction', kind: 'chain' },
  { label: 'Activity', desc: 'Recorded, replayable', kind: 'record' },
];

type CapKey =
  | 'agent' | 'policy' | 'intent' | 'simulation'
  | 'approval' | 'execution' | 'schedule' | 'audit';

const CAPABILITIES: { k: CapKey; title: string; line: string }[] = [
  { k: 'agent', title: 'Agents', line: 'Persistent identity, Stellar address, declared capabilities.' },
  { k: 'policy', title: 'Policies', line: 'Tx and daily limits, allowed assets, destinations, contracts.' },
  { k: 'intent', title: 'Intents', line: 'Schema-typed payment and trustline requests.' },
  { k: 'simulation', title: 'Simulation', line: 'Fee, operations and warnings — before any signature.' },
  { k: 'approval', title: 'Approval', line: 'Threshold-triggered human gate, with expiry.' },
  { k: 'execution', title: 'Execution', line: 'One coordinated writer per account, retry and dead-letter.' },
  { k: 'schedule', title: 'Schedules', line: 'Recurring intents — active, paused, disabled.' },
  { k: 'audit', title: 'Audit trail', line: 'Every decision, simulation and transaction recorded.' },
];

const FACTS: { k: string; label: string; value: string; note: string }[] = [
  { k: 'network', label: 'Network', value: 'Stellar Testnet', note: 'horizon-testnet · Test SDF passphrase' },
  { k: 'sim', label: 'Before signing', value: 'Simulation required', note: 'the pipeline simulates, then signs' },
  { k: 'intent', label: 'Intent types', value: 'payment · trustline', note: 'typed schema; raw XDR is rejected' },
  { k: 'guard', label: 'Live submission', value: 'Off by default', note: 'enabled only with LIVE_SUBMIT=1' },
  { k: 'policy', label: 'Policy engine', value: 'Deterministic', note: 'explicit rules, not heuristics' },
  { k: 'seq', label: 'Sequence', value: 'Coordinated', note: 'exclusive writer per Stellar account' },
];

/* --- inline line icons (no icon dependency available) -------------------- */

function Icon({ name }: { name: CapKey }) {
  const p = {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    focusable: false,
  } as const;

  switch (name) {
    case 'agent':
      return (
        <svg {...p}>
          <rect x="3" y="6" width="18" height="12" rx="2" />
          <path d="M7 10.5h5M7 13.5h8" />
        </svg>
      );
    case 'policy':
      return (
        <svg {...p}>
          <path d="M12 3.2l6.8 2.9v5c0 4-2.8 7-6.8 8.4-4-1.4-6.8-4.4-6.8-8.4v-5z" />
          <path d="M9.2 11.8l1.9 1.9 3.8-3.9" />
        </svg>
      );
    case 'intent':
      return (
        <svg {...p}>
          <path d="M4 7h12M4 12h9M4 17h6" />
          <path d="M17.5 14.5L20 17l-2.5 2.5" />
        </svg>
      );
    case 'simulation':
      return (
        <svg {...p}>
          <circle cx="10.8" cy="10.8" r="6.2" />
          <path d="M15.4 15.4L20 20" />
          <path d="M8.6 10.8h4.4M10.8 8.6v4.4" />
        </svg>
      );
    case 'approval':
      return (
        <svg {...p}>
          <circle cx="9" cy="8" r="3" />
          <path d="M4 18.5c.8-2.6 2.7-4 5-4s4.2 1.4 5 4" />
          <path d="M15.5 13l2.2 2.2 4.3-4.6" />
        </svg>
      );
    case 'execution':
      return (
        <svg {...p}>
          <path d="M12 3.5v5M12 15.5v5" />
          <circle cx="12" cy="12" r="3.2" />
          <path d="M5.5 8.5L8 12l-2.5 3.5M18.5 8.5L16 12l2.5 3.5" />
        </svg>
      );
    case 'schedule':
      return (
        <svg {...p}>
          <rect x="3.5" y="5.5" width="17" height="15" rx="2" />
          <path d="M3.5 10.5h17M8 3.5v3.2M16 3.5v3.2" />
          <path d="M11 13.5l1.8 1.8 3-3.2" />
        </svg>
      );
    default:
      return (
        <svg {...p}>
          <path d="M5.5 3.8h9l4 4v12.4h-13z" />
          <path d="M8.4 9.5h7.2M8.4 13h7.2M8.4 16.5h4.6" />
        </svg>
      );
  }
}

/* --- hero visual: one intent in flight through the real gates ------------- */

function ControlPanel() {
  return (
    <div
      className="lp-panel"
      role="img"
      aria-label="Illustrative control panel: a payment intent of 1,250 USDC from agent 7d20be31, allowed by policy, held at the approval gate, simulated, and queued for execution."
    >
      <div className="lp-panel-top">
        <span className="lp-panel-eyebrow">Intent · payment</span>
        <span className="lp-chip lp-chip-hold">
          <span className="lp-chip-dot" aria-hidden="true" />
          requires_approval
        </span>
      </div>

      <div className="lp-panel-amount">
        <span className="lp-num">1,250.00</span>
        <span className="lp-unit">USDC</span>
      </div>

      <div className="lp-panel-owner">
        <span className="lp-mono">agent · 7d20be31</span>
        <span className="lp-mono">dst · GADZ7A…QXYZ</span>
      </div>

      <div className="lp-limits">
        <div className="lp-limit">
          <div className="lp-limit-head">
            <span>Max per tx</span>
            <span className="lp-mono">2,000.00</span>
          </div>
          <span className="lp-bar"><i style={{ width: '63%' }} /></span>
        </div>
        <div className="lp-limit">
          <div className="lp-limit-head">
            <span>Daily limit</span>
            <span className="lp-mono">1,800.00</span>
          </div>
          <span className="lp-bar lp-bar-warn"><i style={{ width: '88%' }} /></span>
        </div>
      </div>

      <ul className="lp-gates">
        <li className="lp-gate lp-gate-ok">
          <span className="lp-gate-dot" aria-hidden="true" />
          <span className="lp-gate-name">Policy</span>
          <span className="lp-gate-val lp-mono">allow</span>
        </li>
        <li className="lp-gate lp-gate-hold">
          <span className="lp-gate-dot" aria-hidden="true" />
          <span className="lp-gate-name">Approval</span>
          <span className="lp-gate-val lp-mono">pending · 22h</span>
        </li>
        <li className="lp-gate lp-gate-ok">
          <span className="lp-gate-dot" aria-hidden="true" />
          <span className="lp-gate-name">Simulation</span>
          <span className="lp-gate-val lp-mono">ok · 100 ops</span>
        </li>
        <li className="lp-gate lp-gate-idle">
          <span className="lp-gate-dot" aria-hidden="true" />
          <span className="lp-gate-name">Execution</span>
          <span className="lp-gate-val lp-mono">queued</span>
        </li>
      </ul>

      <div className="lp-panel-foot">
        <span className="lp-mono">Testnet · simulated</span>
        <span className="lp-mono">LIVE_SUBMIT off</span>
      </div>
    </div>
  );
}

/* --- control plane: two connected dashboard surfaces ---------------------- */

type RowState = 'ok' | 'hold' | 'live' | 'err';

function Row({
  id, main, meta, state, chip,
}: { id: string; main: string; meta: string; state: RowState; chip: string }) {
  return (
    <li className={`lp-row lp-row-${state}`}>
      <span className="lp-mono lp-row-id">{id}</span>
      <span className="lp-row-main">
        <span className="lp-row-main-txt">{main}</span>
        <span className="lp-row-meta">{meta}</span>
      </span>
      <span className={`lp-chip lp-chip-${state === 'live' ? 'info' : state}`}>
        <span className="lp-chip-dot" aria-hidden="true" />
        {chip}
      </span>
    </li>
  );
}

function ControlPlane() {
  return (
    <div className="lp-cp">
      <section className="lp-surface" aria-labelledby="lp-cp-appr">
        <header className="lp-surface-head">
          <h3 id="lp-cp-appr" className="lp-surface-name">Approvals</h3>
          <span className="lp-mono lp-surface-meta">pending_approval · approved · rejected</span>
        </header>
        <ul className="lp-rows">
          <Row id="a91f4c02" main="250.00 USDC" meta="payment · expires in 22h" state="hold" chip="pending_approval" />
          <Row id="3c88e7b4" main="AQUA trustline" meta="trustline · approved by operator" state="ok" chip="approved" />
          <Row id="b2d5e019" main="9,400.00 USDC" meta="payment · over threshold" state="err" chip="rejected" />
        </ul>
      </section>

      <div className="lp-cp-bridge" aria-hidden="true">
        <span className="lp-cp-bridge-line" />
        <span className="lp-cp-bridge-label lp-mono">on approve</span>
      </div>

      <section className="lp-surface" aria-labelledby="lp-cp-exec">
        <header className="lp-surface-head">
          <h3 id="lp-cp-exec" className="lp-surface-name">Executions</h3>
          <span className="lp-mono lp-surface-meta">queued · executing · confirmed · failed</span>
        </header>
        <ul className="lp-rows">
          <Row id="e4b1a077" main="120.00 USDC" meta="attempt 1 · tx hash recorded" state="ok" chip="confirmed" />
          <Row id="e4b1a081" main="48.50 USDC" meta="attempt 2 · sequence coordinated" state="live" chip="executing" />
          <Row id="e4b1a090" main="AQUA trustline" meta="attempt 3 · retry scheduled" state="err" chip="failed" />
        </ul>
      </section>
    </div>
  );
}

/* --- signature: connected execution pipeline ------------------------------ */

function Pipeline() {
  return (
    <div className="lp-pipe-scroll" tabIndex={0} role="group" aria-label="Execution pipeline — eight stages, scrollable">
      <ol className="lp-pipe">
        {STAGES.map((s, i) => (
          <li className={`lp-node lp-node-${s.kind}`} key={s.label}>
            <span className="lp-node-head">
              <span className="lp-node-mark" aria-hidden="true">
                {String(i + 1).padStart(2, '0')}
              </span>
              {i < STAGES.length - 1 && <span className="lp-node-wire" aria-hidden="true" />}
            </span>
            <span className="lp-node-body">
              <span className="lp-node-label">{s.label}</span>
              <span className="lp-node-desc">{s.desc}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export default function Landing() {
  return (
    <div className="lp">
      <a className="lp-skip" href="#lp-main">Skip to content</a>

      <header className="lp-topbar">
        <div className="lp-topbar-in">
          <Link to="/" className="lp-brand">
            <span className="lp-brand-mark" aria-hidden="true">▲</span>
            <span className="lp-brand-name">4evergent</span>
            <span className="lp-badge">Testnet</span>
          </Link>

          <nav className="lp-nav" aria-label="Landing sections">
            <a href="#pipeline">Pipeline</a>
            <a href="#product">Product</a>
            <a href="#capabilities">Capabilities</a>
            <a href="#network">Network</a>
            <a href={DOCS_URL} target="_blank" rel="noreferrer noopener">Docs</a>
          </nav>

          <div className="lp-actions">
            <a className="lp-ghost lp-ghost-sm" href={REPO_URL} target="_blank" rel="noreferrer noopener">
              Repository
            </a>
            <Link to="/login" className="lp-solid lp-solid-sm">Sign In</Link>
          </div>
        </div>
      </header>

      <main id="lp-main" className="lp-main">
        {/* ================================ HERO ================================ */}
        <section className="lp-hero" aria-labelledby="lp-h1">
          <div className="lp-hero-bg" aria-hidden="true">
            <span className="lp-gridlines" />
            <span className="lp-glow lp-glow-a" />
            <span className="lp-glow lp-glow-b" />
          </div>

          <div className="lp-hero-in">
            <div className="lp-hero-copy">
              <p className="lp-eyebrow">
                <span className="lp-pulse" aria-hidden="true" />
                Execution framework for agents on Stellar Testnet
              </p>

              <h1 id="lp-h1" className="lp-h1">
                Agents that act,
                <em>under control.</em>
              </h1>

              <p className="lp-lede">
                An agent proposes a typed intent. A deterministic policy engine — not
                the model — decides whether it is allowed, denied, or must wait for a
                human. Nothing is signed before it is simulated.
              </p>

              <div className="lp-cta">
                <Link to="/login" className="lp-solid lp-solid-lg">Open the dashboard</Link>
                <a className="lp-ghost lp-ghost-lg" href={REPO_URL} target="_blank" rel="noreferrer noopener">
                  Read the source
                </a>
              </div>

              <ul className="lp-hero-facts">
                <li>MIT licensed</li>
                <li>Self-hosted</li>
                <li>No token</li>
                <li>No mainnet assumptions</li>
              </ul>
            </div>

            <div className="lp-hero-visual">
              <ControlPanel />
            </div>
          </div>
        </section>

        {/* ============================== PIPELINE ============================== */}
        <section className="lp-band" id="pipeline" aria-labelledby="lp-h-pipe">
          <div className="lp-band-in">
            <div className="lp-sechead">
              <p className="lp-kicker">Execution path</p>
              <h2 id="lp-h-pipe" className="lp-h2">Every intent takes the same road</h2>
              <p className="lp-secnote">
                Eight stages in a fixed order. Policy is never skipped, and the agent
                itself has no path to the signing step.
              </p>
            </div>

            <Pipeline />

            <div className="lp-verdicts">
              <p className="lp-verdicts-label">Policy answers with one of three verdicts</p>
              <div className="lp-verdict-row">
                <div className="lp-verdict lp-verdict-ok">
                  <code>allow</code>
                  <span>Proceeds to simulation and execution.</span>
                </div>
                <div className="lp-verdict lp-verdict-hold">
                  <code>requires_approval</code>
                  <span>Halts at the human gate until approved or expired.</span>
                </div>
                <div className="lp-verdict lp-verdict-err">
                  <code>deny</code>
                  <span>Rejected by rule — never built, never signed.</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ============================ CONTROL PLANE =========================== */}
        <section className="lp-band" id="product" aria-labelledby="lp-h-cp">
          <div className="lp-band-in">
            <div className="lp-sechead">
              <p className="lp-kicker">Control plane</p>
              <h2 id="lp-h-cp" className="lp-h2">The operator sees every state</h2>
              <p className="lp-secnote">
                The framework ships with an operational dashboard. These panels mirror
                the shipped Approvals and Executions views and the status values they
                actually render.
              </p>
            </div>

            <ControlPlane />

            <p className="lp-fineprint">
              Illustrative rows — not live data. Status values match ApprovalStatus and
              ExecutionStatus in the shipped types.
            </p>
          </div>
        </section>

        {/* ============================ CAPABILITIES ============================ */}
        <section className="lp-band" id="capabilities" aria-labelledby="lp-h-caps">
          <div className="lp-band-in">
            <div className="lp-sechead">
              <p className="lp-kicker">Capabilities</p>
              <h2 id="lp-h-caps" className="lp-h2">Parts of one execution system</h2>
            </div>

            <ul className="lp-caps">
              {CAPABILITIES.map((c) => (
                <li className="lp-cap" key={c.k}>
                  <span className="lp-cap-icon" aria-hidden="true">
                    <Icon name={c.k} />
                  </span>
                  <span className="lp-cap-text">
                    <span className="lp-cap-title">{c.title}</span>
                    <span className="lp-cap-line">{c.line}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* =============================== NETWORK ============================== */}
        <section className="lp-band" id="network" aria-labelledby="lp-h-net">
          <div className="lp-band-in lp-net">
            <div className="lp-net-copy">
              <p className="lp-kicker">Network</p>
              <h2 id="lp-h-net" className="lp-h2">Testnet first, on purpose</h2>
              <p className="lp-secnote">
                This build makes no mainnet assumption. No token, no presale, no
                speculative economics — and live submission stays off unless you
                switch it on explicitly.
              </p>
              <p className="lp-disclaimer">
                Transactions are simulated and are not suitable for production value.
              </p>
            </div>

            <dl className="lp-facts">
              {FACTS.map((f) => (
                <div className="lp-fact" key={f.k}>
                  <dt className="lp-fact-label">{f.label}</dt>
                  <dd className="lp-fact-value">{f.value}</dd>
                  <dd className="lp-fact-note lp-mono">{f.note}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* ================================ CLOSING ============================= */}
        <section className="lp-final" aria-labelledby="lp-h-final">
          <div className="lp-final-in">
            <span className="lp-final-mark" aria-hidden="true">▲</span>
            <h2 id="lp-h-final" className="lp-h2 lp-h2-final">Open source. Built to be audited.</h2>
            <p className="lp-final-note">
              Read the policy engine, run it against Testnet, keep the keys. Operators
              get the dashboard; developers get the source.
            </p>
            <div className="lp-cta">
              <Link to="/login" className="lp-solid lp-solid-lg">Open the dashboard</Link>
              <a className="lp-ghost lp-ghost-lg" href={REPO_URL} target="_blank" rel="noreferrer noopener">
                Repository
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <div className="lp-foot-in">
          <span className="lp-foot-brand">
            <span className="lp-brand-mark" aria-hidden="true">▲</span>
            4evergent
          </span>
          <span className="lp-foot-note">Policy-controlled agent execution on Stellar Testnet.</span>
          <nav className="lp-foot-links" aria-label="Footer links">
            <a href={REPO_URL} target="_blank" rel="noreferrer noopener">Source</a>
            <a href={DOCS_URL} target="_blank" rel="noreferrer noopener">Docs</a>
            <Link to="/login">Sign in</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
