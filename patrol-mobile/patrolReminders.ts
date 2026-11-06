import { Platform } from 'react-native';

const reminderId = 'patrol-reminder';
const channelId = 'patrol-reminders';

export const supportsPatrolNotifications = Platform.OS === 'ios' || Platform.OS === 'android';

async function loadNotifications() {
  const notifications = await import('expo-notifications');
  notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
  return notifications;
}

export async function hasPatrolReminder() {
  return (await getPatrolReminder()).enabled;
}

/** Reports whether the reminder is scheduled and, when the platform exposes it, its interval in minutes. */
export async function getPatrolReminder(): Promise<{ enabled: boolean; minutes: number | null }> {
  if (!supportsPatrolNotifications) return { enabled: false, minutes: null };
  const notifications = await loadNotifications();
  const scheduled = await notifications.getAllScheduledNotificationsAsync();
  const request = scheduled.find(item => item.identifier === reminderId);
  const seconds = (request?.trigger as unknown as { seconds?: unknown } | null | undefined)?.seconds;
  return {
    enabled: Boolean(request),
    minutes: typeof seconds === 'number' ? Math.round(seconds / 60) : null,
  };
}

export async function schedulePatrolReminder(requestPermission: boolean, intervalMinutes: number) {
  const notifications = await loadNotifications();
  if (Platform.OS === 'android') {
    await notifications.setNotificationChannelAsync(channelId, {
      name: 'Patrol reminders',
      importance: notifications.AndroidImportance.DEFAULT,
    });
  }
  let permission = await notifications.getPermissionsAsync();
  if (!permission.granted && requestPermission && permission.canAskAgain) {
    permission = await notifications.requestPermissionsAsync();
  }
  if (!permission.granted) return false;

  await notifications.cancelScheduledNotificationAsync(reminderId);
  await notifications.scheduleNotificationAsync({
    identifier: reminderId,
    content: { title: 'Patrol reminder', body: 'Check your patrol status and start another round when ready.' },
    trigger: {
      type: notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: intervalMinutes * 60,
      repeats: true,
      channelId,
    },
  });
  return true;
}

export async function disablePatrolReminder() {
  const notifications = await loadNotifications();
  await notifications.cancelScheduledNotificationAsync(reminderId);
}
