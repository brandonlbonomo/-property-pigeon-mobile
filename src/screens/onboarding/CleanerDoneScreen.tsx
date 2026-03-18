import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, Alert, ActivityIndicator } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as SecureStore from 'expo-secure-store';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { useOnboardingStore } from '../../store/onboardingStore';
import { useUserStore } from '../../store/userStore';
import { apiRegister, apiFetch } from '../../services/api';
import { identifyUser } from '../../services/revenueCat';

export function CleanerDoneScreen() {
  const complete = useOnboardingStore(s => s.complete);
  const pendingCredentials = useOnboardingStore(s => s.pendingCredentials);
  const pendingFollows = useOnboardingStore(s => s.pendingFollows);
  const clearPendingFollows = useOnboardingStore(s => s.clearPendingFollows);
  const profile = useUserStore(s => s.profile);
  const fetchBillingStatus = useUserStore(s => s.fetchBillingStatus);
  const [loading, setLoading] = useState(false);

  const handleEnter = async () => {
    if (!pendingCredentials) {
      Alert.alert('Error', 'Account credentials not found. Please restart onboarding.');
      return;
    }

    setLoading(true);
    try {
      // 1. Register the user
      const res = await apiRegister(pendingCredentials.email, pendingCredentials.password, {
        role: pendingCredentials.role,
        username: pendingCredentials.username,
      });

      // 2. Store token
      await SecureStore.setItemAsync('pp_token', res.token);
      await SecureStore.setItemAsync('pp_email', pendingCredentials.email);

      // 3. Identify with RevenueCat to link anonymous purchases
      await identifyUser(String(res.user_id));

      // 4. Send pending follow requests
      if (pendingFollows.length > 0) {
        for (const username of pendingFollows) {
          try {
            await apiFetch('/api/follow/request', {
              method: 'POST',
              body: JSON.stringify({ username }),
            });
          } catch {
            // Silently skip — may already be following
          }
        }
        clearPendingFollows();
      }

      // 5. Sync cleaner market if set
      if (profile?.market) {
        try {
          await apiFetch('/api/users/profile', {
            method: 'PUT',
            body: JSON.stringify({ market: profile.market }),
          });
        } catch {
          // Non-critical
        }
      }

      // 6. Fetch billing status (now that we have auth)
      await fetchBillingStatus();

      // 7. Complete onboarding
      await complete('str');
    } catch (e: any) {
      Alert.alert('Registration Failed', e?.serverError || e?.message || 'Could not create your account. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        {/* Progress: 4 of 4 */}
        <View style={styles.progress}>
          {[1, 2, 3, 4].map(s => (
            <View key={s} style={[styles.dot, styles.dotActive]} />
          ))}
        </View>

        <View style={styles.checkCircle}>
          <Ionicons name="checkmark" size={48} color="#fff" />
        </View>

        <Text style={styles.title}>You're all set!</Text>
        <Text style={styles.subtitle}>
          Your cleaner account is ready. Start tracking your jobs and earnings.
        </Text>
      </View>

      <TouchableOpacity
        style={[styles.primaryBtn, loading && { opacity: 0.6 }]}
        onPress={handleEnter}
        activeOpacity={0.8}
        disabled={loading}
      >
        {loading ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <>
            <Text style={styles.primaryBtnText}>Enter Portfolio Pigeon</Text>
            <Ionicons name="arrow-forward" size={18} color="#fff" />
          </>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg, padding: Spacing.lg, paddingTop: 60 },
  content: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  progress: { flexDirection: 'row', justifyContent: 'center', gap: Spacing.sm, marginBottom: Spacing.xl, position: 'absolute', top: 0, left: 0, right: 0 },
  dot: { width: 8, height: 8, borderRadius: Radius.pill, backgroundColor: Colors.border },
  dotActive: { backgroundColor: Colors.green, width: 24 },
  checkCircle: {
    width: 96, height: 96, borderRadius: 48, backgroundColor: Colors.green,
    alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.lg,
    ...Platform.select({
      ios: { shadowColor: Colors.green, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 16 },
    }),
  },
  title: { fontSize: FontSize.xxl, fontWeight: '700', color: Colors.text, marginBottom: Spacing.sm },
  subtitle: { fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22 },
  primaryBtn: {
    backgroundColor: Colors.green, borderRadius: Radius.lg,
    padding: Spacing.md + 2, alignItems: 'center', marginBottom: Spacing.lg,
    flexDirection: 'row', justifyContent: 'center', gap: Spacing.sm,
    ...Platform.select({
      ios: { shadowColor: Colors.primary, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 20 },
    }),
  },
  primaryBtnText: { color: '#FFFFFF', fontSize: FontSize.md, fontWeight: '600' },
});
