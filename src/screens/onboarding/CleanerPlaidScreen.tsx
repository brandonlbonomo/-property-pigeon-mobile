import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform, Alert, ActivityIndicator,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { useUserStore } from '../../store/userStore';
import { useDataStore } from '../../store/dataStore';
import { useSubscriptionGate } from '../../hooks/useSubscriptionGate';
import { useProCheckout } from '../../hooks/useProCheckout';
import type { PaywallResult } from '../../hooks/useProCheckout';
import { apiFetch } from '../../services/api';
import { PlaidLinkModal } from '../../components/PlaidLink';


export function CleanerPlaidScreen({ navigation }: any) {
  const setProfile = useUserStore(s => s.setProfile);
  const activateData = useUserStore(s => s.activateData);
  const invalidateAll = useDataStore(s => s.invalidateAll);
  const { isReadOnly } = useSubscriptionGate();
  const checkout = useProCheckout();

  const [plaidLoading, setPlaidLoading] = useState(false);
  const [plaidLinkToken, setPlaidLinkToken] = useState('');
  const [showPlaidLink, setShowPlaidLink] = useState(false);
  const [plaidConnected, setPlaidConnected] = useState(false);
  const [plaidAccountName, setPlaidAccountName] = useState('');

  const handleStartPlaid = async () => {
    if (isReadOnly) {
      const result = await checkout.startCheckout();
      if (result !== 'purchased' && result !== 'restored') return;
    }
    setPlaidLoading(true);
    try {
      const res = await apiFetch('/api/create-link-token', { method: 'POST' });
      if (res.link_token) {
        setPlaidLinkToken(res.link_token);
        setShowPlaidLink(true);
      } else {
        Alert.alert('Error', res.error || 'Could not create Plaid link token.');
      }
    } catch {
      Alert.alert('Connection Error', 'Could not connect to Plaid. Please try again later.');
    } finally {
      setPlaidLoading(false);
    }
  };

  const handlePlaidSuccess = async (publicToken: string, accountName: string) => {
    setShowPlaidLink(false);
    setPlaidLoading(true);
    try {
      const result = await apiFetch('/api/exchange-token', {
        method: 'POST',
        body: JSON.stringify({ public_token: publicToken, account_name: accountName }),
      });
      if (result?.item_id) {
        try { await apiFetch('/api/transactions/historical', { method: 'POST', body: JSON.stringify({ item_id: result.item_id }) }); } catch { /* ok */ }
      }
      try { await apiFetch('/api/transactions/sync', { method: 'POST' }); } catch { /* ok */ }
      await setProfile({ plaidConnected: true });
      await activateData();
      invalidateAll();
      setPlaidConnected(true);
      setPlaidAccountName(accountName);
    } catch {
      Alert.alert('Error', 'Could not complete bank connection. Please try again.');
    } finally {
      setPlaidLoading(false);
    }
  };

  const handlePlaidExit = (error?: any) => {
    setShowPlaidLink(false);
    if (error?.error_message) {
      Alert.alert('Plaid', error.error_message);
    }
  };

  return (
    <View style={styles.container}>
      <TouchableOpacity activeOpacity={0.7}
          style={styles.backBtn} onPress={() => navigation.goBack()}>
        <Ionicons name="chevron-back" size={20} color={Colors.primary} />
        <Text style={styles.backText}>Back</Text>
      </TouchableOpacity>

      {/* Progress: 3 of 4 */}
      <View style={styles.progress}>
        {[1, 2, 3, 4].map(s => (
          <View key={s} style={[styles.dot, s <= 3 && styles.dotActive]} />
        ))}
      </View>

      <Text style={styles.title}>Connect your bank</Text>
      <Text style={styles.subtitle}>
        Link your bank account to track income and expenses automatically.
      </Text>

      {/* Subscription note */}
      <View style={styles.priceCard}>
        <Ionicons name="card-outline" size={22} color={Colors.primary} />
        <View style={{ flex: 1 }}>
          <Text style={styles.priceTitle}>$12.99/month</Text>
          <Text style={styles.priceDesc}>Includes bank sync, expense tracking, and reporting</Text>
        </View>
      </View>

      {/* Plaid connection */}
      <View style={styles.plaidSection}>
        {plaidConnected ? (
          <View style={styles.connectedCard}>
            <Ionicons name="checkmark-circle" size={24} color={Colors.green} />
            <View style={{ flex: 1 }}>
              <Text style={styles.connectedTitle}>{plaidAccountName}</Text>
              <Text style={styles.connectedSub}>Bank account connected</Text>
            </View>
          </View>
        ) : (
          <TouchableOpacity
            style={[styles.plaidBtn, plaidLoading && { opacity: 0.6 }]}
            onPress={handleStartPlaid}
            disabled={plaidLoading}
            activeOpacity={0.8}
          >
            {plaidLoading ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Ionicons name="link-outline" size={18} color="#fff" />
            )}
            <Text style={styles.plaidBtnText}>
              {plaidLoading ? 'Connecting...' : 'Connect Bank Account'}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.bottom}>
        <TouchableOpacity activeOpacity={0.7}
          style={styles.primaryBtn}
          onPress={() => navigation.navigate('CleanerBilling')}
        >
          <Text style={styles.primaryBtnText}>
            {plaidConnected ? 'Continue' : 'Continue'}
          </Text>
        </TouchableOpacity>
        {!plaidConnected && (
          <TouchableOpacity activeOpacity={0.7}
          style={styles.skipBtn} onPress={() => navigation.navigate('CleanerDone')}>
            <Text style={styles.skipText}>Skip for now</Text>
          </TouchableOpacity>
        )}
      </View>

      <PlaidLinkModal
        visible={showPlaidLink}
        linkToken={plaidLinkToken}
        onSuccess={handlePlaidSuccess}
        onExit={handlePlaidExit}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg, padding: Spacing.lg, paddingTop: 60 },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, marginBottom: Spacing.lg },
  backText: { fontSize: FontSize.md, color: Colors.primary },
  progress: { flexDirection: 'row', justifyContent: 'center', gap: Spacing.sm, marginBottom: Spacing.xl },
  dot: { width: 8, height: 8, borderRadius: Radius.pill, backgroundColor: Colors.border },
  dotActive: { backgroundColor: Colors.primary, width: 24 },
  title: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text, marginBottom: Spacing.xs },
  subtitle: { fontSize: FontSize.sm, color: Colors.textSecondary, marginBottom: Spacing.lg, lineHeight: 20 },

  priceCard: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    backgroundColor: Colors.primaryDim, borderRadius: Radius.lg,
    padding: Spacing.md, marginBottom: Spacing.lg,
    borderWidth: 1, borderColor: Colors.primary + '20',
  },
  priceTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  priceDesc: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },

  plaidSection: { flex: 1 },
  connectedCard: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    backgroundColor: Colors.greenDim, borderRadius: Radius.lg,
    padding: Spacing.md, borderWidth: 1, borderColor: Colors.green + '20',
  },
  connectedTitle: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  connectedSub: { fontSize: FontSize.xs, color: Colors.green, marginTop: 2 },

  plaidBtn: {
    backgroundColor: Colors.primary, borderRadius: Radius.lg,
    padding: Spacing.md + 2, alignItems: 'center',
    flexDirection: 'row', justifyContent: 'center', gap: Spacing.sm,
    ...Platform.select({
      ios: { shadowColor: Colors.primary, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 20 },
    }),
  },
  plaidBtnText: { color: '#fff', fontSize: FontSize.md, fontWeight: '600' },

  bottom: { gap: Spacing.sm, marginBottom: Spacing.lg },
  primaryBtn: {
    backgroundColor: Colors.primary, borderRadius: Radius.lg,
    padding: Spacing.md + 2, alignItems: 'center',
    ...Platform.select({
      ios: { shadowColor: Colors.primary, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 20 },
    }),
  },
  primaryBtnText: { color: '#FFFFFF', fontSize: FontSize.md, fontWeight: '600' },
  skipBtn: { alignItems: 'center', padding: Spacing.sm },
  skipText: { color: Colors.textDim, fontSize: FontSize.sm },
});
