import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { StatusBar } from 'expo-status-bar';
import { AppState, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import {
  disablePatrolReminder, getPatrolReminder, schedulePatrolReminder, supportsPatrolNotifications,
} from './patrolReminders';
import { api, ApiError, type Session } from './patrolApi';

const site = 'Riverside Business Park';
const tabs = ['Patrol', 'History', 'Reports', 'Account'] as const;
const categories = ['Safety hazard', 'Damaged equipment', 'Access issue', 'Other'] as const;
const icons: Record<Tab, string> = { Patrol: '◎', History: '◷', Reports: '▤', Account: '♙' };

type Tab = typeof tabs[number];
type Category = typeof categories[number];
type ReportDraft = { category: Category; location: string; description: string };
type Report = ReportDraft & { id: string; createdAt: string; status: string };
type PatrolRecord = {
  id: string; startedAt: string; finishedAt: string; reason: string;
  checkpoints: { name: string; scannedAt?: string }[];
};
type Workspace = {
  points: { id: string; name: string }[];
  interval: number;
  reports: Report[];
  patrols: PatrolRecord[];
};
type ActivePatrol = { startedAt: string; checked: Partial<Record<string, string>>; points: Workspace['points'] };

const emptyReport: ReportDraft = { category: 'Safety hazard', location: '', description: '' };

const dateLabel = (value: string) => new Date(value).toLocaleString();
const timeLabel = (value: string) =>
  new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const duration = (minutes: number) => minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
const reportTone = (status: string) => status === 'Resolved' ? 'ok' : status === 'Acknowledged' ? 'info' : 'warn';

function Button({ label, onPress, tone = 'primary', disabled = false }: {
  label: string; onPress: () => void; tone?: 'primary' | 'secondary' | 'danger'; disabled?: boolean;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.button, tone === 'secondary' && styles.secondary,
        tone === 'danger' && styles.dangerButton, pressed && styles.pressed, disabled && styles.disabled]}>
      <Text style={tone === 'secondary' ? styles.secondaryText : styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

function Pill({ label, tone }: { label: string; tone: 'ok' | 'warn' | 'info' | 'bad' }) {
  return (
    <View style={[styles.pill, pillTones[tone].box]}>
      <Text style={[styles.pillText, pillTones[tone].text]}>{label}</Text>
    </View>
  );
}

function ProgressBar({ done, total }: { done: number; total: number }) {
  const percent = total ? Math.round((done / total) * 100) : 0;
  return (
    <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: total, now: done }} style={styles.track}>
      <View style={[styles.fill, { width: `${percent}%` }]} />
    </View>
  );
}

function CheckpointRow({ name, scannedAt, onPress, review = false }: {
  name: string; scannedAt?: string; onPress?: () => void; review?: boolean;
}) {
  const body = (
    <>
      <View style={[styles.dot, scannedAt ? styles.dotDone : review && styles.dotMissed]}>
        <Text style={[styles.dotText, scannedAt || review ? styles.dotTextOn : null]}>{scannedAt ? '✓' : review ? '!' : ''}</Text>
      </View>
      <View style={styles.rowText}>
        <Text style={styles.name}>{name}</Text>
        {scannedAt ? <Text style={styles.small}>Checked {timeLabel(scannedAt)}</Text>
          : review ? <Text style={[styles.small, styles.errorText]}>Missed</Text>
          : <Text style={styles.small}>Tap to mark (demo)</Text>}
      </View>
    </>
  );
  if (!onPress) return <View style={styles.row}>{body}</View>;
  return (
    <Pressable accessibilityRole="button"
      accessibilityLabel={scannedAt ? `${name}, checked at ${timeLabel(scannedAt)}` : `Mark ${name} as checked (demo)`}
      onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      {body}
    </Pressable>
  );
}

function PatrolTimer({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  const clock = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(part => String(part).padStart(2, '0'))
    .join(':');

  return (
    <View>
      <Text style={styles.body}>Elapsed time</Text>
      <Text accessibilityLabel={`Elapsed time ${clock}`} style={styles.timer}>{clock}</Text>
    </View>
  );
}

function PatrolStatus({ lastCompleted, intervalMinutes }: { lastCompleted?: string; intervalMinutes: number }) {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);

  const elapsed = lastCompleted ? Math.max(0, now - Date.parse(lastCompleted)) : null;
  const minutes = elapsed === null ? 0 : Math.floor(elapsed / 60000);
  const remaining = elapsed === null ? 0 : Math.ceil((intervalMinutes * 60000 - elapsed) / 60000);
  const due = remaining <= 0;
  const age = minutes === 0 ? 'Just now' : `${duration(minutes)} ago`;

  return (
    <Card>
      <View style={styles.spread}>
        <Text style={styles.name}>{due ? 'Patrol due' : `Next patrol due in ${duration(remaining)}`}</Text>
        <Pill label={due ? 'Due' : 'On track'} tone={due ? 'warn' : 'ok'} />
      </View>
      <Text style={styles.body}>{lastCompleted ? `Last full patrol · ${age}` : 'No full patrol recorded yet.'}</Text>
      {lastCompleted && <Text style={styles.small}>{dateLabel(lastCompleted)}</Text>}
    </Card>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [initial, setInitial] = useState<Workspace | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const passwordRef = useRef<TextInput>(null);

  const handleSignOut = useCallback((message = '') => {
    setSession(null);
    setInitial(null);
    setError(message);
  }, []);

  async function signIn() {
    if (busy || !email.trim() || !password) return;
    setBusy(true);
    setError('');
    try {
      const next = await api<Session>('sign-in', undefined, { email: email.trim(), password });
      if (next.user.role !== 'guard') {
        await api('sign-out', next.token, {}).catch(() => undefined);
        throw new Error('Use a guard account to open the guard app.');
      }
      setInitial(await api<Workspace>('workspace', next.token));
      setSession(next);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
      setPassword('');
    }
  }

  if (session && initial) return <GuardApp session={session} initial={initial} onSignOut={handleSignOut} />;

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.screen}>
        <StatusBar style="dark" />
        <ScrollView contentContainerStyle={[styles.content, styles.centered]} keyboardShouldPersistTaps="handled">
          <View style={styles.logo} accessible={false}><Text style={styles.logoText}>◎</Text></View>
          <Text style={styles.eyebrow}>GUARD APP</Text>
          <Text accessibilityRole="header" style={styles.title}>Sign in</Text>
          <Text style={styles.body}>{site}</Text>
          <Card>
            <Text style={styles.name}>Email</Text>
            <TextInput accessibilityLabel="Email" keyboardType="email-address" autoCapitalize="none" autoCorrect={false}
              autoComplete="email" textContentType="username" returnKeyType="next" value={email}
              onChangeText={setEmail} onSubmitEditing={() => passwordRef.current?.focus()} style={styles.input} />
            <Text style={styles.name}>Password</Text>
            <TextInput ref={passwordRef} accessibilityLabel="Password" secureTextEntry autoComplete="current-password"
              textContentType="password" returnKeyType="go" value={password} onChangeText={setPassword}
              onSubmitEditing={() => void signIn()} style={styles.input} />
            {error ? <Text accessibilityRole="alert" style={styles.errorText}>{error}</Text> : null}
            <Button label={busy ? 'Signing in…' : 'Sign in'} disabled={busy || !email.trim() || !password}
              onPress={() => void signIn()} />
          </Card>
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function GuardApp({ session, initial, onSignOut }: {
  session: Session; initial: Workspace; onSignOut: (message?: string) => void;
}) {
  const [tab, setTab] = useState<Tab | 'Home'>('Home');
  const [patrol, setPatrol] = useState<ActivePatrol | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reason, setReason] = useState('');
  const [workspace, setWorkspace] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedPatrolId, setSelectedPatrolId] = useState<string | null>(null);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [draft, setDraft] = useState<(ReportDraft & { submissionId: string }) | null>(null);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [remindersOn, setRemindersOn] = useState(false);
  const [reminderBusy, setReminderBusy] = useState(false);
  const [reminderMessage, setReminderMessage] = useState('');

  const history = workspace.patrols;
  const reports = workspace.reports;
  const patrolIntervalMinutes = workspace.interval;
  const checkpoints = (patrol?.points ?? workspace.points).map(point => point.name);
  const missing = checkpoints.filter(name => !patrol || !Object.hasOwn(patrol.checked, name));
  const lastCompleted = history.find(entry => !entry.reason)?.finishedAt;
  const selectedPatrol = history.find(entry => entry.id === selectedPatrolId) ?? null;
  const selectedReport = reports.find(report => report.id === selectedReportId) ?? null;

  const refresh = useCallback(async () => {
    try {
      setWorkspace(await api<Workspace>('workspace', session.token));
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onSignOut('Your session expired. Sign in again.');
    }
  }, [session.token, onSignOut]);

  // Pick up checkpoint, interval and report-status changes made by managers.
  useEffect(() => { void refresh(); }, [tab, refresh]);
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 60000);
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') void refresh(); });
    return () => { clearInterval(timer); subscription.remove(); };
  }, [refresh]);

  // Reconcile an existing notification schedule when the manager changes the interval.
  useEffect(() => {
    if (!supportsPatrolNotifications) return;
    let cancelled = false;
    (async () => {
      const { enabled, minutes } = await getPatrolReminder();
      if (cancelled) return;
      setRemindersOn(enabled);
      if (enabled && minutes !== null && minutes !== workspace.interval) {
        await schedulePatrolReminder(false, workspace.interval);
      }
    })().catch(() => { if (!cancelled) setReminderMessage('Could not check notification settings.'); });
    return () => { cancelled = true; };
  }, [workspace.interval]);

  async function updateReminder(turnOn: boolean, requestPermission = false, minutes = patrolIntervalMinutes) {
    setReminderBusy(true);
    setReminderMessage('');
    try {
      if (turnOn) {
        const enabled = await schedulePatrolReminder(requestPermission, minutes);
        setRemindersOn(enabled);
        if (!enabled) setReminderMessage('Notifications are off for Patrol. Allow them in your device settings, then try again.');
      } else {
        await disablePatrolReminder();
        setRemindersOn(false);
      }
    } catch {
      setReminderMessage('Could not update patrol reminders. Try again.');
      setRemindersOn((await getPatrolReminder().catch(() => ({ enabled: false }))).enabled);
    } finally {
      setReminderBusy(false);
    }
  }

  async function send(path: string, input?: object) {
    if (busy) return null;
    setBusy(true);
    setError('');
    try {
      const next = await api<Workspace>(path, session.token, input);
      setWorkspace(next);
      return next;
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) {
        onSignOut('Your session expired. Sign in again.');
        return null;
      }
      setError((failure as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  function mark(name: string) {
    if (!patrol) return;
    const existing = patrol.checked[name];
    if (existing) {
      setFeedback(`${name} was already checked at ${timeLabel(existing)}. The first time is kept.`);
      return;
    }
    const timestamp = new Date().toISOString();
    setPatrol(current => current && !Object.hasOwn(current.checked, name)
      ? { ...current, checked: { ...current.checked, [name]: timestamp } } : current);
    setFeedback(`${name} checked at ${timeLabel(timestamp)} (demo mark).`);
  }

  function resetPatrol() {
    setPatrol(null);
    setReviewing(false);
    setReason('');
    setFeedback('');
    setError('');
  }

  async function finish() {
    if (!patrol || (missing.length > 0 && !reason.trim())) return;
    const next = await send('patrols', {
      startedAt: patrol.startedAt,
      finishedAt: new Date().toISOString(),
      reason: reason.trim(),
      points: patrol.points.map(point => point.id),
      checked: Object.fromEntries(patrol.points
        .filter(point => Object.hasOwn(patrol.checked, point.name))
        .map(point => [point.id, patrol.checked[point.name]])),
    });
    if (!next) return;
    if (!missing.length && remindersOn) void updateReminder(true, false, next.interval);
    resetPatrol();
    setSelectedPatrolId(null);
    setTab('History');
  }

  async function saveReport() {
    if (!draft?.description.trim()) return;
    if (await send('reports', { ...draft, description: draft.description.trim(), location: draft.location.trim() })) {
      setDraft(null);
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      if (supportsPatrolNotifications) await disablePatrolReminder();
      await api('sign-out', session.token, {});
      onSignOut();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onSignOut();
      else setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function goTo(next: Tab | 'Home') {
    setError('');
    setFeedback('');
    setTab(next);
  }

  const title = tab === 'Home' ? `Hello, ${session.user.name.split(' ')[0]}`
    : tab === 'Patrol' && reviewing ? 'Review patrol'
    : tab === 'History' && selectedPatrol ? 'Patrol details'
    : tab === 'Reports' && draft ? 'New report'
    : tab === 'Reports' && selectedReport ? 'Report details'
    : tab;

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.screen}>
        <StatusBar style="dark" />
        <ScrollView key={title} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => {
            setRefreshing(true);
            await refresh();
            setRefreshing(false);
          }} />}>
          <Text style={styles.eyebrow}>{site.toUpperCase()}</Text>
          {tab !== 'Home' && <Button label="‹ Home" tone="secondary" onPress={() => goTo('Home')} />}
          <Text accessibilityRole="header" style={styles.title}>{title}</Text>

          {error ? <Text accessibilityRole="alert" style={styles.errorBanner}>{error}</Text> : null}
          {(tab === 'Home' || (tab === 'Patrol' && !patrol)) && (
            <PatrolStatus lastCompleted={lastCompleted} intervalMinutes={patrolIntervalMinutes} />
          )}

          {tab === 'Home' && (
            <View style={styles.grid}>
              {tabs.map(page => (
                <Pressable key={page} accessibilityRole="button" accessibilityLabel={page === 'Patrol' && patrol ? 'Patrol, in progress' : page}
                  onPress={() => goTo(page)}
                  style={({ pressed }) => [styles.tile, page === 'Patrol' && styles.tileWide, pressed && styles.tilePressed]}>
                  <View style={styles.tileIcon} accessible={false} importantForAccessibility="no-hide-descendants">
                    <Text style={styles.iconText}>{icons[page]}</Text>
                  </View>
                  <Text style={styles.name}>{page}</Text>
                  {page === 'Patrol' && patrol && <Pill label="In progress" tone="info" />}
                </Pressable>
              ))}
            </View>
          )}

          {tab === 'Patrol' && !patrol && (
            <Card>
              <Text style={styles.name}>Ready for a patrol?</Text>
              <Text style={styles.body}>
                Start whenever you’re ready. Checkpoints can be visited in any order.
                {checkpoints.length ? ` This site has ${checkpoints.length} checkpoint${checkpoints.length === 1 ? '' : 's'}.` : ''}
              </Text>
              {!checkpoints.length && <Text style={styles.body}>Ask your manager to add checkpoints, then pull down to refresh.</Text>}
              <Button label="Start patrol" disabled={busy || !checkpoints.length}
                onPress={() => setPatrol({ startedAt: new Date().toISOString(), checked: {}, points: workspace.points })} />
            </Card>
          )}

          {tab === 'Patrol' && patrol && (
            <>
              <Card>
                <PatrolTimer startedAt={patrol.startedAt} />
                <Text style={styles.name}>{checkpoints.length - missing.length} of {checkpoints.length} checkpoints checked</Text>
                <ProgressBar done={checkpoints.length - missing.length} total={checkpoints.length} />
                <Text style={styles.small}>
                  {reviewing ? 'Confirm the outcome before finishing.' : 'Demo mode: tap a checkpoint to mark it. NFC scanning is not enabled yet.'}
                </Text>
                {feedback && !reviewing ? <Text accessibilityLiveRegion="polite" style={styles.feedback}>{feedback}</Text> : null}
                {checkpoints.map(name => {
                  const scannedAt = Object.hasOwn(patrol.checked, name) ? patrol.checked[name] : undefined;
                  return <CheckpointRow key={name} name={name} scannedAt={scannedAt} review={reviewing}
                    onPress={reviewing ? undefined : () => mark(name)} />;
                })}
              </Card>
              {reviewing ? (
                <>
                  {missing.length > 0 && (
                    <Card>
                      <Text style={styles.name}>Why are you submitting an incomplete patrol?</Text>
                      <Text style={styles.body}>Missed · {missing.join(', ')}</Text>
                      <TextInput accessibilityLabel="Reason for missed checkpoints" value={reason} onChangeText={setReason}
                        multiline placeholder="Required. For example, the area was blocked." style={[styles.input, styles.multiline]} />
                    </Card>
                  )}
                  <Button label={busy ? 'Saving…' : missing.length ? 'Finish incomplete patrol' : 'Finish patrol'} onPress={() => void finish()}
                    disabled={busy || reminderBusy || (missing.length > 0 && !reason.trim())} />
                  <Button label="Back to patrol" tone="secondary" onPress={() => setReviewing(false)} />
                  {error ? <Button label="Discard this patrol" tone="danger" disabled={busy} onPress={resetPatrol} /> : null}
                </>
              ) : <Button label="Review patrol" onPress={() => { setFeedback(''); setReviewing(true); }} />}
            </>
          )}

          {tab === 'History' && (selectedPatrol ? (
            <>
              <Card>
                <View style={styles.spread}>
                  <Text style={styles.name}>{site}</Text>
                  <Pill label={selectedPatrol.reason ? 'Incomplete' : 'Complete'} tone={selectedPatrol.reason ? 'warn' : 'ok'} />
                </View>
                <Text style={styles.body}>Started {dateLabel(selectedPatrol.startedAt)}</Text>
                <Text style={styles.body}>Finished {dateLabel(selectedPatrol.finishedAt)}</Text>
                {selectedPatrol.checkpoints.map((point, index) => (
                  <CheckpointRow key={`${point.name}-${index}`} name={point.name} scannedAt={point.scannedAt} review />
                ))}
                {selectedPatrol.reason ? <Text style={styles.body}>Reason · {selectedPatrol.reason}</Text> : null}
              </Card>
              <Button label="Back to history" tone="secondary" onPress={() => setSelectedPatrolId(null)} />
            </>
          ) : history.length ? history.map(entry => {
            const done = entry.checkpoints.filter(point => point.scannedAt).length;
            return (
              <Pressable key={entry.id} accessibilityRole="button" onPress={() => setSelectedPatrolId(entry.id)}
                style={({ pressed }) => [styles.listItem, pressed && styles.pressed]}>
                <View style={styles.rowText}>
                  <Text style={styles.name}>{dateLabel(entry.finishedAt)}</Text>
                  <Text style={styles.small}>{done} of {entry.checkpoints.length} checkpoints</Text>
                </View>
                <Pill label={entry.reason ? 'Incomplete' : 'Complete'} tone={entry.reason ? 'warn' : 'ok'} />
              </Pressable>
            );
          }) : <Card><Text style={styles.body}>Finished patrols will appear here.</Text></Card>)}

          {tab === 'Reports' && (draft ? (
            <>
              <Card>
                <Text style={styles.name}>Category</Text>
                <View style={styles.categories}>
                  {categories.map(category => (
                    <Pressable key={category} accessibilityRole="radio" accessibilityState={{ checked: draft.category === category }}
                      style={[styles.chip, draft.category === category && styles.chipSelected]}
                      onPress={() => setDraft({ ...draft, category })}>
                      <Text style={styles.name}>{category}</Text>
                    </Pressable>
                  ))}
                </View>
                <Text style={styles.name}>Location (optional)</Text>
                <TextInput accessibilityLabel="Location" value={draft.location} placeholder="Building, floor, or checkpoint"
                  maxLength={200} onChangeText={location => setDraft({ ...draft, location })} style={styles.input} />
                <Text style={styles.name}>What happened?</Text>
                <TextInput accessibilityLabel="Description" value={draft.description} placeholder="Describe the issue"
                  maxLength={4000} onChangeText={description => setDraft({ ...draft, description })} multiline
                  style={[styles.input, styles.multiline]} />
              </Card>
              <Button label={busy ? 'Submitting…' : 'Submit report'} disabled={busy || !draft.description.trim()} onPress={() => void saveReport()} />
              <Button label="Cancel report" tone="secondary" onPress={() => { setDraft(null); setError(''); }} />
            </>
          ) : selectedReport ? (
            <>
              <Card>
                <View style={styles.spread}>
                  <Text style={styles.name}>{selectedReport.category}</Text>
                  <Pill label={selectedReport.status} tone={reportTone(selectedReport.status)} />
                </View>
                <Text style={styles.small}>{dateLabel(selectedReport.createdAt)}</Text>
                {selectedReport.location ? <Text style={styles.body}>Location · {selectedReport.location}</Text> : null}
                <Text style={styles.body}>{selectedReport.description}</Text>
              </Card>
              <Button label="Back to reports" tone="secondary" onPress={() => setSelectedReportId(null)} />
            </>
          ) : (
            <>
              <Text style={styles.body}>Report a site concern at any time, even during a patrol.</Text>
              <Button label="New report" onPress={() => {
                setError('');
                setDraft({ ...emptyReport, submissionId: Date.now().toString(36) + Math.random().toString(36).slice(2) });
              }} />
              <Text style={styles.sectionTitle}>My reports</Text>
              {reports.length ? reports.map(report => (
                <Pressable key={report.id} accessibilityRole="button" onPress={() => setSelectedReportId(report.id)}
                  style={({ pressed }) => [styles.listItem, pressed && styles.pressed]}>
                  <View style={styles.rowText}>
                    <Text style={styles.name}>{report.category}</Text>
                    <Text style={styles.small}>{dateLabel(report.createdAt)}</Text>
                  </View>
                  <Pill label={report.status} tone={reportTone(report.status)} />
                </Pressable>
              )) : <Card><Text style={styles.body}>Your site reports will appear here.</Text></Card>}
            </>
          ))}

          {tab === 'Account' && (
            <>
              <Card>
                <Text style={styles.name}>{session.user.name}</Text>
                <Text style={styles.body}>Role · Guard</Text>
                <Text style={styles.body}>Assigned site · {site}</Text>
                <Text style={styles.body}>Site patrol interval · {patrolIntervalMinutes} minutes</Text>
              </Card>
              <Card>
                <View style={styles.spread}>
                  <Text style={styles.name}>Patrol reminders</Text>
                  {supportsPatrolNotifications && <Pill label={remindersOn ? 'On' : 'Off'} tone={remindersOn ? 'ok' : 'info'} />}
                </View>
                <Text style={styles.body}>Remind me every {patrolIntervalMinutes} minutes. A full patrol restarts the reminder interval.</Text>
                {supportsPatrolNotifications ? (
                  <Button label={remindersOn ? 'Turn off reminders' : 'Enable reminders'}
                    tone={remindersOn ? 'secondary' : 'primary'} disabled={reminderBusy}
                    onPress={() => void updateReminder(!remindersOn, true)} />
                ) : <Text style={styles.body}>Device notifications are available in the mobile app.</Text>}
                {reminderMessage ? <Text style={styles.errorText}>{reminderMessage}</Text> : null}
              </Card>
              <Card>
                <Text style={styles.body}>
                  Submitted patrols and reports are saved on the server.
                  {patrol || draft ? ' Finish or cancel your open patrol or report before signing out.' : ''}
                </Text>
                <Button label="Sign out" tone="secondary" disabled={busy || reminderBusy || !!patrol || !!draft}
                  onPress={() => void signOut()} />
              </Card>
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const pillTones = {
  ok: StyleSheet.create({ box: { backgroundColor: '#DCF2E4' }, text: { color: '#17603A' } }),
  warn: StyleSheet.create({ box: { backgroundColor: '#FCE9C8' }, text: { color: '#7A4300' } }),
  info: StyleSheet.create({ box: { backgroundColor: '#E1EDE9' }, text: { color: '#145347' } }),
  bad: StyleSheet.create({ box: { backgroundColor: '#F7DCDC' }, text: { color: '#8E3131' } }),
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F0F5F3' },
  content: { width: '100%', maxWidth: 600, alignSelf: 'center', padding: 20, paddingBottom: 40, gap: 14 },
  centered: { flexGrow: 1, justifyContent: 'center' },
  eyebrow: { color: '#346259', fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  title: { color: '#142C28', fontSize: 34, fontWeight: '700' },
  sectionTitle: { color: '#142C28', fontSize: 18, fontWeight: '700', marginTop: 6 },
  timer: { color: '#142C28', fontSize: 34, fontWeight: '700', fontVariant: ['tabular-nums'] },
  body: { color: '#435D58', fontSize: 15, lineHeight: 22 },
  small: { color: '#5B726D', fontSize: 13, lineHeight: 18 },
  card: { backgroundColor: '#FFFFFF', padding: 16, borderRadius: 14, gap: 10 },
  name: { color: '#142C28', fontSize: 16, fontWeight: '600', flexShrink: 1 },
  spread: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  button: { backgroundColor: '#145347', paddingVertical: 14, paddingHorizontal: 16, minHeight: 48, justifyContent: 'center', alignItems: 'center', borderRadius: 12 },
  buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700', textAlign: 'center' },
  secondary: { backgroundColor: '#E1EDE9' },
  secondaryText: { color: '#145347', fontSize: 16, fontWeight: '600', textAlign: 'center' },
  dangerButton: { backgroundColor: '#8E3131' },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.5 },
  input: { backgroundColor: '#F0F5F3', color: '#142C28', borderRadius: 10, padding: 12, fontSize: 16, minHeight: 48 },
  multiline: { minHeight: 100, textAlignVertical: 'top' },
  errorText: { color: '#8E3131', fontSize: 14, lineHeight: 20 },
  errorBanner: { color: '#8E3131', backgroundColor: '#F7DCDC', padding: 12, borderRadius: 10, fontSize: 14, lineHeight: 20 },
  feedback: { color: '#145347', backgroundColor: '#E1EDE9', padding: 10, borderRadius: 8, fontSize: 14 },
  categories: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { backgroundColor: '#F0F5F3', borderWidth: 1, borderColor: '#F0F5F3', paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10 },
  chipSelected: { backgroundColor: '#E1EDE9', borderColor: '#145347' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', columnGap: '4%', rowGap: 14, marginTop: 4 },
  tile: { width: '48%', minHeight: 124, backgroundColor: '#FFFFFF', borderRadius: 14, padding: 16, gap: 8 },
  tileWide: { width: '100%' },
  tilePressed: { backgroundColor: '#E1EDE9' },
  tileIcon: { width: 42, height: 42, borderRadius: 10, backgroundColor: '#E1EDE9', alignItems: 'center', justifyContent: 'center' },
  iconText: { color: '#145347', fontSize: 25 },
  pill: { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 20, alignSelf: 'flex-start' },
  pillText: { fontSize: 12, fontWeight: '700' },
  track: { height: 8, borderRadius: 4, backgroundColor: '#E1EDE9', overflow: 'hidden' },
  fill: { height: 8, backgroundColor: '#145347' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, minHeight: 56, borderTopWidth: 1, borderTopColor: '#E8F0ED' },
  rowText: { flex: 1, gap: 2 },
  dot: { width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: '#A9BDB5', alignItems: 'center', justifyContent: 'center' },
  dotDone: { backgroundColor: '#145347', borderColor: '#145347' },
  dotMissed: { backgroundColor: '#8E3131', borderColor: '#8E3131' },
  dotText: { fontSize: 14, fontWeight: '700', color: 'transparent' },
  dotTextOn: { color: '#FFFFFF' },
  listItem: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#FFFFFF', borderRadius: 14, padding: 16, minHeight: 64 },
  logo: { width: 56, height: 56, borderRadius: 16, backgroundColor: '#145347', alignItems: 'center', justifyContent: 'center' },
  logoText: { color: '#FFFFFF', fontSize: 30 },
});
