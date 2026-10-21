/**
 * Optional OS notifications for monitor reminders. In-app reminder cards
 * always show; these are a bonus behind the Settings toggle. The localStorage
 * flag is only persisted when Notification.permission is 'granted'.
 */
const KEY = 'eyefd.notify';

export function notificationsSupported(): boolean {
  return typeof Notification !== 'undefined';
}

export type NotifyPermission = 'granted' | 'denied' | 'default' | 'unsupported';

export function notificationPermission(): NotifyPermission {
  if (!notificationsSupported()) return 'unsupported';
  try {
    return Notification.permission;
  } catch {
    return 'unsupported';
  }
}

export function notificationsEnabled(): boolean {
  try {
    return notificationPermission() === 'granted' && localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/** Ask for permission; persist the opt-in only when granted. Returns the final enabled state. */
export async function enableNotifications(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  try {
    const p = await Notification.requestPermission();
    if (p === 'granted') {
      localStorage.setItem(KEY, '1');
      return true;
    }
    localStorage.removeItem(KEY);
    return false;
  } catch {
    return false;
  }
}

export function disableNotifications(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

/** Best effort — a no-op unless enabled, never throws. */
export function sendNotification(title: string, body: string): void {
  if (!notificationsEnabled()) return;
  try {
    new Notification(title, { body });
  } catch {
    // Notification constructors can still fail (e.g. non-secure context).
  }
}
