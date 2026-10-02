import { Link } from 'react-router-dom';

/* ==========================================================================
   Public landing page — /
   Visual structure follows the supplied reference screenshot: dark navy-black
   substrate, cyan signal, a policy-engine graph in the hero, a connected
   eight-stage pipeline, an Approvals/Executions control plane, a capability
   grid, a Testnet panel and an open-source closing.

   Every claim is traceable to the shipped implementation:
     pipeline order   apps/api/src/index.ts (policy.evaluate → approval →
                      pipeline.execute) and packages/stellar/src/pipeline.ts
                      (build → simulate → sign → submit)
     three verdicts   types.ts  PolicyDecision.result  allow|deny|requires_approval
     approval states  types.ts  ApprovalStatus
     execution states types.ts  ExecutionStatus  queued|executing|submitted|
                                confirmed|failed|dead_letter
     policy rules     types.ts  PolicyRules
     schedule states  types.ts  ScheduleStatus   active|paused|disabled
     intent types     types.ts  IntentType; Submit.tsx exposes payment+trustline;
                                raw XDR rejected at the API
     live-submit gate packages/stellar/src/submitter.ts + network-guard.ts
     MIT licence      LICENSE
   No metrics, customers, testimonials or logos are claimed. Rows shown in the
   control plane are illustrative and labelled as such.
   ========================================================================== */

const REPO_URL = 'https://github.com/naninu123/4evergent';
const DOCS_URL = `${REPO_URL}/tree/main/docs`;

type Kind = 'flow' | 'policy' | 'gate' | 'chain' | 'record';
type Stage = { label: string; desc: string; kind: Kind };

const STAGES: Stage[] = [
  { label: 'Agent', desc: 'Identity + Stellar address', kind: 'flow' },
  { label: 'Intent', desc: 'Typed payment or trustline', kind: 'flow' },
  { label: 'Policy', desc: 'Deterministic rule check', kind: 'policy' },
  { label: 'Approval', desc: 'Human gate above threshold', kind: 'gate' },
  { label: 'Simulation', desc: 'Simulated before signing', kind: 'flow' },
  { label: 'Execution', desc: 'Sequence-coordinated', kind: 'flow' },
  { label: 'Stellar', desc: 'Testnet transaction', kind: 'chain' },
  { label: 'Activity', desc: 'Recorded and replayable', kind: 'record' },
];

const CHIPS = ['Secure operations', 'No arbitrary execution', 'Open source', 'Fast & low cost'];

const HERO_CARDS = [
  { k: 'wallet', title: 'Permissioned wallets', line: 'Each agent gets a scoped Stellar address.' },
  { k: 'policy', title: 'Deterministic policy', line: 'Rules decide, not the model.' },
  { k: 'oss', title: 'Open source & built for Stellar', line: 'MIT licensed, testnet first.' },
];

type CapKey = 'agent' | 'policy' | 'intent' | 'simulation' | 'approval' | 'execution' | 'schedule' | 'audit';

const CAPABILITIES: { k: CapKey; title: string; line: string }[] = [
  { k: 'agent', title: 'Agents', line: 'Persistent identity, Stellar address and a capability set.' },
  { k: 'policy', title: 'Policies', line: 'Tx and daily limits, allowed assets, destinations and contracts.' },
  { k: 'intent', title: 'Intents', line: 'Schema-typed payment and trustline requests.' },
  { k: 'simulation', title: 'Simulation', line: 'Fee, operations and warnings before any signature.' },
  { k: 'approval', title: 'Approval', line: 'Threshold-triggered human gate with expiry.' },
  { k: 'execution', title: 'Execution', line: 'One coordinated writer per account, retry and dead-letter.' },
  { k: 'schedule', title: 'Schedules', line: 'Recurring intents — active, paused or disabled.' },
  { k: 'audit', title: 'Audit trail', line: 'Every decision, simulation and transaction recorded.' },
];

const TESTNET_POINTS = [
  { k: 'env', label: 'Testnet environment', line: 'Horizon Testnet with the SDF test passphrase.' },
  { k: 'sim', label: 'Simulated approvals & execution', line: 'Every transaction is simulated before signing.' },
  { k: 'obs', label: 'Full observability', line: 'Activity and execution history stay on record.' },
];

/* --- inline icons ---------------------------------------------------------- */

function Icon({ name }: { name: CapKey }) {
  const p = {
    width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': true, focusable: false,
  } as const;
  switch (name) {
    case 'agent':
      return (<svg {...p}><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10.5h5M7 13.5h8" /></svg>);
    case 'policy':
      return (<svg {...p}><path d="M12 3.2l6.8 2.9v5c0 4-2.8 7-6.8 8.4-4-1.4-6.8-4.4-6.8-8.4v-5z" /><path d="M9.2 11.8l1.9 1.9 3.8-3.9" /></svg>);
    case 'intent':
      return (<svg {...p}><path d="M4 7h12M4 12h9M4 17h6" /><path d="M17.5 14.5L20 17l-2.5 2.5" /></svg>);
    case 'simulation':
      return (<svg {...p}><circle cx="10.8" cy="10.8" r="6.2" /><path d="M15.4 15.4L20 20" /><path d="M8.6 10.8h4.4M10.8 8.6v4.4" /></svg>);
    case 'approval':
      return (<svg {...p}><circle cx="9" cy="8" r="3" /><path d="M4 18.5c.8-2.6 2.7-4 5-4s4.2 1.4 5 4" /><path d="M15.5 13l2.2 2.2 4.3-4.6" /></svg>);
    case 'execution':
      return (<svg {...p}><path d="M12 3.5v5M12 15.5v5" /><circle cx="12" cy="12" r="3.2" /><path d="M5.5 8.5L8 12l-2.5 3.5M18.5 8.5L16 12l2.5 3.5" /></svg>);
    case 'schedule':
      return (<svg {...p}><rect x="3.5" y="5.5" width="17" height="15" rx="2" /><path d="M3.5 10.5h17M8 3.5v3.2M16 3.5v3.2" /><path d="M11 13.5l1.8 1.8 3-3.2" /></svg>);
    default:
      return (<svg {...p}><path d="M5.5 3.8h9l4 4v12.4h-13z" /><path d="M8.4 9.5h7.2M8.4 13h7.2M8.4 16.5h4.6" /></svg>);
  }
}

/* --- hero visual: the policy engine and its three verdicts ----------------- */

/*
 * Network geometry mirrors the runtime order:
 *   typed intent (payment / trustline)  →  policy engine
 *   engine → allow | requires_approval | deny
 *   only allow continues: simulate → sign → submit (Stellar Testnet)
 *   a pending approval can expire back into the record (dashed return path)
 * All labels are real enum values or shipped stage names; nothing is invented.
 */
const EDGES: string[] = [
  'M52 66 C 84 66, 86 150, 104 150',
  'M52 234 C 84 234, 86 150, 104 150',
  'M140 150 C 186 150, 182 62, 226 62',
  'M140 150 L 226 150',
  'M140 150 C 186 150, 182 240, 226 240',
  'M258 62 C 296 62, 292 96, 320 96',
  'M352 96 C 380 96, 378 148, 398 148',
  'M398 174 C 380 208, 366 206, 336 206',
  'M258 150 C 302 150, 302 198, 258 198',
  'M408 172 C 408 196, 372 214, 336 214',
];

function PolicyGraph() {
  return (
    <div
      className="lp-graph"
      role="img"
      aria-label="Diagram: typed payment and trustline intents reach the policy engine, which answers allow, requires_approval or deny. Only an allowed intent proceeds to simulate, sign and submit on Stellar Testnet. A pending approval can expire."
    >
      <div className="lp-graph-head">
        <span className="lp-graph-title">Policy engine</span>
        <span className="lp-chip lp-chip-info">
          <span className="lp-chip-dot" aria-hidden="true" />
          evaluating
        </span>
      </div>

      <svg className="lp-graph-svg" viewBox="0 0 460 300" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <defs>
          <linearGradient id="lpWire" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#2fc9f7" stopOpacity="0.9" />
            <stop offset="50%" stopColor="#2fc9f7" stopOpacity="1" />
            <stop offset="100%" stopColor="#2fc9f7" stopOpacity="0.9" />
          </linearGradient>
          <radialGradient id="lpHub" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#5fe0ff" stopOpacity="0.5" />
            <stop offset="60%" stopColor="#2fc9f7" stopOpacity="0.16" />
            <stop offset="100%" stopColor="#2fc9f7" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* deep-blue structural lattice behind the network */}
        <g className="lp-lattice">
          {Array.from({ length: 7 }, (_, i) => (
            <line key={`v${i}`} x1={40 + i * 64} y1="12" x2={40 + i * 64} y2="288" />
          ))}
          {Array.from({ length: 5 }, (_, i) => (
            <line key={`h${i}`} x1="12" y1={30 + i * 62} x2="448" y2={30 + i * 62} />
          ))}
        </g>

        {/* engine bloom */}
        <circle cx="122" cy="150" r="52" fill="url(#lpHub)" />

        {/* continuous deep-blue bed under every wire */}
        {EDGES.map((d, i) => (<path key={`u${i}`} className="lp-edge-under" d={d} />))}
        {/* bright cyan core */}
        {EDGES.map((d, i) => (<path key={`c${i}`} className="lp-edge" d={d} />))}
        {/* travelling pulse on the three primary branches */}
        <path className="lp-edge-flow" d={EDGES[2]} />
        <path className="lp-edge-flow" d={EDGES[3]} />
        <path className="lp-edge-flow" d={EDGES[5]} />

        {/* intent sources */}
        <circle className="lp-core lp-core-src" cx="44" cy="66" r="13" />
        <circle className="lp-core lp-core-src" cx="44" cy="234" r="13" />
        <text className="lp-tag" x="62" y="56">payment</text>
        <text className="lp-tag" x="62" y="224">trustline</text>

        {/* policy engine hub */}
        <circle className="lp-ring lp-ring-2" cx="122" cy="150" r="40" />
        <circle className="lp-ring" cx="122" cy="150" r="30" />
        <circle className="lp-core lp-core-engine" cx="122" cy="150" r="21" />
        <text className="lp-tag lp-tag-head" x="122" y="110">POLICY ENGINE</text>

        {/* verdicts */}
        <circle className="lp-halo" cx="242" cy="62" r="24" /><circle className="lp-core lp-core-ok" cx="242" cy="62" r="15" />
        <circle className="lp-halo" cx="242" cy="150" r="24" /><circle className="lp-core lp-core-hold" cx="242" cy="150" r="15" />
        <circle className="lp-halo" cx="242" cy="240" r="24" /><circle className="lp-core lp-core-err" cx="242" cy="240" r="15" />
        <text className="lp-tag" x="260" y="48">allow</text>
        <text className="lp-tag" x="260" y="136">requires_approval</text>
        <text className="lp-tag" x="260" y="226">deny</text>

        {/* allow → simulate → sign · submit */}
        <circle className="lp-core lp-core-blue" cx="336" cy="96" r="13" />
        <circle className="lp-core lp-core-chain" cx="404" cy="160" r="13" />
        <circle className="lp-core lp-core-chain" cx="328" cy="212" r="13" />
        <text className="lp-tag" x="350" y="84">simulate</text>
        <text className="lp-tag" x="356" y="232">sign</text>
        <text className="lp-tag" x="392" y="232">submit</text>
        <text className="lp-tag lp-tag-dim" x="428" y="182">stellar</text>

        {/* hold → expiry return path */}
        <text className="lp-tag lp-tag-dim" x="286" y="196">expires</text>
      </svg>

      <ul className="lp-graph-legend">
        <li className="lp-gl-ok"><span className="lp-dot" aria-hidden="true" />allow</li>
        <li className="lp-gl-hold"><span className="lp-dot" aria-hidden="true" />requires_approval</li>
        <li className="lp-gl-err"><span className="lp-dot" aria-hidden="true" />deny</li>
      </ul>

      <div className="lp-graph-foot">
        <span className="lp-mono">allow → simulate → sign → submit</span>
      </div>
    </div>
  );
}

function HeroCards() {
  return (
    <ul className="lp-hero-cards">
      {HERO_CARDS.map((c) => (
        <li className="lp-hero-card" key={c.k}>
          <span className="lp-hero-card-title">{c.title}</span>
          <span className="lp-hero-card-line">{c.line}</span>
        </li>
      ))}
    </ul>
  );
}

/* --- pipeline -------------------------------------------------------------- */

function Pipeline() {
  return (
    <div
      className="lp-pipe-scroll"
      tabIndex={0}
      role="group"
      aria-label="Execution pipeline — eight stages, horizontally scrollable"
    >
      <ol className="lp-pipe">
        {STAGES.map((s, i) => (
          <li className={`lp-step lp-step-${s.kind}`} key={s.label}>
            <span className="lp-step-rail" aria-hidden="true">
              <span className="lp-step-mark">
                <span className="lp-step-num">{String(i + 1).padStart(2, '0')}</span>
              </span>
              {i < STAGES.length - 1 && <span className="lp-step-wire" />}
            </span>
            <span className="lp-step-body">
              <span className="lp-step-label">{s.label}</span>
              <span className="lp-step-desc">{s.desc}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* --- control plane --------------------------------------------------------- */

type RowState = 'ok' | 'hold' | 'live' | 'err';

function Row({
  id, main, meta, state, chip,
}: { id: string; main: string; meta: string; state: RowState; chip: string }) {
  return (
    <li className={`lp-row lp-row-${state}`}>
      <span className="lp-mono lp-row-id">{id}</span>
      <span className="lp-row-main-txt">{main}</span>
      <span className="lp-row-meta">{meta}</span>
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
      <section className="lp-panel-box" aria-labelledby="lp-cp-appr">
        <header className="lp-panel-box-head">
          <h3 id="lp-cp-appr" className="lp-panel-box-name">Approvals</h3>
          <span className="lp-mono lp-panel-box-meta">pending_approval · approved · rejected</span>
        </header>
        <ul className="lp-rows">
          <Row id="a91f4c02" main="250.00 USDC" meta="payment · expires in 22h" state="hold" chip="pending_approval" />
          <Row id="3c88e7b4" main="AQUA trustline" meta="trustline · approved" state="ok" chip="approved" />
          <Row id="b2d5e019" main="9,400.00 USDC" meta="payment · over threshold" state="err" chip="rejected" />
        </ul>
      </section>

      <div className="lp-bridge" aria-hidden="true">
        <span className="lp-bridge-line" />
        <span className="lp-bridge-label lp-mono">on approve</span>
      </div>

      <section className="lp-panel-box" aria-labelledby="lp-cp-exec">
        <header className="lp-panel-box-head">
          <h3 id="lp-cp-exec" className="lp-panel-box-name">Executions</h3>
          <span className="lp-mono lp-panel-box-meta">queued · executing · confirmed · failed</span>
        </header>
        <ul className="lp-rows">
          <Row id="e4b1a077" main="120.00 USDC" meta="attempt 1" state="ok" chip="confirmed" />
          <Row id="e4b1a081" main="48.50 USDC" meta="attempt 2" state="live" chip="executing" />
          <Row id="e4b1a090" main="AQUA trustline" meta="retry scheduled" state="err" chip="failed" />
        </ul>
      </section>
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
          </Link>

          <nav className="lp-nav" aria-label="Landing sections">
            <a href="#product">Product</a>
            <a href="#capabilities">Capabilities</a>
            <a href="#network">Network</a>
            <a href={DOCS_URL} target="_blank" rel="noreferrer noopener">Docs</a>
          </nav>

          <div className="lp-actions">
            <a className="lp-ghost lp-ghost-sm" href={REPO_URL} target="_blank" rel="noreferrer noopener">Repository</a>
            <Link to="/login" className="lp-solid lp-solid-sm">Sign In</Link>
          </div>
        </div>
      </header>

      <main id="lp-main" className="lp-main">
        {/* =============================== HERO =============================== */}
        <section className="lp-hero" aria-labelledby="lp-h1">
          <div className="lp-hero-bg" aria-hidden="true">
            <span className="lp-gridlines" />
            <span className="lp-glow lp-glow-a" />
            <span className="lp-glow lp-glow-b" />
          </div>

          <div className="lp-hero-in">
            <div className="lp-hero-copy">
              <p className="lp-eyebrow">Autonomous financial agents</p>
              <h1 id="lp-h1" className="lp-h1">
                Agents that act,
                <em>under control.</em>
              </h1>
              <p className="lp-lede">
                4evergent is an open-source framework for running agents with
                permissioned Stellar wallets. The model proposes a typed intent — a
                deterministic policy engine, independent of the model, decides whether
                it is allowed, denied, or requires human approval before anything is
                signed.
              </p>
              <div className="lp-cta">
                <a className="lp-solid lp-solid-lg" href={DOCS_URL} target="_blank" rel="noreferrer noopener">View docs</a>
                <a className="lp-ghost lp-ghost-lg" href={REPO_URL} target="_blank" rel="noreferrer noopener">Read the source</a>
              </div>
            </div>

            <div className="lp-hero-visual">
              <PolicyGraph />
            </div>
          </div>

          <div className="lp-hero-lower">
            <HeroCards />
            <ul className="lp-chips">
              {CHIPS.map((c) => (<li className="lp-chip lp-chip-neutral" key={c}>{c}</li>))}
            </ul>
          </div>
        </section>

        {/* ============================= PIPELINE ============================= */}
        <section className="lp-band" id="pipeline" aria-labelledby="lp-h-pipe">
          <div className="lp-band-in">
            <p className="lp-kicker">The execution pipeline</p>
            <h2 id="lp-h-pipe" className="lp-h2">One path from intent to transaction</h2>
            <p className="lp-secnote">
              Every intent traverses the same ordered pipeline. Nothing skips the policy
              stage, and nothing is signed before simulation.
            </p>

            <Pipeline />

            <div className="lp-verdicts">
              <p className="lp-verdicts-label">Policy answers with one of three verdicts</p>
              <div className="lp-verdict-row">
                <div className="lp-verdict lp-verdict-ok">
                  <code>allow</code><span>Proceeds to simulation and execution.</span>
                </div>
                <div className="lp-verdict lp-verdict-hold">
                  <code>requires_approval</code><span>Halts at the human gate until approved or expired.</span>
                </div>
                <div className="lp-verdict lp-verdict-err">
                  <code>deny</code><span>Rejected by rule — never built, never signed.</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* =========================== CONTROL PLANE ========================== */}
        <section className="lp-band" id="product" aria-labelledby="lp-h-cp">
          <div className="lp-band-in">
            <p className="lp-kicker">Control plane</p>
            <h2 id="lp-h-cp" className="lp-h2">The operator sees every state</h2>
            <p className="lp-secnote">
              The framework ships with an operational dashboard. The columns, status
              values and table components below are taken from the shipped Approvals and
              Executions views.
            </p>

            <ControlPlane />

            <p className="lp-fineprint">
              Illustrative rows — not live data. Status values match ApprovalStatus and
              ExecutionStatus in the shipped types.
            </p>
          </div>
        </section>

        {/* ============================ CAPABILITIES ========================== */}
        <section className="lp-band" id="capabilities" aria-labelledby="lp-h-caps">
          <div className="lp-band-in">
            <p className="lp-kicker">Capabilities</p>
            <h2 id="lp-h-caps" className="lp-h2">Built for real-world agents</h2>
            <p className="lp-secnote">Eight core capabilities. One framework.</p>

            <ul className="lp-caps">
              {CAPABILITIES.map((c) => (
                <li className="lp-cap" key={c.k}>
                  <span className="lp-cap-icon" aria-hidden="true"><Icon name={c.k} /></span>
                  <span className="lp-cap-text">
                    <span className="lp-cap-title">{c.title}</span>
                    <span className="lp-cap-line">{c.line}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ============================== NETWORK ============================= */}
        <section className="lp-band" id="network" aria-labelledby="lp-h-net">
          <div className="lp-band-in lp-net">
            <div className="lp-net-visual">
              <div className="lp-netpanel">
                <div className="lp-netpanel-head">
                  <span className="lp-mono">stellar · testnet</span>
                  <span className="lp-chip lp-chip-info">live</span>
                </div>
                <dl className="lp-netpanel-rows">
                  <div className="lp-netpanel-row"><dt>Network</dt><dd className="lp-mono">Test SDF Network ; September 2015</dd></div>
                  <div className="lp-netpanel-row"><dt>Horizon</dt><dd className="lp-mono">horizon-testnet.stellar.org</dd></div>
                  <div className="lp-netpanel-row"><dt>Submission</dt><dd className="lp-mono">LIVE_SUBMIT off</dd></div>
                </dl>
              </div>
            </div>

            <div className="lp-net-copy">
              <p className="lp-kicker">Network</p>
              <h2 id="lp-h-net" className="lp-h2">Testnet first</h2>
              <p className="lp-secnote">
                Runs against Stellar Testnet only — no mainnet assumption and no real
                value at risk. Live submission stays off unless you switch it on
                explicitly.
              </p>
              <ul className="lp-points">
                {TESTNET_POINTS.map((p) => (
                  <li className="lp-point" key={p.k}>
                    <span className="lp-point-mark" aria-hidden="true" />
                    <span className="lp-point-body">
                      <span className="lp-point-label">{p.label}</span>
                      <span className="lp-point-line">{p.line}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* ============================== CLOSING ============================= */}
        <section className="lp-final" aria-labelledby="lp-h-final">
          <div className="lp-final-in">
            <span className="lp-final-mark" aria-hidden="true">▲</span>
            <h2 id="lp-h-final" className="lp-h2 lp-h2-final">Open source. Built for the future.</h2>
            <p className="lp-final-note">
              Join the community, contribute, or deploy your own agents today.
            </p>
            <div className="lp-cta lp-cta-center">
              <Link to="/login" className="lp-solid lp-solid-lg">Open the dashboard</Link>
              <a className="lp-ghost lp-ghost-lg" href={REPO_URL} target="_blank" rel="noreferrer noopener">Repository</a>
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
          <span className="lp-foot-note">© 2026 4evergent · Open source, built on Stellar.</span>
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
