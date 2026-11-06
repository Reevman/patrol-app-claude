import { useEffect, useState, type FormEvent } from 'react';

import { api, ApiError, type Session } from './patrolApi';

type Guard = { id: string; name: string };
type Point = { id: string; name: string };
type Patrol = {
  id: string; guardId: string; guardName: string; finishedAt: string;
  checkpoints: { name: string; scannedAt?: string }[]; reason?: string;
};
type SiteReport = {
  id: string; guardName: string; category: string; location: string;
  description: string; createdAt: string; status: 'New' | 'Acknowledged' | 'Resolved';
};
type Workspace = { patrols: Patrol[]; guards: Guard[]; points: Point[]; reports: SiteReport[]; interval: number };
const sections = ['Overview', 'Guards', 'Checkpoints', 'Patrols', 'Reports', 'Settings'] as const;
type Section = typeof sections[number];

const site = 'Riverside Business Park';
const dateLabel = (value: string) => new Date(value).toLocaleString();

function NameList({ label, items, onAdd, onRemove }: {
  label: string; items: { id: string; name: string }[];
  onAdd: (name: string, email: string, password: string) => Promise<void>; onRemove: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const trimmed = name.trim();
  const duplicate = items.some(item => item.name.toLowerCase() === trimmed.toLowerCase());

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trimmed || duplicate) return;
    await onAdd(trimmed, email, password);
    setName('');
    setEmail('');
    setPassword('');
  }

  return <>
    <form className="panel add-form" onSubmit={submit}>
      <label>{label} name<input value={name} onChange={event => setName(event.target.value)} maxLength={100} required /></label>
      {label === 'Guard' && <>
        <label>Email<input type="email" value={email} onChange={event => setEmail(event.target.value)} required /></label>
        <label>Initial password<input type="password" autoComplete="new-password" minLength={12} maxLength={128}
          value={password} onChange={event => setPassword(event.target.value)} required /></label>
      </>}
      <button disabled={!trimmed || duplicate}>Add {label.toLowerCase()}</button>
      {duplicate && <small role="status">That name is already on the list.</small>}
    </form>
    <div className="panel">
      {items.length === 0 && <p>No {label.toLowerCase()} entries yet.</p>}
      {items.map(item => <div className="list-row" key={item.id}>
        <strong>{item.name}</strong>
        {removing === item.id ? <div className="actions">
          <button className="danger" onClick={() => { onRemove(item.id); setRemoving(null); }}>Confirm removal</button>
          <button className="quiet" onClick={() => setRemoving(null)}>Cancel</button>
        </div> : <button className="quiet" aria-label={`Remove ${item.name}`} onClick={() => setRemoving(item.id)}>Remove</button>}
      </div>)}
    </div>
  </>;
}

export default function ManagerDashboard() {
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [data, setData] = useState<Workspace | null>(null);
  const [section, setSection] = useState<Section>('Overview');
  const [guardFilter, setGuardFilter] = useState('');
  const [interval, setIntervalInput] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function signIn(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const next = await api<Session>('sign-in', undefined, { email, password });
      if (next.user.role !== 'manager') {
        await api('sign-out', next.token, {});
        throw new Error('Use a manager account to open this dashboard.');
      }
      const workspace = await api<Workspace>('workspace', next.token);
      setData(workspace);
      setIntervalInput(String(workspace.interval));
      setSession(next);
      setSection('Overview');
      setGuardFilter('');
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setPassword('');
      setBusy(false);
    }
  }

  async function refresh() {
    if (!session) return;
    try {
      setData(await api<Workspace>('workspace', session.token));
      setError('');
    } catch (failure) {
      setError((failure as Error).message);
      if (failure instanceof ApiError && failure.status === 401) setSession(null);
    }
  }

  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && !busy) void refresh();
    }, 15000);
    return () => clearInterval(timer);
  }, [session, busy]);

  async function save(path: string, input: object) {
    if (!session || busy) return false;
    setBusy(true);
    setError('');
    try {
      setData(await api<Workspace>(path, session.token, input));
      return true;
    } catch (failure) {
      setError((failure as Error).message);
      if (failure instanceof ApiError && failure.status === 401) setSession(null);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    if (!session || busy) return;
    setBusy(true);
    try {
      await api('sign-out', session.token, {});
      setSession(null);
      setData(null);
      setError('');
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) {
        setSession(null);
        setData(null);
      } else setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!session || !data) return <div className="manager">
    <style>{dashboardStyles}</style>
    <main>
      <h1>Manager sign-in</h1>
      <form className="panel" onSubmit={signIn}>
        <label>Email<input type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} /></label>
        <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} /></label>
        <p><button disabled={busy}>Sign in</button></p>
        {error && <p role="alert">{error}</p>}
      </form>
    </main>
  </div>;

  const patrols = data.patrols;
  const patrolGuards = [...new Map(patrols.map(patrol => [patrol.guardId, patrol.guardName])).entries()];

  function showPatrols(guardId: string) {
    setGuardFilter(guardId);
    setSection('Patrols');
  }

  return <div className="manager">
    <style>{dashboardStyles}</style>
    <aside>
      <strong className="brand">Patrol Manager</strong>
      <small>DESKTOP WORKSPACE</small>
      <nav aria-label="Manager sections">
        {sections.map(page => <button key={page} aria-current={section === page ? 'page' : undefined}
          onClick={() => { setNotice(''); setSection(page); }}>{page}</button>)}
      </nav>
      <a href="./">Open guard app</a>
    </aside>
    <main>
      <header>
        <div><small>{site}</small><h1>{section}</h1></div>
        <div className="actions"><span>{session.user.name}</span><button onClick={signOut} disabled={busy}>Sign out</button></div>
      </header>
      {error && <p role="alert">{error}</p>}

      {section === 'Overview' && <>
        <div className="metrics">
          <button onClick={() => setSection('Guards')}><b>{data.guards.length}</b> Active guards</button>
          <button onClick={() => setSection('Checkpoints')}><b>{data.points.length}</b> Checkpoints</button>
          <button onClick={() => setSection('Reports')}><b>{data.reports.filter(report => report.status !== 'Resolved').length}</b> Open reports</button>
        </div>
        <div className="panel">
          <h2>Guard activity</h2>
          <table><thead><tr><th>Guard</th><th>Full patrols</th><th>Last full patrol</th><th>History</th></tr></thead>
            <tbody>{data.guards.map(guard => {
              const full = patrols.filter(patrol => patrol.guardId === guard.id && !patrol.reason);
              return <tr key={guard.id}><td>{guard.name}</td><td>{full.length}</td>
                <td>{full[0] ? dateLabel(full[0].finishedAt) : 'None recorded'}</td>
                <td><button className="quiet" onClick={() => showPatrols(guard.id)}>View patrols</button></td></tr>;
            })}</tbody>
          </table>
          {!data.guards.length && <p>No active guards.</p>}
        </div>
      </>}

      {(section === 'Guards' || section === 'Checkpoints') && (() => {
        const key = section === 'Guards' ? 'guards' : 'points';
        return <NameList key={key} label={key === 'guards' ? 'Guard' : 'Checkpoint'} items={data[key]}
          onAdd={async (name, email, password) => { await save(key + "/add", { name, email, password }); }}
          onRemove={id => void save(key + "/remove", { id })} />;
      })()}

      {section === 'Patrols' && <>
        <label className="panel">Filter by guard
          <select value={guardFilter} onChange={event => setGuardFilter(event.target.value)}>
            <option value="">All guards</option>
            {[...new Map([...data.guards.map(guard => [guard.id, guard.name] as const), ...patrolGuards])].map(([id, name]) =>
              <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        {!patrols.some(patrol => !guardFilter || patrol.guardId === guardFilter) && <p>No patrols recorded for this guard.</p>}
        {patrols.filter(patrol => !guardFilter || patrol.guardId === guardFilter).map(patrol =>
          <details className="panel" key={patrol.id}>
            <summary><strong>{patrol.guardName}</strong> · {patrol.reason ? 'Incomplete' : 'Complete'} · {dateLabel(patrol.finishedAt)}</summary>
            <ul>{patrol.checkpoints.map(point =>
              <li key={point.name}>{point.name} · {point.scannedAt ? dateLabel(point.scannedAt) : 'Missed'}</li>)}</ul>
            {patrol.reason && <p><strong>Reason:</strong> {patrol.reason}</p>}
          </details>)}
      </>}

      {section === 'Reports' && <>
        {data.reports.length === 0 && <p>No reports yet.</p>}
        {data.reports.map(report => <article className="panel" key={report.id}>
          <h2>{report.category}</h2>
          <small>{report.guardName} · {report.location} · {dateLabel(report.createdAt)}</small>
          <p>{report.description}</p>
          <label>Status
            <select value={report.status} onChange={event => {
              const status = event.target.value as SiteReport['status'];
              void save("reports/status", { id: report.id, status });
            }}>
              <option>New</option><option>Acknowledged</option><option>Resolved</option>
            </select>
          </label>
        </article>)}
      </>}

      {section === 'Settings' && <form className="panel add-form" onSubmit={async event => {
        event.preventDefault();
        const minutes = Number(interval);
        if (!Number.isSafeInteger(minutes) || minutes < 1) return;
        setNotice(await save('settings', { interval: minutes }) ? 'Patrol interval saved.' : '');
      }}>
        <label>Patrol interval (minutes)
          <input type="number" min={1} max={1440} step={1} required value={interval} onChange={event => {
            setIntervalInput(event.target.value);
            setNotice('');
          }} />
        </label>
        <button>Save interval</button>
        <small>Guard apps pick up this interval when they load site settings.</small>
        {notice && <span role="status">{notice}</span>}
      </form>}
    </main>
  </div>;
}

const dashboardStyles = `
  body { margin: 0; }
  .manager { min-height: 100vh; display: grid; grid-template-columns: 215px minmax(0, 1fr); color: #142c28; background: #f0f5f3; font: 15px system-ui, sans-serif; }
  .manager * { box-sizing: border-box; }
  .manager aside { background: #113a32; color: #fff; padding: 28px 18px; }
  .manager aside small { display: block; margin-top: 5px; color: #c0ddd4; letter-spacing: .07em; }
  .manager aside a { display: inline-block; margin-top: 20px; color: #fff; }
  .manager .brand { font-size: 21px; }
  .manager nav { display: grid; gap: 5px; margin-top: 26px; }
  .manager nav button { background: transparent; text-align: left; }
  .manager nav button:hover, .manager nav button[aria-current] { background: #26564c; }
  .manager main { width: 100%; max-width: 1120px; margin: auto; align-self: start; margin-top: 0; padding: 32px; }
  .manager header, .manager .list-row, .manager .actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .manager header { margin-bottom: 24px; }
  .manager h1 { margin: 3px 0 0; font-size: 36px; }
  .manager h2 { margin: 0 0 10px; font-size: 20px; }
  .manager .panel { display: block; overflow: auto; padding: 18px; background: #fff; border: 1px solid #d8e4df; border-radius: 12px; margin: 0 0 14px; }
  .manager .badge { background: #e1ede9; padding: 6px 10px; border-radius: 20px; }
  .manager .metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 16px; }
  .manager .metrics button { background: #fff; color: #145347; border: 1px solid #d8e4df; text-align: left; }
  .manager .metrics b { display: block; font-size: 26px; }
  .manager button, .manager input, .manager select { font: inherit; border-radius: 8px; padding: 9px 12px; }
  .manager button { color: white; background: #145347; border: 1px solid transparent; cursor: pointer; }
  .manager button:disabled { opacity: .5; cursor: default; }
  .manager button.quiet { color: #145347; background: #e1ede9; }
  .manager button.danger { background: #8e3131; }
  .manager input, .manager select { border: 1px solid #a9bdb5; background: #fff; color: inherit; display: block; margin-top: 5px; max-width: 100%; }
  .manager .add-form { display: flex; align-items: end; gap: 12px; flex-wrap: wrap; }
  .manager .list-row, .manager td, .manager th { padding: 10px; border-bottom: 1px solid #e1ede9; }
  .manager table { border-collapse: collapse; width: 100%; text-align: left; }
  .manager summary { cursor: pointer; }
  .manager li { margin: 8px 0; }
  @media (max-width: 660px) {
    .manager { grid-template-columns: 1fr; }
    .manager nav { display: flex; flex-wrap: wrap; margin-top: 12px; }
    .manager main { padding: 16px; }
  }
`;
