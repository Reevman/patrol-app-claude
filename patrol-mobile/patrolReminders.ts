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
  if (!supportsPatrolNotifications) return false;
  const notifications = await loadNotifications();
  const scheduled = await notifications.getAllScheduledNotificationsAsync();
  return scheduled.some(request => request.identifier === reminderId);
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
