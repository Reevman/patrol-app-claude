import { useEffect, useState, type ReactNode } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { disablePatrolReminder, hasPatrolReminder, schedulePatrolReminder, supportsPatrolNotifications } from './patrolReminders';

import { api, ApiError, type Session } from './patrolApi';

type Workspace = {
  points: { id: string; name: string }[];
  interval: number;
  reports: Report[];
  patrols: { id: string; startedAt: string; finishedAt: string; reason: string;
    checkpoints: { name: string; scannedAt?: string }[] }[];
};

const site = 'Riverside Business Park';
const tabs = ['Patrol', 'History', 'Reports', 'Account'] as const;
const categories = ['Safety hazard', 'Damaged equipment', 'Access issue', 'Other'] as const;

type Tab = typeof tabs[number];
const icons: Record<Tab, string> = { Patrol: '◎', History: '◷', Reports: '▤', Account: '♙' };
type Category = typeof categories[number];
type Patrol = { startedAt: string; checked: Partial<Record<string, string>> };
type ActivePatrol = Patrol & { points: Workspace["points"] };
type Result = Patrol & { id: string; points: string[]; finishedAt: string; reason: string };
type ReportDraft = { category: Category; location: string; description: string };
type Report = ReportDraft & { id: string; createdAt: string; status: string };

const emptyReport: ReportDraft = { category: 'Safety hazard', location: '', description: '' };

function Button({ label, onPress, secondary = false, disabled = false }: {
  label: string; onPress: () => void; secondary?: boolean; disabled?: boolean;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled}
      onPress={onPress} style={[styles.button, secondary && styles.secondary, disabled && styles.disabled]}>
      <Text style={secondary ? styles.name : styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

function dateLabel(value: string) {
  return new Date(value).toLocaleString();
}

function PatrolTimer({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  const duration = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(part => String(part).padStart(2, '0'))
    .join(':');

  return (
    <View>
      <Text style={styles.body}>Elapsed time</Text>
      <Text style={styles.timer}>{duration}</Text>
    </View>
  );
}

function PatrolStatus({ lastCompleted, intervalMinutes }: { lastCompleted?: string; intervalMinutes: number }) {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(interval);
  }, []);

  const elapsed = lastCompleted ? Math.max(0, now - Date.parse(lastCompleted)) : null;
  const minutes = elapsed === null ? 0 : Math.floor(elapsed / 60000);
  const hours = Math.floor(minutes / 60);
  const remaining = elapsed === null ? 0 : Math.ceil((intervalMinutes * 60000 - elapsed) / 60000);
  const age = minutes === 0 ? 'Just now' : hours > 0
    ? `${hours}h ${minutes % 60}m ago` : `${minutes} min ago`;

  return (
    <Card>
      <Text style={styles.name}>{remaining > 0 ? `Next patrol due in ${remaining} min` : 'Patrol due'}</Text>
      <Text style={styles.body}>{lastCompleted ? `Last full patrol · ${age}` : 'No full patrol recorded yet.'}</Text>
      {lastCompleted && <Text style={styles.body}>{dateLabel(lastCompleted)}</Text>}
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

  async function signIn() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const next = await api<Session>('sign-in', undefined, { email, password });
      if (next.user.role !== 'guard') {
        await api('sign-out', next.token, {});
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

  if (session && initial) return <GuardApp session={session} initial={initial} onSignOut={() => {
    setSession(null);
    setInitial(null);
  }} />;

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.screen}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text accessibilityRole="header" style={styles.title}>Guard sign-in</Text>
          <Card>
            <Text style={styles.name}>Email</Text>
            <TextInput accessibilityLabel="Email" keyboardType="email-address" autoCapitalize="none"
              autoComplete="email" value={email} onChangeText={setEmail} style={styles.input} />
            <Text style={styles.name}>Password</Text>
            <TextInput accessibilityLabel="Password" secureTextEntry autoComplete="current-password"
              value={password} onChangeText={setPassword} style={styles.input} />
            <Button label="Sign in" disabled={busy || !email.trim() || !password} onPress={() => void signIn()} />
            {error ? <Text accessibilityRole="alert" style={styles.body}>{error}</Text> : null}
          </Card>
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function GuardApp({ session, initial, onSignOut }: { session: Session; initial: Workspace; onSignOut: () => void }) {
  const [tab, setTab] = useState<Tab | 'Home'>('Home');
  const [patrol, setPatrol] = useState<ActivePatrol | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reason, setReason] = useState('');
  const [workspace, setWorkspace] = useState(initial);
  const [busy, setBusy] = useState(false);
  const checkpoints = (patrol?.points ?? workspace.points).map(point => point.name);
  const patrolIntervalMinutes = workspace.interval;
  const history: Result[] = workspace.patrols.map(entry => ({
    ...entry,
    points: entry.checkpoints.map(point => point.name),
    checked: Object.fromEntries(entry.checkpoints.filter(point => point.scannedAt).map(point => [point.name, point.scannedAt])),
  }));
  const [selectedPatrol, setSelectedPatrol] = useState<Result | null>(null);
  const reports = workspace.reports;
  const [draft, setDraft] = useState<(ReportDraft & { submissionId: string }) | null>(null);
  const [selectedReport, setSelectedReport] = useState<Report | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [remindersOn, setRemindersOn] = useState(false);
  const [reminderBusy, setReminderBusy] = useState(false);
  const [reminderMessage, setReminderMessage] = useState('');
  const lastCompleted = history.find(entry => !entry.reason)?.finishedAt;

  useEffect(() => {
    hasPatrolReminder().then(setRemindersOn)
      .catch(() => setReminderMessage('Could not check notification settings.'));
  }, []);

  async function updateReminder(turnOn: boolean, requestPermission = false) {
    setReminderBusy(true);
    setReminderMessage('');
    try {
      if (turnOn) {
        const enabled = await schedulePatrolReminder(requestPermission, patrolIntervalMinutes);
        setRemindersOn(enabled);
        if (!enabled) setReminderMessage('Allow Patrol notifications in your device settings.');
      } else {
        await disablePatrolReminder();
        setRemindersOn(false);
      }
    } catch {
      setReminderMessage('Could not update patrol reminders. Try again.');
      setRemindersOn(await hasPatrolReminder().catch(() => false));
    } finally {
      setReminderBusy(false);
    }
  }

  const missing = checkpoints.filter(checkpoint => !patrol || !Object.hasOwn(patrol.checked, checkpoint));

  async function send(path: string, input?: object) {
    if (busy) return null;
    setBusy(true);
    setHistoryError('');
    try {
      const next = await api<Workspace>(path, session.token, input);
      setWorkspace(next);
      return next;
    } catch (failure) {
      setHistoryError((failure as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    if (!patrol || (missing.length > 0 && !reason.trim())) return;
    const next = await send('patrols', {
      startedAt: patrol.startedAt,
      finishedAt: new Date().toISOString(),
      reason,
      points: patrol.points.map(point => point.id),
      checked: Object.fromEntries(patrol.points
        .filter(point => Object.hasOwn(patrol.checked, point.name))
        .map(point => [point.id, patrol.checked[point.name]])),
    });
    if (!next) return;
    if (!missing.length && remindersOn) void updateReminder(true);
    setPatrol(null);
    setReviewing(false);
    setReason('');
    setSelectedPatrol(null);
    setTab('History');
  }

  async function saveReport() {
    if (!draft?.description.trim()) return;
    if (await send('reports', draft)) setDraft(null);
  }

  async function signOut() {
    setBusy(true);
    try {
      if (supportsPatrolNotifications) await disablePatrolReminder();
      await api('sign-out', session.token, {});
      onSignOut();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onSignOut();
      else setHistoryError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const title = tab === 'Patrol' && reviewing ? 'Review patrol'
    : tab === 'History' && selectedPatrol ? 'Patrol details'
    : tab === 'Reports' && draft ? 'New report'
    : tab === 'Reports' && selectedReport ? 'Report details'
    : tab;

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.screen}>
        <StatusBar style="dark" />
        <ScrollView key={title} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.eyebrow}>GUARD APP</Text>
          {tab !== 'Home' && <Button label="‹ Home" secondary onPress={() => setTab('Home')} />}
          <Text accessibilityRole="header" style={styles.title}>{title}</Text>
          <Text style={styles.body}>{site}</Text>

          {historyError ? <Text style={styles.body}>{historyError}</Text> : null}
          {(tab === 'Home' || (tab === 'Patrol' && !patrol)) && (
            <PatrolStatus lastCompleted={lastCompleted} intervalMinutes={patrolIntervalMinutes} />
          )}

          {tab === 'Home' && (
            <View style={styles.grid}>
              {tabs.map(page => (
                <Pressable key={page} accessibilityRole="button" accessibilityLabel={page}
                  onPress={() => setTab(page)}
                  style={({ pressed }) => [styles.tile, page === 'Patrol' && styles.tileWide, pressed && styles.tilePressed]}>
                  <View style={styles.tileIcon} accessible={false} importantForAccessibility="no-hide-descendants">
                    <Text style={styles.iconText}>{icons[page]}</Text>
                  </View>
                  <Text style={styles.name}>{page}</Text>
                  {page === 'Patrol' && patrol && <Text style={styles.body}>In progress</Text>}
                </Pressable>
              ))}
            </View>
          )}

          {tab === 'Patrol' && !patrol && (
            <Card>
              <Text style={styles.name}>Ready for a patrol?</Text>
              <Text style={styles.body}>Start whenever you’re ready. Checkpoints can be visited in any order.</Text>
              {!checkpoints.length && <Text style={styles.body}>Ask your manager to add checkpoints, then refresh.</Text>}
              <Button label="Refresh site" secondary disabled={busy} onPress={() => void send('workspace')} />
              <Button label="Start patrol" disabled={busy || !checkpoints.length} onPress={() => setPatrol({ startedAt: new Date().toISOString(), checked: {}, points: workspace.points })} />
            </Card>
          )}

          {tab === 'Patrol' && patrol && (
            <>
              <Card>
                <PatrolTimer startedAt={patrol.startedAt} />
                <Text style={styles.name}>{checkpoints.length - missing.length} of {checkpoints.length} checkpoints checked</Text>
                <Text style={styles.body}>{reviewing ? 'Confirm the outcome before finishing.' : 'Mark checkpoints manually for this demo.'}</Text>
                {checkpoints.map(checkpoint => {
                  const scannedAt = Object.hasOwn(patrol.checked, checkpoint) ? patrol.checked[checkpoint] : undefined;
                  return reviewing
                    ? <Text key={checkpoint} style={styles.body}>{checkpoint} · {scannedAt ? dateLabel(scannedAt) : 'Missed'}</Text>
                    : <Button key={checkpoint} secondary disabled={Boolean(scannedAt)}
                        label={scannedAt ? `${checkpoint} · ${dateLabel(scannedAt)}` : `Mark ${checkpoint}`}
                        onPress={() => {
                          const timestamp = new Date().toISOString();
                          setPatrol(current => current && !Object.hasOwn(current.checked, checkpoint)
                            ? { ...current, checked: { ...current.checked, [checkpoint]: timestamp } } : current);
                        }} />;
                })}
              </Card>
              {reviewing ? (
                <>
                  {missing.length > 0 && (
                    <Card>
                      <Text style={styles.name}>Why are you submitting an incomplete patrol?</Text>
                      <Text style={styles.body}>Missed checkpoints · {missing.join(', ')}</Text>
                      <TextInput accessibilityLabel="Reason for missed checkpoints" value={reason}
                        onChangeText={setReason} multiline placeholder="Required. For example, the area was blocked." style={[styles.input, styles.multiline]} />
                    </Card>
                  )}
                  <Button label={missing.length ? 'Finish incomplete patrol' : 'Finish patrol'} onPress={finish}
                    disabled={busy || reminderBusy || (missing.length > 0 && !reason.trim())} />
                  <Button label="Back to patrol" secondary onPress={() => setReviewing(false)} />
                  {historyError && <Button label="Discard this patrol" secondary disabled={busy} onPress={() => {
                    setPatrol(null);
                    setReviewing(false);
                    setReason('');
                    setHistoryError('');
                  }} />}
                </>
              ) : <Button label="Review patrol" onPress={() => setReviewing(true)} />}
            </>
          )}

          {tab === 'History' && (selectedPatrol ? (
            <>
              <Card>
                <Text style={styles.name}>{selectedPatrol.reason ? 'Incomplete patrol' : 'Complete patrol'}</Text>
                <Text style={styles.body}>Started {dateLabel(selectedPatrol.startedAt)}</Text>
                <Text style={styles.body}>Finished {dateLabel(selectedPatrol.finishedAt)}</Text>
                {selectedPatrol.points.map(checkpoint => {
                  const scannedAt = Object.hasOwn(selectedPatrol.checked, checkpoint) ? selectedPatrol.checked[checkpoint] : undefined;
                  return (
                    <Text key={checkpoint} style={styles.body}>
                      {checkpoint} · {scannedAt ? dateLabel(scannedAt) : 'Missed'}
                    </Text>
                  );
                })}
                {selectedPatrol.reason ? <Text style={styles.body}>Reason · {selectedPatrol.reason}</Text> : null}
              </Card>
              <Button label="Back to history" secondary onPress={() => setSelectedPatrol(null)} />
            </>
          ) : history.length ? history.map(entry => (
            <Button key={entry.id} secondary
              label={`${entry.reason ? 'Incomplete' : 'Complete'} · ${Object.keys(entry.checked).length}/${entry.points.length} · ${dateLabel(entry.finishedAt)}`}
              onPress={() => setSelectedPatrol(entry)} />
          )) : <Card><Text style={styles.body}>Finished patrols will appear here.</Text></Card>)}

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
                  onChangeText={location => setDraft({ ...draft, location })} style={styles.input} />
                <Text style={styles.name}>What happened?</Text>
                <TextInput accessibilityLabel="Description" value={draft.description} placeholder="Describe the issue"
                  onChangeText={description => setDraft({ ...draft, description })} multiline style={[styles.input, styles.multiline]} />
              </Card>
              <Button label="Submit report" disabled={busy || !draft.description.trim()} onPress={saveReport} />
              <Button label="Cancel report" secondary onPress={() => setDraft(null)} />
            </>
          ) : selectedReport ? (
            <>
              <Card>
                <Text style={styles.name}>{selectedReport.category}</Text>
                <Text style={styles.body}>{selectedReport.status} · {dateLabel(selectedReport.createdAt)}</Text>
                {selectedReport.location ? <Text style={styles.body}>Location · {selectedReport.location}</Text> : null}
                <Text style={styles.body}>{selectedReport.description}</Text>
              </Card>
              <Button label="Back to reports" secondary onPress={() => setSelectedReport(null)} />
            </>
          ) : (
            <>
              <Text style={styles.body}>Report a site concern at any time.</Text>
              <Button label="New report" onPress={() => setDraft({ ...emptyReport, submissionId: Date.now().toString(36) + Math.random().toString(36).slice(2) })} />
              <Text style={styles.name}>My reports</Text>
              {reports.length ? reports.map(report => (
                <Button key={report.id} secondary label={`${report.category} · ${dateLabel(report.createdAt)}`}
                  onPress={() => setSelectedReport(report)} />
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
                <Text style={styles.name}>Patrol reminders</Text>
                <Text style={styles.body}>Remind me every {patrolIntervalMinutes} minutes. A full patrol restarts the reminder interval.</Text>
                {supportsPatrolNotifications ? (
                  <Button label={remindersOn ? 'Turn off reminders' : 'Enable reminders'}
                    disabled={reminderBusy} onPress={() => void updateReminder(!remindersOn, true)} />
                ) : <Text style={styles.body}>Device notifications are available in the mobile app.</Text>}
                {reminderMessage ? <Text style={styles.body}>{reminderMessage}</Text> : null}
              </Card>
              <Card>
                <Text style={styles.body}>Submitted patrols and reports are saved on the server. Finish or submit your work before signing out.</Text>
                <Button label="Sign out" secondary disabled={busy || reminderBusy || !!patrol || !!draft} onPress={() => void signOut()} />
              </Card>
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F0F5F3' },
  content: { width: '100%', maxWidth: 600, alignSelf: 'center', padding: 24, gap: 14 },
  eyebrow: { color: '#346259', fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  title: { color: '#142C28', fontSize: 36, fontWeight: '700' },
  timer: { color: '#142C28', fontSize: 30, fontWeight: '700', fontVariant: ['tabular-nums'] },
  body: { color: '#435D58', fontSize: 15, lineHeight: 22 },
  card: { backgroundColor: '#FFFFFF', padding: 16, borderRadius: 12, gap: 10 },
  name: { color: '#142C28', fontSize: 16, fontWeight: '600' },
  button: { backgroundColor: '#145347', padding: 14, alignItems: 'center', borderRadius: 10 },
  buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700', textAlign: 'center' },
  secondary: { backgroundColor: '#E1EDE9' },
  disabled: { opacity: 0.55 },
  input: { backgroundColor: '#F0F5F3', color: '#142C28', borderRadius: 8, padding: 12, fontSize: 16 },
  multiline: { minHeight: 92, textAlignVertical: 'top' },
  categories: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { backgroundColor: '#F0F5F3', borderWidth: 1, borderColor: '#F0F5F3', padding: 8, borderRadius: 8 },
  chipSelected: { backgroundColor: '#E1EDE9', borderColor: '#145347' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', columnGap: '4%', rowGap: 14, marginTop: 8 },
  tile: { width: '48%', minHeight: 124, backgroundColor: '#FFFFFF', borderRadius: 12, padding: 16, gap: 8 },
  tileWide: { width: '100%' },
  tilePressed: { backgroundColor: '#E1EDE9' },
  tileIcon: { width: 42, height: 42, borderRadius: 10, backgroundColor: '#E1EDE9', alignItems: 'center', justifyContent: 'center' },
  iconText: { color: '#145347', fontSize: 25 },
});
