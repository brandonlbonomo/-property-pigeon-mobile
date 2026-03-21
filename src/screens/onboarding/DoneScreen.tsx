import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, Alert, ActivityIndicator } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { useOnboardingStore } from '../../store/onboardingStore';
import { useUserStore } from '../../store/userStore';
import { apiRegister, apiFetch } from '../../services/api';
import { identifyUser } from '../../services/revenueCat';

const TYPE_LABELS: Record<string, string> = {
  str: 'Short-Term Rentals',
  ltr: 'Long-Term Rentals',
  both: 'Mixed Portfolio',
};

const PROJECTION_LABELS: Record<string, string> = {
  conservative: 'Conservative',
  normal: 'Normal',
  bullish: 'Bullish',
};

export function DoneScreen() {
  const complete = useOnboardingStore(s => s.complete);
  const portfolioType = useOnboardingStore(s => s.portfolioType);
  const setBiometric = useOnboardingStore(s => s.setBiometric);
  const pendingCredentials = useOnboardingStore(s => s.pendingCredentials);
  const profile = useUserStore(s => s.profile);
  const setProfile = useUserStore(s => s.setProfile);
  const fetchBillingStatus = useUserStore(s => s.fetchBillingStatus);
  const activateData = useUserStore(s => s.activateData);
  const [biometricPrompted, setBiometricPrompted] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    promptBiometric();
  }, []);

  const promptBiometric = async () => {
    if (biometricPrompted) return;
    setBiometricPrompted(true);
    try {
      const compatible = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      if (compatible && enrolled) {
        Alert.alert(
          'Enable Face ID',
          'Would you like to enable Face ID for quick sign-in?',
          [
            { text: 'Not Now', style: 'cancel' },
            { text: 'Enable', onPress: () => setBiometric(true) },
          ]
        );
      }
    } catch {
      // Biometric not available
    }
  };

  const propertyCount = profile?.properties?.length ?? 0;
  const typeLabel = TYPE_LABELS[portfolioType || ''] || 'Portfolio';
  const projLabel = PROJECTION_LABELS[profile?.projectionStyle || ''] || '';

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

      // 4. Sync properties to backend
      if (profile?.properties && profile.properties.length > 0) {
        try {
          await apiFetch('/api/props', {
            method: 'POST',
            body: JSON.stringify({ props: profile.properties }),
          });
        } catch {
          // Non-critical — properties can be re-synced later
        }
      }

      // 5. Trigger iCal sync if any properties have iCal URLs
      const hasIcalUrls = profile?.properties?.some(p => p.icalUrls?.some(u => u));
      if (hasIcalUrls) {
        try {
          await apiFetch('/api/ical/sync', { method: 'POST' });
        } catch {
          // Non-critical
        }
      }

      // 6. Fetch billing status (now that we have auth)
      await fetchBillingStatus();

      // 7. Activate data fetching
      await activateData();

      // 8. Complete onboarding
      await complete(portfolioType);
    } catch (e: any) {
      Alert.alert('Registration Failed', e?.serverError || e?.message || 'Could not create your account. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        {/* Checkmark */}
        <View style={styles.checkCircle}>
          <Ionicons name="checkmark" size={48} color="#fff" />
        </View>

        <Text style={styles.title}>You're all set!</Text>

        <Text style={styles.summary}>
          {propertyCount} {propertyCount === 1 ? 'property' : 'properties'}
          {' \u2022 '}{typeLabel}
          {projLabel ? ` \u2022 ${projLabel}` : ''}
        </Text>

        <View style={styles.detailCard}>
          {profile?.username && (
            <View style={styles.detailRow}>
              <Ionicons name="person-outline" size={16} color={Colors.textSecondary} />
              <Text style={styles.detailText}>{profile.username}</Text>
            </View>
          )}
          {profile?.email && (
            <View style={styles.detailRow}>
              <Ionicons name="mail-outline" size={16} color={Colors.textSecondary} />
              <Text style={styles.detailText}>{profile.email}</Text>
            </View>
          )}
          {propertyCount > 0 && (
            <View style={styles.detailRow}>
              <Ionicons name="home-outline" size={16} color={Colors.textSecondary} />
              <Text style={styles.detailText}>
                {profile!.properties.map(p => p.name).join(', ')}
              </Text>
            </View>
          )}
        </View>
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
  checkCircle: {
    width: 96, height: 96, borderRadius: 48, backgroundColor: Colors.green,
    alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.lg,
    ...Platform.select({
      ios: { shadowColor: Colors.green, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 16 },
    }),
  },
  title: { fontSize: FontSize.xxl, fontWeight: '700', color: Colors.text, marginBottom: Spacing.sm },
  summary: { fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22 },
  detailCard: {
    backgroundColor: Colors.glassHeavy, borderWidth: 0.5, borderColor: Colors.glassBorder,
    borderRadius: Radius.lg, padding: Spacing.md, marginTop: Spacing.lg, width: '100%',
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.12, shadowRadius: 10 },
    }),
  },
  detailRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingVertical: 6 },
  detailText: { fontSize: FontSize.sm, color: Colors.text, flex: 1 },
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
