import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform, Alert,
  ActivityIndicator, ScrollView, Linking,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../constants/theme';
import { useUserStore } from '../store/userStore';
import {
  getProductPrices, purchaseProduct, restorePurchases,
  ProductPricing, checkProEntitlement, isCustomerEntitled,
} from '../services/revenueCat';
import { navigationRef } from '../navigation/navigationRef';

const TERMS_URL = 'https://portfoliopigeon.com/terms';
const PRIVACY_URL = 'https://portfoliopigeon.com/privacy';

export type PaywallResult = 'purchased' | 'restored' | 'cancelled';

// ── Global imperative API ──
let _resolve: ((result: PaywallResult) => void) | null = null;

export function showProPaywall(): Promise<PaywallResult> {
  return new Promise(resolve => {
    _resolve = resolve;
    if (navigationRef.isReady()) {
      navigationRef.navigate('ProPaywall' as never);
    } else {
      resolve('cancelled');
      _resolve = null;
    }
  });
}

export function resolvePaywall(result: PaywallResult) {
  _resolve?.(result);
  _resolve = null;
}

const OWNER_FEATURES = [
  'Unlimited properties & data sources',
  'Full financial dashboard & projections',
  'Plaid bank connections & auto-sync',
  'Calendar, inventory & cleaning management',
];

const CLEANER_FEATURES = [
  'Follow unlimited hosts & calendars',
  'Track all your cleanings',
  'Expense tracking & Plaid bank sync',
  'Send invoices to hosts',
];

export function ProPaywallScreen() {
  const insets = useSafeAreaInsets();
  const profile = useUserStore(s => s.profile);
  const setProfile = useUserStore(s => s.setProfile);
  const fetchBillingStatus = useUserStore(s => s.fetchBillingStatus);
  const accountType = profile?.accountType;
  const isCleaner = accountType === 'cleaner';

  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [loadingPrices, setLoadingPrices] = useState(true);
  const [plan, setPlan] = useState<'monthly' | 'yearly'>('monthly');
  const [pricing, setPricing] = useState<ProductPricing>({ monthly: null, yearly: null });

  // Fetch prices on mount
  useEffect(() => {
    getProductPrices(isCleaner ? 'cleaner' : 'owner')
      .then(setPricing)
      .finally(() => setLoadingPrices(false));
  }, [isCleaner]);

  const dismiss = useCallback((result: PaywallResult) => {
    resolvePaywall(result);
    if (navigationRef.isReady() && navigationRef.canGoBack()) {
      navigationRef.goBack();
    }
  }, []);

  const planName = isCleaner ? 'Cleaner Pro' : 'Portfolio Pigeon Pro';
  const features = isCleaner ? CLEANER_FEATURES : OWNER_FEATURES;
  const monthlyPrice = pricing.monthly?.priceString || (isCleaner ? '$7.99' : '$12.99');
  const yearlyPrice = pricing.yearly?.priceString || (isCleaner ? '$59.99' : '$99.99');
  const yearlyMonthly = pricing.yearly?.monthlyEquivalent || (isCleaner ? '$5.00' : '$8.33');

  const handleSubscribe = async () => {
    const pkg = plan === 'yearly' ? pricing.yearly?.pkg : pricing.monthly?.pkg;
    if (!pkg) {
      Alert.alert('Products Loading', 'Please wait a moment and try again.');
      return;
    }
    setLoading(true);
    try {
      const customerInfo = await purchaseProduct(pkg);
      if (isCustomerEntitled(customerInfo)) {
        await setProfile({ isSubscriptionActive: true });
        await fetchBillingStatus();
        dismiss('purchased');
      }
    } catch (e: any) {
      if (e?.userCancelled) return;
      // User may already be subscribed — StoreKit throws when re-purchasing.
      const isActive = await checkProEntitlement();
      if (isActive) {
        await setProfile({ isSubscriptionActive: true });
        await fetchBillingStatus();
        dismiss('restored');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleRestore = async () => {
    setRestoring(true);
    try {
      const info = await restorePurchases();
      if (info && isCustomerEntitled(info)) {
        await setProfile({ isSubscriptionActive: true });
        await fetchBillingStatus();
        dismiss('restored');
        return;
      }
      // Fallback: restorePurchases may return info without the expected entitlement key
      // but the entitlement could still be active
      const isActive = await checkProEntitlement();
      if (isActive) {
        await setProfile({ isSubscriptionActive: true });
        await fetchBillingStatus();
        dismiss('restored');
      } else {
        Alert.alert('No Purchases Found', 'We could not find any previous purchases to restore.');
      }
    } catch {
      Alert.alert('Error', 'Could not restore purchases. Please try again.');
    } finally {
      setRestoring(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={[styles.content, { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 40 }]}>
      <TouchableOpacity activeOpacity={0.7} style={styles.closeBtn}
        onPress={() => dismiss('cancelled')}>
        <Ionicons name="close" size={24} color={Colors.textSecondary} />
      </TouchableOpacity>

      <View style={styles.hero}>
        <View style={styles.iconCircle}>
          <Ionicons name="diamond-outline" size={36} color={Colors.primary} />
        </View>
        <Text style={styles.title}>{planName}</Text>
        <View style={styles.trialBadge}>
          <Ionicons name="gift-outline" size={14} color={Colors.green} />
          <Text style={styles.trialText}>Free trial included</Text>
        </View>
      </View>

      <View style={styles.planToggle}>
        <TouchableOpacity activeOpacity={0.7}
          style={[styles.planOption, plan === 'monthly' && styles.planOptionActive]}
          onPress={() => setPlan('monthly')}>
          <Text style={[styles.planLabel, plan === 'monthly' && styles.planLabelActive]}>Monthly</Text>
          <Text style={[styles.planPrice, plan === 'monthly' && styles.planPriceActive]}>{monthlyPrice}/mo</Text>
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.7}
          style={[styles.planOption, plan === 'yearly' && styles.planOptionActive]}
          onPress={() => setPlan('yearly')}>
          <Text style={[styles.planLabel, plan === 'yearly' && styles.planLabelActive]}>Yearly</Text>
          <Text style={[styles.planPrice, plan === 'yearly' && styles.planPriceActive]}>{yearlyPrice}/yr</Text>
          <Text style={[styles.planSavings, plan === 'yearly' && { color: '#fff' }]}>{yearlyMonthly}/mo</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.features}>
        {features.map((f, i) => (
          <View key={i} style={styles.featureRow}>
            <Ionicons name="checkmark-circle" size={18} color={Colors.green} />
            <Text style={styles.featureText}>{f}</Text>
          </View>
        ))}
      </View>

      <View style={styles.buttons}>
        <TouchableOpacity
          style={[styles.primaryBtn, (loading || loadingPrices) && { opacity: 0.6 }]}
          onPress={handleSubscribe}
          activeOpacity={0.8}
          disabled={loading || loadingPrices}>
          {loading || loadingPrices ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.primaryBtnText}>Start Free Trial</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity style={styles.restoreBtn} onPress={handleRestore}
          activeOpacity={0.7} disabled={restoring}>
          <Text style={styles.restoreText}>{restoring ? 'Restoring...' : 'Restore Purchases'}</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.skipBtn} onPress={() => dismiss('cancelled')} activeOpacity={0.8}>
          <Text style={styles.skipText}>Not now</Text>
        </TouchableOpacity>

        <Text style={styles.disclosure}>
          Payment will be charged to your Apple ID account at the confirmation of purchase.
          Subscription automatically renews unless it is canceled at least 24 hours before
          the end of the current period. Your account will be charged for renewal within
          24 hours prior to the end of the current period. You can manage and cancel your
          subscriptions by going to your account settings on the App Store after purchase.{'\n\n'}
          <Text style={styles.link} onPress={() => Linking.openURL(TERMS_URL)}>Terms of Use</Text>
          {'  |  '}
          <Text style={styles.link} onPress={() => Linking.openURL(PRIVACY_URL)}>Privacy Policy</Text>
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  content: { padding: Spacing.lg, paddingBottom: 40 },
  closeBtn: {
    alignSelf: 'flex-end', width: 36, height: 36, borderRadius: 18,
    backgroundColor: Colors.glassHeavy, alignItems: 'center', justifyContent: 'center',
    marginBottom: Spacing.md,
  },
  hero: { alignItems: 'center', marginBottom: Spacing.lg },
  iconCircle: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: Colors.greenDim, alignItems: 'center', justifyContent: 'center',
    marginBottom: Spacing.md,
  },
  title: { fontSize: FontSize.xxl, fontWeight: '700', color: Colors.text, marginBottom: Spacing.xs },
  trialBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: Colors.greenDim, borderRadius: Radius.pill,
    paddingHorizontal: Spacing.md, paddingVertical: 6, marginTop: Spacing.md,
  },
  trialText: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.green },
  planToggle: { flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.lg },
  planOption: {
    flex: 1, padding: Spacing.md, borderRadius: Radius.lg,
    borderWidth: 2, borderColor: Colors.border, alignItems: 'center',
  },
  planOptionActive: { borderColor: Colors.primary, backgroundColor: Colors.green },
  planLabel: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  planLabelActive: { color: '#fff' },
  planPrice: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, marginTop: 2 },
  planPriceActive: { color: '#fff' },
  planSavings: { fontSize: FontSize.xs, color: Colors.textDim, marginTop: 2 },
  features: { gap: Spacing.md, marginBottom: Spacing.xl },
  featureRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  featureText: { fontSize: FontSize.md, color: Colors.text, flex: 1 },
  buttons: { gap: Spacing.sm },
  primaryBtn: {
    backgroundColor: Colors.green, borderRadius: Radius.lg,
    padding: Spacing.md + 2, alignItems: 'center',
    ...Platform.select({
      ios: { shadowColor: Colors.primary, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 20 },
    }),
  },
  primaryBtnText: { color: '#FFFFFF', fontSize: FontSize.md, fontWeight: '600' },
  restoreBtn: { alignItems: 'center', padding: Spacing.sm },
  restoreText: { color: Colors.primary, fontSize: FontSize.sm, fontWeight: '500' },
  skipBtn: { alignItems: 'center', padding: Spacing.sm },
  skipText: { color: Colors.textDim, fontSize: FontSize.sm },
  disclosure: { fontSize: 9, color: Colors.textDim, textAlign: 'center', lineHeight: 13, marginTop: Spacing.sm },
  link: { color: Colors.primary, textDecorationLine: 'underline' },
});
