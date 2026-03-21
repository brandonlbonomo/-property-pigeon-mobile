import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, ScrollView, Platform, Alert, ActivityIndicator,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { PaywallResult } from '../../hooks/useProCheckout';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { useUserStore } from '../../store/userStore';
import { apiFetch } from '../../services/api';
import { useSubscriptionGate } from '../../hooks/useSubscriptionGate';
import { useProCheckout } from '../../hooks/useProCheckout';
import { PlaidLinkModal } from '../../components/PlaidLink';
import { glassAlert } from '../../components/GlassAlert';


export function DataSourcesScreen({ navigation }: any) {
  const setProfile = useUserStore(s => s.setProfile);
  const portfolioType = useUserStore(s => s.profile?.portfolioType);

  // Plaid
  const { isReadOnly } = useSubscriptionGate();
  const checkout = useProCheckout();
  const [plaidLoading, setPlaidLoading] = useState(false);
  const [plaidLinkToken, setPlaidLinkToken] = useState('');
  const [showPlaidLink, setShowPlaidLink] = useState(false);
  const [plaidConnected, setPlaidConnected] = useState(false);

  // ── Plaid Link Flow ──

  const handleStartPlaid = async () => {
    // Gate behind subscription
    if (isReadOnly) {
      const result = await checkout.startCheckout();
      if (result !== 'purchased' && result !== 'restored') {
        return; // User didn't subscribe
      }
    }

    // Fetch link token and open Plaid
    setPlaidLoading(true);
    try {
      const res = await apiFetch('/api/create-link-token', { method: 'POST' });
      if (res.link_token) {
        setPlaidLinkToken(res.link_token);
        setShowPlaidLink(true);
      } else {
        glassAlert('Error', res.error || 'Could not create Plaid link token.');
      }
    } catch {
      glassAlert('Connection Error', 'Could not connect to Plaid. Please try again later.');
    } finally {
      setPlaidLoading(false);
    }
  };

  const handlePlaidSuccess = async (publicToken: string, accountName: string) => {
    setShowPlaidLink(false);
    try {
      await apiFetch('/api/exchange-token', {
        method: 'POST',
        body: JSON.stringify({ public_token: publicToken, account_name: accountName }),
      });
      await setProfile({ plaidConnected: true });
      setPlaidConnected(true);
    } catch {
      glassAlert('Error', 'Could not link your bank account. You can try again from Settings.');
    }
  };

  const handleNext = async () => {
    navigation.navigate('Billing');
  };

  const handleSkip = () => {
    navigation.navigate('Billing');
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <TouchableOpacity activeOpacity={0.7}
          style={styles.backBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="chevron-back" size={20} color={Colors.primary} />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>

        <View style={styles.progress}>
          {[1, 2, 3, 4, 5, 6].map(s => (
            <View key={s} style={[styles.dot, s <= 4 && styles.dotActive]} />
          ))}
        </View>

        <Text style={styles.title}>Connect your data</Text>
        <Text style={styles.subtitle}>
          Link your accounts to auto-import data. All sections are optional.
        </Text>

        {/* Plaid */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <View style={[styles.sectionIcon, { backgroundColor: Colors.yellowDim }]}>
              <Ionicons name="card-outline" size={18} color={Colors.yellow} />
            </View>
            <Text style={styles.sectionTitle}>Plaid Banking</Text>
            {plaidConnected && <Ionicons name="checkmark-circle" size={18} color={Colors.green} />}
          </View>
          <Text style={styles.sectionHint}>Track income and expenses across your properties and business.</Text>
          <View style={styles.sectionBody}>
            {!plaidConnected ? (
              <TouchableOpacity activeOpacity={0.7}
                style={styles.plaidBtn}
                onPress={handleStartPlaid}
                disabled={plaidLoading}
              >
                {plaidLoading ? (
                  <ActivityIndicator size="small" color={Colors.primary} />
                ) : (
                  <Ionicons name="link-outline" size={18} color={Colors.primary} />
                )}
                <Text style={styles.plaidBtnText}>
                  {plaidLoading ? 'Connecting...' : 'Connect Bank Account'}
                </Text>
              </TouchableOpacity>
            ) : (
              <Text style={styles.connectedText}>Connected</Text>
            )}
          </View>
        </View>

        <View style={styles.buttons}>
          <TouchableOpacity style={styles.primaryBtn} onPress={handleNext} activeOpacity={0.8}>
            <Text style={styles.primaryBtnText}>Next</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.skipBtn} onPress={handleSkip} activeOpacity={0.8}>
            <Text style={styles.skipText}>Skip All</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      <PlaidLinkModal
        visible={showPlaidLink}
        linkToken={plaidLinkToken}
        onSuccess={handlePlaidSuccess}
        onExit={() => setShowPlaidLink(false)}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  scroll: { flexGrow: 1, padding: Spacing.lg, paddingTop: 60 },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, marginBottom: Spacing.lg },
  backText: { fontSize: FontSize.md, color: Colors.primary },
  progress: { flexDirection: 'row', justifyContent: 'center', gap: Spacing.sm, marginBottom: Spacing.xl },
  dot: { width: 8, height: 8, borderRadius: Radius.pill, backgroundColor: Colors.border },
  dotActive: { backgroundColor: Colors.green, width: 24 },
  title: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text, marginBottom: Spacing.xs },
  subtitle: { fontSize: FontSize.sm, color: Colors.textSecondary, marginBottom: Spacing.lg, lineHeight: 20 },

  section: {
    backgroundColor: Colors.glassHeavy, borderWidth: 0.5, borderColor: Colors.glassBorder,
    borderRadius: Radius.lg, marginBottom: Spacing.md, overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.12, shadowRadius: 10 },
    }),
  },
  sectionHeader: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    padding: Spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border,
  },
  sectionIcon: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  sectionTitle: { flex: 1, fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  sectionBody: { padding: Spacing.md, paddingTop: Spacing.sm },
  sectionHint: { fontSize: FontSize.xs, color: Colors.textDim, lineHeight: 16, paddingHorizontal: Spacing.md, paddingTop: Spacing.sm },
  connectedText: { padding: Spacing.md, fontSize: FontSize.sm, color: Colors.green, fontWeight: '500' },

  input: {
    backgroundColor: Colors.bg, borderWidth: 1, borderColor: Colors.border,
    borderRadius: Radius.md, padding: Spacing.md, color: Colors.text, fontSize: FontSize.md,
  },
  connectBtn: {
    backgroundColor: Colors.green, borderRadius: Radius.md,
    padding: Spacing.sm + 2, alignItems: 'center', marginTop: Spacing.sm,
  },
  connectBtnText: { color: '#fff', fontSize: FontSize.sm, fontWeight: '600' },

  plaidBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
    padding: Spacing.md, borderRadius: Radius.md,
    borderWidth: 1.5, borderColor: Colors.green + '40', borderStyle: 'dashed',
    backgroundColor: Colors.greenDim,
  },
  plaidBtnText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: '600' },

  buttons: { gap: Spacing.sm, marginTop: Spacing.md, marginBottom: Spacing.xl },
  primaryBtn: {
    backgroundColor: Colors.green, borderRadius: Radius.lg,
    padding: Spacing.md + 2, alignItems: 'center',
    ...Platform.select({
      ios: { shadowColor: Colors.primary, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 20 },
    }),
  },
  primaryBtnText: { color: '#FFFFFF', fontSize: FontSize.md, fontWeight: '600' },
  skipBtn: { alignItems: 'center', padding: Spacing.sm },
  skipText: { color: Colors.textDim, fontSize: FontSize.sm },
});
