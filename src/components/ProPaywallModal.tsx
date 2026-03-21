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
import { glassAlert } from './GlassAlert';

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
  'Revenue by host breakdown & analytics',
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

  const selectPlan = (p: 'monthly' | 'yearly') => {
    setPlan(p);
  };

  const planName = isCleaner ? 'Cleaner Pro' : 'Portfolio Pigeon Pro';
  const features = isCleaner ? CLEANER_FEATURES : OWNER_FEATURES;
  const monthlyPrice = pricing.monthly?.priceString || (isCleaner ? '$7.99' : '$12.99');
  const yearlyPrice = pricing.yearly?.priceString || (isCleaner ? '$59.99' : '$99.99');
  const yearlyMonthly = pricing.yearly?.monthlyEquivalent || (isCleaner ? '$5.00' : '$8.33');

  const handleSubscribe = async () => {
    const pkg = plan === 'yearly' ? pricing.yearly?.pkg : pricing.monthly?.pkg;
    if (!pkg) {
      glassAlert('Products Loading', 'Please wait a moment and try again.');
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
      const isActive = await checkProEntitlement();
      if (isActive) {
        await setProfile({ isSubscriptionActive: true });
        await fetchBillingStatus();
        dismiss('restored');
      } else {
        glassAlert('No Purchases Found', 'We could not find any previous purchases to restore.');
      }
    } catch {
      glassAlert('Error', 'Could not restore purchases. Please try again.');
    } finally {
      setRestoring(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={[styles.content, { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 40 }]}>
      <TouchableOpacity activeOpacity={0.7} style={styles.closeBtn}
        onPress={() => dismiss('cancelled')}>
        <Ionicons name="close" size={22} color={Colors.textSecondary} />
      </TouchableOpacity>

      {/* Hero */}
      <View style={styles.hero}>
        <View style={styles.iconCircle}>
          <Ionicons name="diamond-outline" size={32} color={Colors.green} />
        </View>
        <Text style={styles.title}>{planName}</Text>
        <View style={styles.trialBadge}>
          <Ionicons name="gift-outline" size={13} color={Colors.green} />
          <Text style={styles.trialText}>Free trial included</Text>
        </View>
      </View>

      {/* Side-by-side liquid glass plan cards */}
      <View style={styles.planRow}>
        <TouchableOpacity
          activeOpacity={0.7}
          style={[styles.planCard, plan === 'monthly' && styles.planCardActive]}
          onPress={() => selectPlan('monthly')}
        >
          {plan === 'monthly' && <View style={styles.planCardShine} />}
          <Text style={[styles.planCardLabel, plan === 'monthly' && styles.planCardLabelActive]}>Monthly</Text>
          <Text style={[styles.planCardPrice, plan === 'monthly' && styles.planCardPriceActive]}>{monthlyPrice}</Text>
          <Text style={[styles.planCardPeriod, plan === 'monthly' && styles.planCardPeriodActive]}>/month</Text>
        </TouchableOpacity>
        <TouchableOpacity
          activeOpacity={0.7}
          style={[styles.planCard, plan === 'yearly' && styles.planCardActive]}
          onPress={() => selectPlan('yearly')}
        >
          {plan === 'yearly' && <View style={styles.planCardShine} />}
          <View style={styles.saveBadge}>
            <Text style={styles.saveBadgeText}>SAVE 33%</Text>
          </View>
          <Text style={[styles.planCardLabel, plan === 'yearly' && styles.planCardLabelActive]}>Yearly</Text>
          <Text style={[styles.planCardPrice, plan === 'yearly' && styles.planCardPriceActive]}>{yearlyPrice}</Text>
          <Text style={[styles.planCardPeriod, plan === 'yearly' && styles.planCardPeriodActive]}>/year</Text>
          <Text style={[styles.planCardSub, plan === 'yearly' && styles.planCardSubActive]}>{yearlyMonthly}/mo</Text>
        </TouchableOpacity>
      </View>

      {/* Features */}
      <View style={styles.features}>
        {features.map((f, i) => (
          <View key={i} style={styles.featureRow}>
            <View style={styles.featureCheck}>
              <Ionicons name="checkmark" size={14} color={Colors.green} />
            </View>
            <Text style={styles.featureText}>{f}</Text>
          </View>
        ))}
      </View>

      {/* CTA */}
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
  content: { padding: Spacing.lg, alignItems: 'center' },
  closeBtn: {
    alignSelf: 'flex-end', width: 34, height: 34, borderRadius: 17,
    backgroundColor: Colors.glassHeavy, borderWidth: 0.5, borderColor: Colors.glassBorder,
    alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.md,
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 6 },
    }),
  },
  hero: { alignItems: 'center', marginBottom: Spacing.lg },
  iconCircle: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: Colors.glassHeavy, borderWidth: 0.5, borderColor: Colors.glassBorder,
    alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.sm,
    ...Platform.select({
      ios: { shadowColor: Colors.green, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.2, shadowRadius: 12 },
    }),
  },
  title: { fontSize: FontSize.xl, fontWeight: '800', color: Colors.text },
  trialBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: Colors.greenDim, borderRadius: Radius.pill,
    paddingHorizontal: Spacing.sm + 4, paddingVertical: 5, marginTop: Spacing.sm,
  },
  trialText: { fontSize: 12, fontWeight: '700', color: Colors.green },

  // Plan cards — side by side liquid glass
  planRow: {
    flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.lg, width: '100%',
  },
  planCard: {
    flex: 1, alignItems: 'center', paddingVertical: Spacing.lg, paddingHorizontal: Spacing.sm,
    borderRadius: Radius.xl, backgroundColor: Colors.glassHeavy,
    borderWidth: 1.5, borderColor: Colors.glassBorder,
    overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.2, shadowRadius: 10 },
    }),
  },
  planCardActive: {
    borderColor: Colors.green, backgroundColor: Colors.glass,
    borderTopColor: Colors.glassHighlight, borderTopWidth: 2,
    ...Platform.select({
      ios: { shadowColor: Colors.green, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 16 },
    }),
  },
  planCardShine: {
    position: 'absolute', top: 0, left: 0, right: 0, height: '45%',
    backgroundColor: 'rgba(255,255,255,0.4)',
    borderTopLeftRadius: Radius.xl, borderTopRightRadius: Radius.xl,
  },
  planCardLabel: { fontSize: 12, fontWeight: '700', color: Colors.textDim, letterSpacing: 0.5, marginBottom: 4, zIndex: 1 },
  planCardLabelActive: { color: Colors.green },
  planCardPrice: { fontSize: 28, fontWeight: '900', color: Colors.text, letterSpacing: -0.5, zIndex: 1 },
  planCardPriceActive: { color: Colors.text },
  planCardPeriod: { fontSize: 12, fontWeight: '500', color: Colors.textDim, marginTop: 2, zIndex: 1 },
  planCardPeriodActive: { color: Colors.textSecondary },
  planCardSub: { fontSize: 11, fontWeight: '600', color: Colors.textDim, marginTop: 4, zIndex: 1 },
  planCardSubActive: { color: Colors.green },
  saveBadge: {
    position: 'absolute', top: 8, right: 8,
    backgroundColor: Colors.greenDim, borderRadius: Radius.pill,
    paddingHorizontal: 6, paddingVertical: 2, zIndex: 2,
  },
  saveBadgeText: { fontSize: 8, fontWeight: '800', color: Colors.green, letterSpacing: 0.3 },

  // Features
  features: { gap: Spacing.md, marginBottom: Spacing.xl, width: '100%' },
  featureRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  featureCheck: {
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: Colors.greenDim, alignItems: 'center', justifyContent: 'center',
  },
  featureText: { fontSize: FontSize.sm, color: Colors.text, flex: 1, fontWeight: '500' },

  // Buttons
  buttons: { gap: Spacing.sm, width: '100%' },
  primaryBtn: {
    backgroundColor: Colors.green, borderRadius: Radius.lg,
    padding: Spacing.md + 2, alignItems: 'center',
    ...Platform.select({
      ios: { shadowColor: Colors.green, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 16 },
    }),
  },
  primaryBtnText: { color: '#FFFFFF', fontSize: FontSize.md, fontWeight: '700' },
  restoreBtn: { alignItems: 'center', padding: Spacing.sm },
  restoreText: { color: Colors.text, fontSize: FontSize.sm, fontWeight: '600' },
  skipBtn: { alignItems: 'center', padding: Spacing.sm },
  skipText: { color: Colors.textDim, fontSize: FontSize.sm },
  disclosure: { fontSize: 9, color: Colors.textDim, textAlign: 'center', lineHeight: 13, marginTop: Spacing.sm },
  link: { color: Colors.textSecondary, textDecorationLine: 'underline' },
});
