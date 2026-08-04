import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import styles from './index.module.css';

type IconName = 'shield' | 'key' | 'meter' | 'receipt';

const coders = ['Claude Code', 'Codex', 'OpenCode', 'Grok'];

const capabilities: Array<{
  icon: IconName;
  index: string;
  title: string;
  copy: string;
  signal: string;
}> = [
  {
    icon: 'shield',
    index: '01',
    title: 'Contain the worker',
    copy: 'Every run starts inside a probed OS boundary with an isolated home. If Seatbelt or bubblewrap + seccomp cannot be proven, the run does not start.',
    signal: 'required containment',
  },
  {
    icon: 'key',
    index: '02',
    title: 'Keep authority outside',
    copy: 'The daemon owns policy, credentials, approvals, and durable state. Workers receive only the capability needed for one bounded job.',
    signal: 'least authority',
  },
  {
    icon: 'meter',
    index: '03',
    title: 'Make cost finite',
    copy: 'Request, token, concurrency, and trusted-price ceilings are decided before execution. Unknown price is never quietly treated as free.',
    signal: 'fail-closed budgets',
  },
  {
    icon: 'receipt',
    index: '04',
    title: 'Prove the outcome',
    copy: 'Results, policy, authorization, containment, gates, and digests become a portable receipt anchored to a tamper-evident ledger.',
    signal: 'offline verification',
  },
];

const flow = [
  ['01', 'Setup', 'External state. Explicit trust.'],
  ['02', 'Run', 'One contained, provider-neutral job.'],
  ['03', 'Gate', 'Policy, budget, and project checks.'],
  ['04', 'Anchor', 'Receipt digest enters the ledger.'],
  ['05', 'Verify', 'Recompute the proof independently.'],
] as const;

function Glyph({name}: {name: IconName}) {
  if (name === 'shield') {
    return <svg viewBox="0 0 28 28" aria-hidden="true"><path d="M14 2.8 23 6v6.7c0 5.6-3.5 10.6-9 12.5-5.5-1.9-9-6.9-9-12.5V6l9-3.2Z"/><path d="m9.5 14 3 3 6-7"/></svg>;
  }
  if (name === 'key') {
    return <svg viewBox="0 0 28 28" aria-hidden="true"><circle cx="9" cy="14" r="5"/><path d="M14 14h10m-3 0v4m-4-4v3"/></svg>;
  }
  if (name === 'meter') {
    return <svg viewBox="0 0 28 28" aria-hidden="true"><path d="M4 21a11 11 0 1 1 20 0"/><path d="m14 14 5-5"/><path d="M8 21h12"/></svg>;
  }
  return <svg viewBox="0 0 28 28" aria-hidden="true"><path d="M7 3h14v22l-3-2-4 2-4-2-3 2V3Z"/><path d="M10 9h8m-8 4h8m-8 4h5"/></svg>;
}

function CapabilityCard({icon, index, title, copy, signal}: (typeof capabilities)[number]) {
  return (
    <article className={styles.capabilityCard}>
      <div className={styles.capabilityTop}>
        <span className={styles.capabilityIcon}><Glyph name={icon} /></span>
        <span className={styles.cardIndex}>{index}</span>
      </div>
      <h3>{title}</h3>
      <p>{copy}</p>
      <span className={styles.signal}><i />{signal}</span>
    </article>
  );
}

function ConsoleLine({time, label, children, tone = 'default'}: {
  time: string;
  label: string;
  children: ReactNode;
  tone?: 'default' | 'mint' | 'gold';
}) {
  return (
    <div className={styles.consoleLine}>
      <span className={styles.consoleTime}>{time}</span>
      <span className={`${styles.consoleLabel} ${styles[tone]}`}>{label}</span>
      <span className={styles.consoleValue}>{children}</span>
    </div>
  );
}

function HeroProof() {
  return (
    <div className={styles.heroProof} aria-label="Example verified Headless run">
      <div className={styles.windowBar}>
        <div className={styles.windowDots}><i/><i/><i/></div>
        <span>RUN / HX_7F2A</span>
        <span className={styles.liveState}><i/> verified</span>
      </div>
      <div className={styles.proofBody}>
        <div className={styles.commandLine}>
          <span>$</span> headless exec <b>--backend codex</b> --profile read-only-native
        </div>
        <div className={styles.consoleRule} />
        <ConsoleLine time="00:00.018" label="BOUNDARY" tone="mint">seatbelt / required</ConsoleLine>
        <ConsoleLine time="00:00.023" label="POLICY" tone="mint">admitted · read-only</ConsoleLine>
        <ConsoleLine time="00:00.027" label="AUTH">native capsule · scoped</ConsoleLine>
        <ConsoleLine time="00:02.841" label="RESULT">succeeded · 1 artifact</ConsoleLine>
        <ConsoleLine time="00:02.848" label="RECEIPT" tone="gold">sha256:6fb8…91c2</ConsoleLine>
        <ConsoleLine time="00:02.851" label="LEDGER" tone="gold">anchor #184 · chain valid</ConsoleLine>
        <div className={styles.proofSeal}>
          <svg viewBox="0 0 34 34" aria-hidden="true"><path d="m8 17 6 6L27 9"/></svg>
          <div>
            <strong>Proof complete</strong>
            <span>portable · tamper-evident · independently verifiable</span>
          </div>
        </div>
      </div>
      <div className={styles.proofGrid} aria-hidden="true" />
    </div>
  );
}

export default function Home(): ReactNode {
  return (
    <Layout
      title="Proof of work for AI agents"
      description="A provider-neutral control plane for contained, policy-bound, independently verifiable AI coding runs.">
      <main className={styles.page}>
        <section className={styles.hero}>
          <div className={styles.heroAura} aria-hidden="true" />
          <div className={styles.heroInner}>
            <div className={styles.heroCopy}>
              <div className={styles.eyebrow}><span>Private beta · 0.2</span> Universal agent control plane</div>
              <h1>Give every AI coding run a <em>chain of custody.</em></h1>
              <p className={styles.heroLead}>
                Headless puts Claude Code, Codex, OpenCode, and Grok behind one local authority—then contains the work, bounds the spend, gates the change, and issues proof.
              </p>
              <div className={styles.heroActions}>
                <Link className={styles.primaryAction} to="/getting-started/quickstart">
                  Run the golden path <span aria-hidden="true">↗</span>
                </Link>
                <Link className={styles.secondaryAction} to="/concepts/receipts">
                  See what a receipt proves
                </Link>
              </div>
              <div className={styles.coderStrip} aria-label="Supported AI coding CLIs">
                <span className={styles.coderLabel}>ONE CONTROL PLANE</span>
                {coders.map((coder) => <span key={coder}>{coder}</span>)}
              </div>
            </div>
            <HeroProof />
          </div>
        </section>

        <section className={styles.statement}>
          <div className={styles.sectionTag}>THE OPERATING PRINCIPLE</div>
          <p>Agents can be powerful without becoming trusted.</p>
          <div className={styles.statementRule}>
            <span>Assume the worker is compromised.</span>
            <span>Keep the proof outside the worker.</span>
          </div>
        </section>

        <section className={styles.capabilities}>
          <div className={styles.sectionHeading}>
            <div>
              <span className={styles.sectionTag}>FOUR HARD BOUNDARIES</span>
              <h2>Confidence is a system property.</h2>
            </div>
            <p>Not another wrapper around a model. Headless is the authority around the process: the layer that decides what may happen and preserves evidence of what did.</p>
          </div>
          <div className={styles.capabilityGrid}>
            {capabilities.map((capability) => <CapabilityCard key={capability.index} {...capability} />)}
          </div>
        </section>

        <section className={styles.flowSection}>
          <div className={styles.flowIntro}>
            <span className={styles.sectionTag}>ONE LEGIBLE PATH</span>
            <h2>From intent to evidence.</h2>
            <p>The golden path stays small even when the machinery behind it is serious.</p>
            <Link to="/getting-started/installation">Build the private beta from source <span aria-hidden="true">→</span></Link>
          </div>
          <ol className={styles.flow}>
            {flow.map(([number, title, copy]) => (
              <li key={number}>
                <span className={styles.flowNumber}>{number}</span>
                <div><strong>{title}</strong><span>{copy}</span></div>
              </li>
            ))}
          </ol>
        </section>

        <section className={styles.authoritySection}>
          <div className={styles.authorityVisual}>
            <div className={styles.authorityCore}>
              <span>HEADLESS</span>
              <strong>OWNER<br/>AUTHORITY</strong>
              <small>policy · credentials · ledger</small>
            </div>
            <div className={`${styles.orbitNode} ${styles.nodeOne}`}>claude</div>
            <div className={`${styles.orbitNode} ${styles.nodeTwo}`}>codex</div>
            <div className={`${styles.orbitNode} ${styles.nodeThree}`}>opencode</div>
            <div className={`${styles.orbitNode} ${styles.nodeFour}`}>grok</div>
            <div className={styles.orbit} aria-hidden="true" />
          </div>
          <div className={styles.authorityCopy}>
            <span className={styles.sectionTag}>ONE OWNER, MANY SERVANTS</span>
            <h2>Orchestrate across vendors.<br/>Keep authority in one place.</h2>
            <p>Your foreground coding CLI remains visible as the lead. Every delegated worker is contained, budgeted, attributable, and unable to promote itself into owner authority.</p>
            <ul>
              <li><span>01</span> Provider-neutral execution and native subscription logins</li>
              <li><span>02</span> Durable sessions, fleets, workflows, and approvals</li>
              <li><span>03</span> Leased write worktrees with explicit integration authority</li>
            </ul>
            <Link className={styles.textAction} to="/concepts/leads-and-fleet">Explore leads and fleets <span aria-hidden="true">↗</span></Link>
          </div>
        </section>

        <section className={styles.receiptSection}>
          <div className={styles.receiptCopy}>
            <span className={styles.sectionTag}>THE ARTIFACT THAT MATTERS</span>
            <h2>A log says something happened.<br/><em>A receipt lets you check.</em></h2>
            <p>Export the request digest, result digest, authorization snapshot, containment evidence, budget outcome, gates, and ledger anchor as one portable proof object.</p>
          </div>
          <div className={styles.receiptCard}>
            <div className={styles.receiptHeader}><span>EXECUTION RECEIPT</span><b>VERIFIED</b></div>
            <dl>
              <div><dt>RUN</dt><dd>hx_7f2a</dd></div>
              <div><dt>AUTHORITY</dt><dd>local:operator</dd></div>
              <div><dt>CONTAINMENT</dt><dd>required / enforced</dd></div>
              <div><dt>POLICY</dt><dd>read-only / admitted</dd></div>
              <div><dt>OUTPUT DIGEST</dt><dd>6fb8c1…91c2</dd></div>
              <div><dt>LEDGER ANCHOR</dt><dd>#184 / valid</dd></div>
            </dl>
            <div className={styles.receiptFooter}><span>HEADLESS / PROOF OF WORK</span><span>◈</span></div>
          </div>
        </section>

        <section className={styles.finalCta}>
          <div>
            <span className={styles.sectionTag}>PRIVATE BETA</span>
            <h2>Run the agent.<br/>Keep the evidence.</h2>
          </div>
          <div className={styles.finalCtaActions}>
            <p>Headless is source-only today. Start in a disposable project, follow the golden path, and inspect every boundary for yourself.</p>
            <Link className={styles.primaryAction} to="/getting-started/quickstart">Open the quickstart <span aria-hidden="true">↗</span></Link>
            <Link className={styles.repoLink} href="https://github.com/proofofwork-agency/headless">View the source on GitHub</Link>
          </div>
        </section>
      </main>
    </Layout>
  );
}
