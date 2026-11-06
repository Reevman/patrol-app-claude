import { useEffect, useState, type FormEvent } from 'react';

import { api, ApiError, type Session } from './patrolApi';

type Guard = { id: string; name: string; email?: string };
type Point = { id: string; name: string };
type Patrol = {
  id: string; guardId: string; guardName: string; startedAt: string; finishedAt: string;
  checkpoints: { name: string; scannedAt?: string }[]; reason?: string;
};
type ReportStatus = 'New' | 'Acknowledged' | 'Resolved';
type SiteReport = {
  id: string; guardName: string; category: string; location: string;
  description: string; createdAt: string; status: ReportStatus;
};
type Workspace = { patrols: Patrol[]; guards: Guard[]; points: Point[]; reports: SiteReport[]; interval: number };
const sections = ['Overview', 'Guards', 'Checkpoints', 'Patrols', 'Reports', 'Settings'] as const;
type Section = typeof sections[number];
const periods = [
  { key: '24h', label: 'Last 24 hours', ms: 24 * 3600000 },
  { key: '7d', label: 'Last 7 days', ms: 7 * 24 * 3600000 },
  { key: '30d', label: 'Last 30 days', ms: 30 * 24 * 3600000 },
  { key: 'all', label: 'All time', ms: Infinity },
] as const;
const statuses: ReportStatus[] = ['New', 'Acknowledged', 'Resolved'];

const site = 'Riverside Business Park';
const dateLabel = (value: string) => new Date(value).toLocaleString();
function lengthLabel(startedAt: string, finishedAt: string) {
  const minutes = Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 60000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function NameList({ label, items, busy, onAdd, onRemove }: {
  label: 'Guard' | 'Checkpoint'; items: { id: string; name: string; email?: string }[]; busy: boolean;
  onAdd: (name: string, email: string, password: string) => Promise<boolean>; onRemove: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const trimmed = name.trim();
  // Guards may share a name (they are told apart by email); checkpoints may not.
  const duplicate = label === 'Checkpoint' && items.some(item => item.name.toLowerCase() === trimmed.toLowerCase());

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trimmed || duplicate || busy) return;
    if (await onAdd(trimmed, email.trim(), password)) {
      setName('');
      setEmail('');
      setPassword('');
    }
  }

  return <>
    <form className="panel add-form" onSubmit={submit}>
      <label>{label} name<input value={name} onChange={event => setName(event.target.value)} maxLength={100} required /></label>
      {label === 'Guard' && <>
        <label>Email<input type="email" autoComplete="off" value={email} onChange={event => setEmail(event.target.value)} required /></label>
        <label>Initial password (12+ characters)<input type="password" autoComplete="new-password" minLength={12} maxLength={128}
          value={password} onChange={event => setPassword(event.target.value)} required /></label>
      </>}
      <button disabled={!trimmed || duplicate || busy}>Add {label.toLowerCase()}</button>
      {duplicate && <small role="status">That name is already on the list.</small>}
    </form>
    <div className="panel">
      {items.length === 0 && <p>No {label.toLowerCase()} entries yet.</p>}
      {items.map(item => <div className="list-row" key={item.id}>
        <div><strong>{item.name}</strong>{item.email && <small className="sub">{item.email}</small>}</div>
        {removing === item.id ? <div className="actions">
          <button className="danger" disabled={busy} onClick={() => { onRemove(item.id); setRemoving(null); }}>Confirm removal</button>
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
  const [statusFilter, setStatusFilter] = useState<'' | ReportStatus>('');
  const [period, setPeriod] = useState<typeof periods[number]['key']>('7d');
  const [interval, setIntervalInput] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function expire() {
    setSession(null);
    setData(null);
    setError('Your session expired. Sign in again.');
  }

  async function signIn(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const next = await api<Session>('sign-in', undefined, { email: email.trim(), password });
      if (next.user.role !== 'manager') {
        await api('sign-out', next.token, {}).catch(() => undefined);
        throw new Error('Use a manager account to open this dashboard.');
      }
      const workspace = await api<Workspace>('workspace', next.token);
      setData(workspace);
      setIntervalInput(String(workspace.interval));
      setSession(next);
      setSection('Overview');
      setGuardFilter('');
      setStatusFilter('');
      setNotice('');
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
      if (failure instanceof ApiError && failure.status === 401) expire();
      else setError((failure as Error).message);
    }
  }

  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && !busy) void refresh();
    }, 15000);
    return () => clearInterval(timer);
  }, [session, busy]);

  async function save(path: string, input: object, success: string) {
    if (!session || busy) return false;
    setBusy(true);
    setError('');
    try {
      setData(await api<Workspace>(path, session.token, input));
      setNotice(success);
      return true;
    } catch (failure) {
      setNotice('');
      if (failure instanceof ApiError && failure.status === 401) expire();
      else setError((failure as Error).message);
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

  if (!session || !data) return <div className="manager signin">
    <style>{dashboardStyles}</style>
    <main>
      <small>{site}</small>
      <h1>Manager sign-in</h1>
      <form className="panel" onSubmit={signIn}>
        <label>Email<input type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} /></label>
        <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} /></label>
        <p><button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button></p>
        {error && <p role="alert" className="error">{error}</p>}
      </form>
    </main>
  </div>;

  const patrols = data.patrols;
  const openReports = data.reports.filter(report => report.status !== 'Resolved').length;
  const activeIds = new Set(data.guards.map(guard => guard.id));
  const patrolGuards = [...new Map(patrols.map(patrol => [patrol.guardId, patrol.guardName])).entries()];
  const guardOptions = [...new Map([...data.guards.map(guard => [guard.id, guard.name] as const), ...patrolGuards])];
  const selectedPeriod = periods.find(item => item.key === period) ?? periods[1];
  const cutoff = Date.now() - selectedPeriod.ms;
  const shownPatrols = patrols.filter(patrol => !guardFilter || patrol.guardId === guardFilter);
  const shownReports = data.reports.filter(report => !statusFilter || report.status === statusFilter);

  function showPatrols(guardId: string) {
    setGuardFilter(guardId);
    setNotice('');
    setSection('Patrols');
  }

  return <div className="manager">
    <style>{dashboardStyles}</style>
    <aside>
      <strong className="brand">Patrol Manager</strong>
      <small>DESKTOP WORKSPACE</small>
      <nav aria-label="Manager sections">
        {sections.map(page => <button key={page} aria-current={section === page ? 'page' : undefined}
          onClick={() => { setNotice(''); setSection(page); }}>
          {page}{page === 'Reports' && openReports > 0 && <span className="count">{openReports}</span>}
        </button>)}
      </nav>
      <a href="./">Open guard app</a>
    </aside>
    <main>
      <header>
        <div><small>{site}</small><h1>{section}</h1></div>
        <div className="actions"><span>{session.user.name}</span><button onClick={signOut} disabled={busy}>Sign out</button></div>
      </header>
      {error && <p role="alert" className="error banner">{error}</p>}
      {notice && !error && <p role="status" className="notice banner">{notice}</p>}

      {section === 'Overview' && <>
        <div className="metrics">
          <button onClick={() => setSection('Guards')}><b>{data.guards.length}</b> Active guards</button>
          <button onClick={() => setSection('Checkpoints')}><b>{data.points.length}</b> Checkpoints</button>
          <button onClick={() => { setStatusFilter(''); setSection('Reports'); }}><b>{openReports}</b> Open reports</button>
        </div>
        <div className="panel">
          <div className="panel-head">
            <h2>Guard activity</h2>
            <label className="inline">Period
              <select value={period} onChange={event => setPeriod(event.target.value as typeof period)}>
                {periods.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
              </select>
            </label>
          </div>
          <table><thead><tr><th>Guard</th><th>Full patrols ({selectedPeriod.label.toLowerCase()})</th><th>Last full patrol</th><th>History</th></tr></thead>
            <tbody>{data.guards.map(guard => {
              const full = patrols.filter(patrol => patrol.guardId === guard.id && !patrol.reason);
              const inPeriod = full.filter(patrol => Date.parse(patrol.finishedAt) >= cutoff).length;
              return <tr key={guard.id}><td>{guard.name}</td><td>{inPeriod}</td>
                <td>{full[0] ? dateLabel(full[0].finishedAt) : 'None recorded'}</td>
                <td><button className="quiet" onClick={() => showPatrols(guard.id)}>View patrols</button></td></tr>;
            })}</tbody>
          </table>
          {!data.guards.length && <p>No active guards. Add guards in the Guards section.</p>}
        </div>
      </>}

      {(section === 'Guards' || section === 'Checkpoints') && (() => {
        const key = section === 'Guards' ? 'guards' : 'points';
        const label = section === 'Guards' ? 'Guard' : 'Checkpoint';
        return <NameList key={key} label={label} items={data[key]} busy={busy}
          onAdd={(name, guardEmail, guardPassword) => save(key + '/add',
            key === 'guards' ? { name, email: guardEmail, password: guardPassword } : { name }, `${label} added.`)}
          onRemove={id => void save(key + '/remove', { id }, `${label} removed. Past patrols keep their details.`)} />;
      })()}

      {section === 'Patrols' && <>
        <label className="panel">Filter by guard
          <select value={guardFilter} onChange={event => setGuardFilter(event.target.value)}>
            <option value="">All guards</option>
            {guardOptions.map(([id, name]) =>
              <option key={id} value={id}>{name}{activeIds.has(id) ? '' : ' (removed)'}</option>)}
          </select>
        </label>
        {shownPatrols.length === 0 && <p>{guardFilter ? 'No patrols recorded for this guard.' : 'No patrols recorded yet.'}</p>}
        {shownPatrols.map(patrol => {
          const done = patrol.checkpoints.filter(point => point.scannedAt).length;
          return <details className="panel" key={patrol.id}>
            <summary>
              <strong>{patrol.guardName}</strong>
              <span className={`badge ${patrol.reason ? 'new' : 'resolved'}`}>{patrol.reason ? 'Incomplete' : 'Complete'}</span>
              {done}/{patrol.checkpoints.length} checkpoints · {dateLabel(patrol.finishedAt)}
            </summary>
            <p><small>Started {dateLabel(patrol.startedAt)} · Finished {dateLabel(patrol.finishedAt)} · Duration {lengthLabel(patrol.startedAt, patrol.finishedAt)}</small></p>
            <ul>{patrol.checkpoints.map((point, index) =>
              <li key={`${point.name}-${index}`}>{point.name} · {point.scannedAt ? dateLabel(point.scannedAt) : <b className="missed">Missed</b>}</li>)}</ul>
            {patrol.reason && <p><strong>Reason:</strong> {patrol.reason}</p>}
          </details>;
        })}
      </>}

      {section === 'Reports' && <>
        <label className="panel">Show
          <select value={statusFilter} onChange={event => setStatusFilter(event.target.value as '' | ReportStatus)}>
            <option value="">All reports</option>
            {statuses.map(status => <option key={status} value={status}>{status}</option>)}
          </select>
        </label>
        {shownReports.length === 0 && <p>{data.reports.length ? 'No reports match this filter.' : 'No reports yet.'}</p>}
        {shownReports.map(report => <article className="panel" key={report.id}>
          <div className="panel-head">
            <h2>{report.category}</h2>
            <span className={`badge ${report.status.toLowerCase()}`}>{report.status}</span>
          </div>
          <small>{report.guardName} · {report.location || 'No location given'} · {dateLabel(report.createdAt)}</small>
          <p>{report.description}</p>
          <label>Status
            <select value={report.status} disabled={busy} onChange={event => {
              const status = event.target.value as ReportStatus;
              void save('reports/status', { id: report.id, status }, 'Report status updated.');
            }}>
              {statuses.map(status => <option key={status}>{status}</option>)}
            </select>
          </label>
        </article>)}
      </>}

      {section === 'Settings' && <form className="panel add-form" onSubmit={async event => {
        event.preventDefault();
        const minutes = Number(interval);
        if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1440) return;
        await save('settings', { interval: minutes }, 'Patrol interval saved.');
      }}>
        <label>Patrol interval (minutes)
          <input type="number" min={1} max={1440} step={1} required value={interval} onChange={event => {
            setIntervalInput(event.target.value);
            setNotice('');
          }} />
        </label>
        <button disabled={busy || interval === String(data.interval)}>Save interval</button>
        <small>Currently {data.interval} minutes. Guard apps pick up the new interval within a minute of opening or refreshing.</small>
      </form>}
    </main>
  </div>;
}

const dashboardStyles = `
  body { margin: 0; }
  .manager { min-height: 100vh; display: grid; grid-template-columns: 215px minmax(0, 1fr); color: #142c28; background: #f0f5f3; font: 15px system-ui, sans-serif; }
  .manager.signin { grid-template-columns: 1fr; }
  .manager.signin main { max-width: 420px; padding-top: 12vh; }
  .manager * { box-sizing: border-box; }
  .manager aside { background: #113a32; color: #fff; padding: 28px 18px; }
  .manager aside small { display: block; margin-top: 5px; color: #c0ddd4; letter-spacing: .07em; }
  .manager aside a { display: inline-block; margin-top: 20px; color: #fff; }
  .manager .brand { font-size: 21px; }
  .manager nav { display: grid; gap: 5px; margin-top: 26px; }
  .manager nav button { background: transparent; text-align: left; display: flex; justify-content: space-between; align-items: center; }
  .manager nav button:hover, .manager nav button[aria-current] { background: #26564c; }
  .manager .count { background: #f2b84b; color: #3a2600; border-radius: 20px; padding: 1px 8px; font-size: 12px; font-weight: 700; }
  .manager main { width: 100%; max-width: 1120px; margin: auto; align-self: start; margin-top: 0; padding: 32px; }
  .manager header, .manager .list-row, .manager .actions, .manager .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .manager header { margin-bottom: 24px; }
  .manager h1 { margin: 3px 0 0; font-size: 36px; }
  .manager h2 { margin: 0 0 10px; font-size: 20px; }
  .manager .panel-head h2 { margin: 0; }
  .manager .panel { display: block; overflow: auto; padding: 18px; background: #fff; border: 1px solid #d8e4df; border-radius: 12px; margin: 0 0 14px; }
  .manager .panel-head { margin-bottom: 10px; }
  .manager .inline { display: flex; align-items: center; gap: 8px; }
  .manager .inline select { margin-top: 0; }
  .manager .sub { display: block; color: #5b726d; margin-top: 2px; }
  .manager .banner { padding: 10px 14px; border-radius: 10px; margin: 0 0 14px; }
  .manager .error { color: #8e3131; }
  .manager .banner.error { background: #f7dcdc; }
  .manager .notice { background: #dcf2e4; color: #17603a; }
  .manager .badge { display: inline-block; border-radius: 20px; padding: 3px 10px; font-size: 12px; font-weight: 700; margin: 0 10px; background: #e1ede9; }
  .manager .badge.new { background: #fce9c8; color: #7a4300; }
  .manager .badge.acknowledged { background: #dbe9f7; color: #1d4a7a; }
  .manager .badge.resolved { background: #dcf2e4; color: #17603a; }
  .manager .missed { color: #8e3131; }
  .manager .metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 16px; }
  .manager .metrics button { background: #fff; color: #145347; border: 1px solid #d8e4df; text-align: left; }
  .manager .metrics b { display: block; font-size: 26px; }
  .manager button, .manager input, .manager select { font: inherit; border-radius: 8px; padding: 9px 12px; }
  .manager button { color: white; background: #145347; border: 1px solid transparent; cursor: pointer; }
  .manager button:disabled { opacity: .5; cursor: default; }
  .manager button.quiet { color: #145347; background: #e1ede9; }
  .manager button.danger { background: #8e3131; }
  .manager button:focus-visible, .manager input:focus-visible, .manager select:focus-visible, .manager summary:focus-visible, .manager a:focus-visible { outline: 3px solid #f2b84b; outline-offset: 2px; }
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
    .manager .metrics { grid-template-columns: 1fr; }
  }
`;
