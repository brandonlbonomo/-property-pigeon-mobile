import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { apiFetch } from './api';

// Expo Go doesn't have native push modules — skip everything
const isExpoGo = Constants.appOwnership === 'expo';

let Notifications: any = null;
let Device: any = null;

if (!isExpoGo) {
  try {
    Notifications = require('expo-notifications');
    Device = require('expo-device');
  } catch {
    // native modules not available
  }
}

if (Notifications) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

export async function registerForPushNotifications(): Promise<string | null> {
  if (!Notifications || !Device) return null;

  if (!Device.isDevice) {
    return null;
  }

  const { status: existing } = await Notifications.getPermissionsAsync();
  let finalStatus = existing;

  if (existing !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    return null;
  }

  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;

  const tokenData = await Notifications.getExpoPushTokenAsync({
    projectId,
  });

  const token = tokenData.data;

  try {
    await apiFetch('/api/push/register', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
  } catch {
    // push registration failed — non-critical
  }

  if (Platform.OS === 'android') {
    Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
    });
  }

  return token;
}

export async function unregisterPushToken(token: string) {
  try {
    await apiFetch('/api/push/unregister', {
      method: 'DELETE',
      body: JSON.stringify({ token }),
    });
  } catch {
    // ignore
  }
}

export function addNotificationReceivedListener(
  handler: (notification: any) => void
) {
  if (!Notifications) return { remove: () => {} };
  return Notifications.addNotificationReceivedListener(handler);
}

export function addNotificationResponseListener(
  handler: (response: any) => void
) {
  if (!Notifications) return { remove: () => {} };
  return Notifications.addNotificationResponseReceivedListener(handler);
}
