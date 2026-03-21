import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform, Alert,
  ActivityIndicator, ScrollView, Linking,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { useUserStore } from '../../store/userStore';
import {
  getProductPrices, purchaseProduct, restorePurchases,
  ProductPricing, checkProEntitlement, isCustomerEntitled,
} from '../../services/revenueCat';
import { glassAlert } from '../../components/GlassAlert';

const TERMS_URL = 'https://portfoliopigeon.com/terms';
const PRIVACY_URL = 'https://portfoliopigeon.com/privacy';

export function CleanerBillingScreen({ navigation }: any) {
  const profile = useUserStore(s => s.profile);
  const setProfile = useUserStore(s => s.setProfile);
  const isActive = profile?.isSubscriptionActive || profile?.isFounder || profile?.lifetimeFree;

  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [plan, setPlan] = useState<'monthly' | 'yearly'>('monthly');
  const [pricing, setPricing] = useState<ProductPricing>({ monthly: null, yearly: null });

  useEffect(() => {
    if (isActive) navigation.replace('CleanerPlaid');
  }, [isActive]);

  useEffect(() => {
    getProductPrices('cleaner').then(setPricing);
  }, []);

  const monthlyPrice = pricing.monthly?.priceString || '$7.99';
  const yearlyPrice = pricing.yearly?.priceString || '$59.99';
  const yearlyMonthly = pricing.yearly?.monthlyEquivalent || '$5.00';

  const handleSubscribe = async () => {
    setLoading(true);
    try {
      const pkg = plan === 'yearly' ? pricing.yearly?.pkg : pricing.monthly?.pkg;
      if (!pkg) {
        glassAlert('Error', 'Products not yet loaded. Please try again.');
        return;
      }
      const customerInfo = await purchaseProduct(pkg);
      if (isCustomerEntitled(customerInfo)) {
        await setProfile({ isSubscriptionActive: true });
        navigation.replace('CleanerPlaid');
      }
    } catch (e: any) {
      if (e?.userCancelled) return;
      // User may already be subscribed — check entitlements directly
      const isActive = await checkProEntitlement();
      if (isActive) {
        await setProfile({ isSubscriptionActive: true });
        navigation.replace('CleanerPlaid');
      } else {
        glassAlert('Error', e?.message || 'Purchase failed.');
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
        glassAlert('Restored', 'Your subscription has been restored.');
        navigation.replace('CleanerPlaid');
        return;
      }
      // Fallback: check entitlements directly
      const isActive = await checkProEntitlement();
      if (isActive) {
        await setProfile({ isSubscriptionActive: true });
        glassAlert('Restored', 'Your subscription has been restored.');
        navigation.replace('CleanerPlaid');
      } else {
        glassAlert('No Purchases Found', 'We could not find any previous purchases to restore.');
      }
    } catch {
      glassAlert('Error', 'Could not restore purchases.');
    } finally {
      setRestoring(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      <TouchableOpacity activeOpacity={0.7}
        style={styles.backBtn} onPress={() => navigation.goBack()}>
        <Ionicons name="chevron-back" size={20} color={Colors.primary} />
        <Text style={styles.backText}>Back</Text>
      </TouchableOpacity>

      <View style={styles.progress}>
        {[1, 2, 3, 4].map(s => (
          <View key={s} style={[styles.dot, s <= 4 && styles.dotActive]} />
        ))}
      </View>

      <View style={styles.hero}>
        <View style={styles.iconCircle}>
          <Ionicons name="diamond-outline" size={36} color={Colors.primary} />
        </View>
        <Text style={styles.title}>Cleaner Pro</Text>
        <View style={styles.trialBadge}>
          <Ionicons name="gift-outline" size={14} color={Colors.green} />
          <Text style={styles.trialText}>Free trial included</Text>
        </View>
      </View>

      {/* Plan toggle */}
      <View style={styles.planToggle}>
        <TouchableOpacity
          activeOpacity={0.7}
          style={[styles.planOption, plan === 'monthly' && styles.planOptionActive]}
          onPress={() => setPlan('monthly')}
        >
          <Text style={[styles.planLabel, plan === 'monthly' && styles.planLabelActive]}>Monthly</Text>
          <Text style={[styles.planPrice, plan === 'monthly' && styles.planPriceActive]}>{monthlyPrice}/mo</Text>
        </TouchableOpacity>
        <TouchableOpacity
          activeOpacity={0.7}
          style={[styles.planOption, plan === 'yearly' && styles.planOptionActive]}
          onPress={() => setPlan('yearly')}
        >
          <Text style={[styles.planLabel, plan === 'yearly' && styles.planLabelActive]}>Yearly</Text>
          <Text style={[styles.planPrice, plan === 'yearly' && styles.planPriceActive]}>{yearlyPrice}/yr</Text>
          <Text style={[styles.planSavings, plan === 'yearly' && { color: '#fff' }]}>{yearlyMonthly}/mo</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.features}>
        {[
          'Follow unlimited hosts & calendars',
          'Track all your cleanings',
          'Expense tracking & Plaid bank sync',
          'Send invoices to hosts',
        ].map((feature, i) => (
          <View key={i} style={styles.featureRow}>
            <Ionicons name="checkmark-circle" size={18} color={Colors.green} />
            <Text style={styles.featureText}>{feature}</Text>
          </View>
        ))}
      </View>

      <View style={styles.buttons}>
        <TouchableOpacity
          style={[styles.primaryBtn, loading && { opacity: 0.6 }]}
          onPress={handleSubscribe}
          activeOpacity={0.8}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.primaryBtnText}>Start Free Trial</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.restoreBtn}
          onPress={handleRestore}
          activeOpacity={0.7}
          disabled={restoring}
        >
          <Text style={styles.restoreText}>{restoring ? 'Restoring...' : 'Restore Purchases'}</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.skipBtn} onPress={() => navigation.navigate('CleanerDone')} activeOpacity={0.8}>
          <Text style={styles.skipText}>Skip for now</Text>
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
  contentContainer: { padding: Spacing.lg, paddingTop: 60, paddingBottom: 40 },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, marginBottom: Spacing.lg },
  backText: { fontSize: FontSize.md, color: Colors.primary },
  progress: { flexDirection: 'row', justifyContent: 'center', gap: Spacing.sm, marginBottom: Spacing.xl },
  dot: { width: 8, height: 8, borderRadius: Radius.pill, backgroundColor: Colors.border },
  dotActive: { backgroundColor: Colors.green, width: 24 },
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
  planOptionActive: { borderColor: Colors.green, backgroundColor: Colors.green },
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
  finePrint: { textAlign: 'center', fontSize: FontSize.xs, color: Colors.textDim, marginTop: Spacing.xs },
  link: { color: Colors.primary, textDecorationLine: 'underline' },
});
