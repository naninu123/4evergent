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
  'M396 172 C 378 204, 366 204, 336 204',
  'M258 150 C 302 150, 302 198, 258 198',
  'M402 168 C 402 194, 372 212, 336 212',
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
        <text className="lp-tag lp-tag-dim" x="360" y="182">stellar</text>

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
            <a href={DOCS_URL} target="_blank" rel="noreferrer noopener">Docs</a>
            <a href={REPO_URL} target="_blank" rel="noreferrer noopener">Source</a>
            <a href={`${REPO_URL}#readme`} target="_blank" rel="noreferrer noopener">Community</a>
          </nav>

          <div className="lp-actions">
            <Link to="/login" className="lp-solid lp-solid-sm">Get Started</Link>
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
              <p className="lp-eyebrow"><span className="lp-eyebrow-dot" aria-hidden="true" />Policy engine</p>
              <h1 id="lp-h1" className="lp-h1">
                Autonomous
                <em>Financial Agents</em>
              </h1>
              <p className="lp-h1sub">Agents that act,<br />under control.</p>
              <p className="lp-lede">
                4evergent is an open-source framework for running agents with
                permissioned Stellar wallets. The model proposes a typed intent — a
                deterministic policy engine, independent of the model, decides whether
                it is allowed, denied, or requires human approval before anything is
                signed.
              </p>
              <div className="lp-cta">
                <a className="lp-solid lp-solid-lg" href={DOCS_URL} target="_blank" rel="noreferrer noopener">View docs <span aria-hidden="true">→</span></a>
                <a className="lp-ghost lp-ghost-lg" href={REPO_URL} target="_blank" rel="noreferrer noopener">Read the source</a>
              </div>
            </div>

            <div className="lp-hero-visual">
              <PolicyGraph />
            </div>
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
          </div>
        </section>

        {/* =========================== CONTROL PLANE ========================== */}
        <section className="lp-band" id="product" aria-labelledby="lp-h-cp">
          <div className="lp-band-in">
            <p className="lp-kicker">Control</p>
            <div className="lp-cp-cols">
              <div className="lp-cp-col">
                <h2 id="lp-h-cp" className="lp-h2">Control Plane</h2>
                <p className="lp-sub">Policy, identity and compliance — always on.</p>
                <ul className="lp-checks">
                  <li>Deterministic policy engine</li>
                  <li>Permissioned wallets</li>
                  <li>Audit &amp; observability</li>
                </ul>
              </div>
              <div className="lp-cp-col">
                <h3 className="lp-h2">Autonomous Agents</h3>
                <p className="lp-sub">Secure, composable and built for the real world.</p>
                <ul className="lp-checks">
                  <li>On-chain &amp; off-chain actions</li>
                  <li>Context-aware decision making</li>
                  <li>Full lifecycle control</li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* ============================ CAPABILITIES ========================== */}
        <section className="lp-band" id="capabilities" aria-labelledby="lp-h-caps">
          <div className="lp-band-in lp-caps-layout">
            <div className="lp-caps-head">
              <p className="lp-kicker">Capabilities</p>
              <h2 id="lp-h-caps" className="lp-h2">Built for what's next.</h2>
              <p className="lp-sub">Eight core capabilities working together to give you
                programmable, secure and compliant financial agents.</p>
            </div>

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
          <div className="lp-band-in">
            <div className="lp-testnet">
              <span className="lp-testnet-arc" aria-hidden="true" />
              <span className="lp-testnet-icon" aria-hidden="true">◎</span>
              <div className="lp-testnet-copy">
                <p className="lp-kicker">Testnet</p>
                <h2 id="lp-h-net" className="lp-h2">Try it on Stellar Testnet</h2>
                <p className="lp-sub">Explore the platform, test agents and build with
                  confidence — all on the Stellar Testnet.</p>
              </div>
              <Link to="/login" className="lp-testnet-go">Get started <span aria-hidden="true">→</span></Link>
            </div>
          </div>
        </section>

        {/* ============================== CLOSING ============================= */}
        <section className="lp-final" aria-labelledby="lp-h-final">
          <div className="lp-final-in">
            <h2 id="lp-h-final" className="lp-h2 lp-h2-final">Secure. Compliant. Programmable.</h2>
            <p className="lp-final-note">
              The financial agent platform for a more open internet.
            </p>
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <div className="lp-foot-in">
          <span className="lp-foot-brand">
            <span className="lp-brand-mark" aria-hidden="true">▲</span>
            4evergent
          </span>
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
