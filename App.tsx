import React, { useEffect, useState, useRef, useCallback } from 'react';
import { StyleSheet, AppState, AppStateStatus, LogBox } from 'react-native';

LogBox.ignoreLogs([
  '[RevenueCat]',
  'Error fetching offerings',
  'RevenueCat',
]);
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as SecureStore from 'expo-secure-store';

import { useOnboardingStore } from './src/store/onboardingStore';
import { useUserStore } from './src/store/userStore';
import { GlassAlertProvider } from './src/components/GlassAlert';
import { StripeProvider } from '@stripe/stripe-react-native';
import { useNotificationStore } from './src/store/notificationStore';
import { AppNavigator } from './src/navigation/AppNavigator';
import { CleanerAppNavigator } from './src/navigation/CleanerAppNavigator';
import { OnboardingNavigator } from './src/navigation/OnboardingNavigator';
import { LoadingScreen } from './src/components/LoadingScreen';
import { BiometricSplash } from './src/components/BiometricSplash';
import { registerForPushNotifications, addNotificationResponseListener } from './src/services/notifications';
import { onAuthExpired, apiFetch } from './src/services/api';
import { Colors } from './src/constants/theme';
import { configureRevenueCat, identifyUser, addCustomerInfoListener, hasEntitlement } from './src/services/revenueCat';

const BACKGROUND_TIMEOUT = 5 * 60 * 1000; // 5 minutes

type AuthGate = 'loading' | 'biometric' | 'authenticated' | 'login';

export default function App() {
  const { hasCompleted, isLoading, biometricEnabled, hydrate: hydrateOnboarding } = useOnboardingStore();
  const hydrateUser = useUserStore(s => s.hydrate);
  const fetchBillingStatus = useUserStore(s => s.fetchBillingStatus);
  const userHydrated = useUserStore(s => s.hydrated);
  const accountType = useUserStore(s => s.profile?.accountType);
  const setProfile = useUserStore(s => s.setProfile);
  const [accountTypeResolved, setAccountTypeResolved] = useState(false);
  const setPushToken = useNotificationStore(s => s.setPushToken);
  const fetchNotifications = useNotificationStore(s => s.fetchNotifications);

  const [authGate, setAuthGate] = useState<AuthGate>('loading');
  const backgroundedAt = useRef<number | null>(null);

  // On 401, clear auth state and redirect to login
  useEffect(() => {
    onAuthExpired(() => {
      useUserStore.getState().clearAll();
      useOnboardingStore.getState().reset();
      setAuthGate('login');
    });
  }, []);

  // Configure RevenueCat once at app startup
  useEffect(() => {
    configureRevenueCat();
  }, []);

  useEffect(() => {
    hydrateOnboarding();
    hydrateUser().then(async () => {
      // Identify user with RevenueCat after hydration
      const profile = useUserStore.getState().profile;
      if (profile?.email) {
        await identifyUser(profile.email);
      }
      await fetchBillingStatus();
    }).catch(() => {});
  }, []);

  // Listen for RevenueCat subscription changes (runtime updates only).
  // On app startup, fetchBillingStatus handles the initial check after hydration.
  // This listener catches mid-session changes (renewals, expirations, new purchases).
  useEffect(() => {
    const listener = addCustomerInfoListener((info) => {
      const isActive = hasEntitlement(info);
      const profile = useUserStore.getState().profile;
      if (!profile) return; // Not yet hydrated — fetchBillingStatus handles startup
      useUserStore.getState().setProfile({
        isSubscriptionActive: isActive || profile.isFounder || profile.lifetimeFree,
      });
    });
    return () => listener.remove();
  }, []);

  // Determine auth gate after hydration (wait for both stores)
  useEffect(() => {
    if (isLoading || !userHydrated) return;

    if (!hasCompleted) {
      setAuthGate('login');
      return;
    }

    if (biometricEnabled) {
      SecureStore.getItemAsync('pp_token').then(token => {
        setAuthGate(token ? 'biometric' : 'login');
      }).catch(() => setAuthGate('login'));
    } else {
      setAuthGate('authenticated');
    }
  }, [isLoading, userHydrated, hasCompleted, biometricEnabled]);

  // GAP 5: If accountType is unknown after auth, fetch from backend before routing
  useEffect(() => {
    if (authGate !== 'authenticated') return;
    if (accountType) {
      setAccountTypeResolved(true);
      return;
    }
    // accountType missing — fetch from backend
    apiFetch('/api/auth/me').then(res => {
      if (res?.role) {
        setProfile({ accountType: res.role === 'cleaner' ? 'cleaner' : 'owner' });
      }
    }).catch(() => {
      // Can't fetch — default to owner (existing behavior)
    }).finally(() => {
      setAccountTypeResolved(true);
    });
  }, [authGate, accountType]);

  // Identify user with RevenueCat when auth completes (e.g. after sign-in)
  useEffect(() => {
    if (authGate !== 'authenticated') return;
    const profile = useUserStore.getState().profile;
    if (profile?.email) {
      identifyUser(profile.email).then(() => fetchBillingStatus()).catch(() => {});
    }
  }, [authGate]);

  // 5-minute background timeout
  useEffect(() => {
    const handleAppState = (next: AppStateStatus) => {
      if (next === 'background' || next === 'inactive') {
        backgroundedAt.current = Date.now();
      } else if (next === 'active' && backgroundedAt.current !== null) {
        const elapsed = Date.now() - backgroundedAt.current;
        backgroundedAt.current = null;
        if (
          elapsed > BACKGROUND_TIMEOUT &&
          biometricEnabled &&
          authGate === 'authenticated'
        ) {
          setAuthGate('biometric');
        }
      }
    };

    const sub = AppState.addEventListener('change', handleAppState);
    return () => sub.remove();
  }, [biometricEnabled, authGate]);

  // Register push notifications after auth is ready (wait for token hydration)
  useEffect(() => {
    if (!hasCompleted || isLoading || !userHydrated) return;
    registerForPushNotifications().then(token => {
      if (token) setPushToken(token);
    });
    fetchNotifications();
    const sub = addNotificationResponseListener(() => {
      fetchNotifications();
    });
    return () => sub.remove();
  }, [hasCompleted, isLoading, userHydrated]);

  const handleBiometricSuccess = useCallback(() => {
    setAuthGate('authenticated');
  }, []);

  const handleBiometricFallback = useCallback(() => {
    setAuthGate('login');
  }, []);

  if (authGate === 'loading') {
    return (
      <GestureHandlerRootView style={styles.root}>
        <SafeAreaProvider>
          <StatusBar style="dark" backgroundColor={Colors.bg} />
          <LoadingScreen />
        </SafeAreaProvider>
      </GestureHandlerRootView>
    );
  }

  if (authGate === 'biometric') {
    return (
      <GestureHandlerRootView style={styles.rootWhite}>
        <SafeAreaProvider>
          <StatusBar style="dark" backgroundColor={Colors.bg} />
          <BiometricSplash
            onSuccess={handleBiometricSuccess}
            onFallback={handleBiometricFallback}
          />
        </SafeAreaProvider>
      </GestureHandlerRootView>
    );
  }

  if (authGate === 'login') {
    return (
      <GestureHandlerRootView style={styles.root}>
        <SafeAreaProvider>
          <StatusBar style="dark" backgroundColor={Colors.bg} />
          <OnboardingNavigator />
        </SafeAreaProvider>
      </GestureHandlerRootView>
    );
  }

  // Wait for accountType to be resolved before routing
  if (!accountTypeResolved) {
    return (
      <GestureHandlerRootView style={styles.root}>
        <SafeAreaProvider>
          <StatusBar style="dark" backgroundColor={Colors.bg} />
          <LoadingScreen />
        </SafeAreaProvider>
      </GestureHandlerRootView>
    );
  }

  const Navigator = accountType === 'cleaner' ? CleanerAppNavigator : AppNavigator;

  // Fetch Stripe publishable key for payment sheet
  const [stripeKey, setStripeKey] = useState<string | null>(null);
  useEffect(() => {
    fetch('https://portfoliopigeon.com/api/invoice/publishable-key')
      .then(r => r.json())
      .then(d => { if (d.publishable_key) setStripeKey(d.publishable_key); })
      .catch(() => {});
  }, []);

  return (
    <GestureHandlerRootView style={styles.root}>
      <StripeProvider
        publishableKey={stripeKey || 'pk_placeholder'}
        merchantIdentifier="merchant.com.portfoliopigeon.mobile"
      >
        <SafeAreaProvider>
          <StatusBar style="dark" backgroundColor={Colors.bg} />
          <Navigator />
          <GlassAlertProvider />
        </SafeAreaProvider>
      </StripeProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  rootWhite: { flex: 1, backgroundColor: Colors.bg },
});
