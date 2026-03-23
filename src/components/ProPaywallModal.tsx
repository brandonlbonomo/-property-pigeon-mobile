import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform,
  ActivityIndicator, ScrollView, Linking, Animated, Dimensions, Easing,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
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
const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

export type PaywallResult = 'purchased' | 'restored' | 'cancelled';

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
  { icon: 'home-outline', text: 'Unlimited properties & data sources' },
  { icon: 'bar-chart-outline', text: 'Full financial dashboard & projections' },
  { icon: 'card-outline', text: 'Plaid bank connections & auto-sync' },
  { icon: 'calendar-outline', text: 'Calendar, inventory & cleaning management' },
  { icon: 'trending-up-outline', text: 'Revenue analytics & expense tracking' },
];

const CLEANER_FEATURES = [
  { icon: 'people-outline', text: 'Follow unlimited hosts & calendars' },
  { icon: 'checkbox-outline', text: 'Track all your cleanings & turnovers' },
  { icon: 'analytics-outline', text: 'Revenue by host breakdown & analytics' },
  { icon: 'card-outline', text: 'Expense tracking & Plaid bank sync' },
  { icon: 'document-text-outline', text: 'Generate & send invoices to hosts' },
];

/* ── Floating money symbols ── */
function FloatingSymbol({ symbol, delay, x, duration, startY }: {
  symbol: string; delay: number; x: number; duration: number; startY: number;
}) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const run = () => {
      anim.setValue(0);
      Animated.timing(anim, {
        toValue: 1, duration, delay,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }).start(() => run());
    };
    run();
  }, []);
  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [startY, startY - 120] });
  const opacity = anim.interpolate({ inputRange: [0, 0.1, 0.7, 1], outputRange: [0, 0.12, 0.12, 0] });
  return (
    <Animated.Text style={{
      position: 'absolute', left: x, fontSize: 24, color: '#1ECE6E',
      transform: [{ translateY }], opacity,
    }}>{symbol}</Animated.Text>
  );
}

/* ── Rising graph line drawn with views ── */
function RisingGraph() {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1, duration: 2000, delay: 400,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, []);
  // 18 data points — dramatic hockey-stick growth curve
  const points = [0.92, 0.88, 0.85, 0.83, 0.80, 0.78, 0.74, 0.70, 0.65, 0.58, 0.50, 0.42, 0.34, 0.26, 0.20, 0.15, 0.10, 0.06];
  const barW = (SCREEN_W - 40) / points.length;
  return (
    <View style={{ position: 'absolute', bottom: SCREEN_H * 0.18, left: 20, right: 20, height: 160, flexDirection: 'row', alignItems: 'flex-end' }}>
      {points.map((p, i) => {
        const h = (1 - p) * 140;
        const stagger = (i / points.length) * 0.6;
        const animH = anim.interpolate({
          inputRange: [0, Math.max(0.01, stagger), Math.min(1, stagger + 0.4), 1],
          outputRange: [0, 0, h, h],
        });
        const intensity = 0.03 + (i / points.length) * 0.09;
        return (
          <Animated.View key={i} style={{
            width: barW - 2, height: animH, marginHorizontal: 1,
            borderRadius: 3,
            backgroundColor: `rgba(30,206,110,${intensity})`,
          }} />
        );
      })}
    </View>
  );
}

/* ── Gooey plan toggle ── */
function GooeyPlanToggle({ plan, onSelect, monthlyLabel, yearlyLabel }: {
  plan: 'monthly' | 'yearly';
  onSelect: (p: 'monthly' | 'yearly') => void;
  monthlyLabel: string;
  yearlyLabel: string;
}) {
  // Single animation value drives everything — no sequences, no phases
  const progress = useRef(new Animated.Value(plan === 'yearly' ? 1 : 0)).current;

  useEffect(() => {
    const toVal = plan === 'yearly' ? 1 : 0;
    Animated.timing(progress, {
      toValue: toVal,
      duration: 650,
      easing: Easing.bezier(0.25, 0.1, 0.25, 1),
      useNativeDriver: true,
    }).start();
  }, [plan]);

  const containerW = SCREEN_W - Spacing.lg * 2;
  const blobW = containerW / 2 - 4;
  const blobX = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [4, containerW / 2],
  });
  // Barely-there deformation — just enough to feel alive
  const scaleX = progress.interpolate({
    inputRange: [0, 0.35, 0.5, 0.65, 1],
    outputRange: [1, 1.03, 1.05, 1.03, 1],
  });
  const scaleY = progress.interpolate({
    inputRange: [0, 0.35, 0.5, 0.65, 1],
    outputRange: [1, 0.97, 0.96, 0.97, 1],
  });

  return (
    <View style={gs.container}>
      {/* Sliding blob */}
      <Animated.View style={[
        gs.blob,
        {
          width: blobW,
          transform: [
            { translateX: blobX },
            { scaleX },
            { scaleY },
          ],
        },
      ]}>
        <LinearGradient
          colors={['rgba(30,206,110,0.20)', 'rgba(30,206,110,0.08)']}
          style={[StyleSheet.absoluteFill, { borderRadius: 16 }]}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
        />
      </Animated.View>

      <TouchableOpacity activeOpacity={0.8} style={gs.half} onPress={() => onSelect('monthly')}>
        <Text style={[gs.label, plan === 'monthly' && gs.labelActive]}>{monthlyLabel}</Text>
      </TouchableOpacity>
      <TouchableOpacity activeOpacity={0.8} style={gs.half} onPress={() => onSelect('yearly')}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={[gs.label, plan === 'yearly' && gs.labelActive]}>{yearlyLabel}</Text>
          <View style={gs.savePill}>
            <Text style={gs.saveText}>-33%</Text>
          </View>
        </View>
      </TouchableOpacity>
    </View>
  );
}

const gs = StyleSheet.create({
  container: {
    flexDirection: 'row', height: 48, borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)',
    marginBottom: Spacing.lg, overflow: 'hidden',
  },
  blob: {
    position: 'absolute', top: 4, bottom: 4, borderRadius: 14,
    borderWidth: 1, borderColor: 'rgba(30,206,110,0.30)',
    ...Platform.select({
      ios: { shadowColor: '#1ECE6E', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 12 },
    }),
  },
  half: {
    flex: 1, alignItems: 'center', justifyContent: 'center', zIndex: 1,
  },
  label: {
    fontSize: FontSize.sm, fontWeight: '600', color: 'rgba(255,255,255,0.30)',
  },
  labelActive: { color: '#fff', fontWeight: '700' },
  savePill: {
    backgroundColor: 'rgba(30,206,110,0.20)',
    borderRadius: Radius.pill, paddingHorizontal: 6, paddingVertical: 2,
  },
  saveText: { fontSize: 9, fontWeight: '800', color: Colors.green },
});

/* ── Main Paywall Screen ── */
export function ProPaywallScreen() {
  const insets = useSafeAreaInsets();
  const profile = useUserStore(s => s.profile);
  const setProfile = useUserStore(s => s.setProfile);
  const fetchBillingStatus = useUserStore(s => s.fetchBillingStatus);
  const isCleaner = profile?.accountType === 'cleaner';

  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [loadingPrices, setLoadingPrices] = useState(true);
  const [plan, setPlan] = useState<'monthly' | 'yearly'>('yearly');
  const [pricing, setPricing] = useState<ProductPricing>({ monthly: null, yearly: null });

  // Animations
  const heroScale = useRef(new Animated.Value(0.85)).current;
  const heroOpacity = useRef(new Animated.Value(0)).current;
  const contentSlide = useRef(new Animated.Value(40)).current;
  const contentOpacity = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    getProductPrices(isCleaner ? 'cleaner' : 'owner')
      .then(setPricing)
      .finally(() => setLoadingPrices(false));

    Animated.sequence([
      Animated.parallel([
        Animated.spring(heroScale, { toValue: 1, friction: 6, tension: 80, useNativeDriver: true }),
        Animated.timing(heroOpacity, { toValue: 1, duration: 500, useNativeDriver: true }),
      ]),
      Animated.parallel([
        Animated.spring(contentSlide, { toValue: 0, friction: 8, tension: 50, useNativeDriver: true }),
        Animated.timing(contentOpacity, { toValue: 1, duration: 400, useNativeDriver: true }),
      ]),
    ]).start();

    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.03, duration: 1800, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 1800, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
      ])
    ).start();
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
  const displayPrice = plan === 'yearly' ? yearlyPrice : monthlyPrice;
  const displayPeriod = plan === 'yearly' ? '/year' : '/month';

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
    <View style={{ flex: 1 }}>
      {/* Deep dark gradient */}
      <LinearGradient
        colors={['#050f08', '#0a1a0f', '#0d2818', '#0a1a0f', '#050f08']}
        style={StyleSheet.absoluteFill}
        start={{ x: 0.3, y: 0 }}
        end={{ x: 0.7, y: 1 }}
      />

      {/* Ambient glow orbs */}
      <View style={s.glowOrb1} />
      <View style={s.glowOrb2} />

      {/* Floating money symbols */}
      <FloatingSymbol symbol="$" delay={0} x={SCREEN_W * 0.08} duration={6000} startY={SCREEN_H * 0.55} />
      <FloatingSymbol symbol="$" delay={1500} x={SCREEN_W * 0.85} duration={7000} startY={SCREEN_H * 0.60} />
      <FloatingSymbol symbol="$" delay={3000} x={SCREEN_W * 0.45} duration={5500} startY={SCREEN_H * 0.50} />
      <FloatingSymbol symbol="$" delay={800} x={SCREEN_W * 0.25} duration={6500} startY={SCREEN_H * 0.65} />
      <FloatingSymbol symbol="$" delay={2200} x={SCREEN_W * 0.70} duration={5800} startY={SCREEN_H * 0.58} />

      {/* Rising bar graph */}
      <RisingGraph />

      <ScrollView
        contentContainerStyle={[s.content, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 40 }]}
        showsVerticalScrollIndicator={false}
        {...({delaysContentTouches: false} as any)}
      >
        {/* Close */}
        <TouchableOpacity activeOpacity={0.7} style={s.closeBtn} onPress={() => dismiss('cancelled')}>
          <Ionicons name="close" size={20} color="rgba(255,255,255,0.5)" />
        </TouchableOpacity>

        {/* Hero */}
        <Animated.View style={[s.hero, { opacity: heroOpacity, transform: [{ scale: heroScale }] }]}>
          <View style={s.diamondWrap}>
            <LinearGradient
              colors={['#1ECE6E', '#16A34A', '#059669']}
              style={s.diamondGradient}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
            />
            <Ionicons name="diamond" size={28} color="#fff" style={{ zIndex: 1 }} />
            <View style={s.diamondGlow} />
          </View>
          <Text style={s.title}>{planName}</Text>
          <Text style={s.subtitle}>Unlock the full power of your portfolio</Text>
          <View style={s.trialPill}>
            <View style={s.trialDot} />
            <Text style={s.trialText}>Free trial included</Text>
          </View>
        </Animated.View>

        {/* Gooey toggle */}
        <Animated.View style={{ width: '100%', opacity: contentOpacity, transform: [{ translateY: contentSlide }] }}>
          <GooeyPlanToggle
            plan={plan}
            onSelect={setPlan}
            monthlyLabel="Monthly"
            yearlyLabel="Yearly"
          />

          {/* Price display */}
          <View style={s.priceBlock}>
            <Text style={s.priceAmount}>{displayPrice}</Text>
            <Text style={s.pricePeriod}>{displayPeriod}</Text>
            {plan === 'yearly' && (
              <Text style={s.priceEquiv}>just {yearlyMonthly}/mo</Text>
            )}
          </View>

          {/* Features */}
          <View style={s.featuresWrap}>
            {features.map((f, i) => (
              <View key={i} style={s.featureRow}>
                <View style={s.featureIconWrap}>
                  <Ionicons name={f.icon as any} size={15} color={Colors.green} />
                </View>
                <Text style={s.featureText}>{f.text}</Text>
              </View>
            ))}
          </View>

          {/* CTA */}
          <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
            <TouchableOpacity
              style={[s.ctaBtn, (loading || loadingPrices) && { opacity: 0.6 }]}
              onPress={handleSubscribe}
              activeOpacity={0.85}
              disabled={loading || loadingPrices}
            >
              <LinearGradient
                colors={['#22D974', '#1ECE6E', '#16A34A']}
                style={[StyleSheet.absoluteFill, { borderRadius: Radius.xl }]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
              />
              {loading || loadingPrices ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Ionicons name="sparkles" size={18} color="#fff" />
                  <Text style={s.ctaText}>Start Free Trial</Text>
                </>
              )}
              <View style={s.ctaShine} />
            </TouchableOpacity>
          </Animated.View>

          <TouchableOpacity style={s.restoreBtn} onPress={handleRestore}
            activeOpacity={0.7} disabled={restoring}>
            <Text style={s.restoreText}>{restoring ? 'Restoring...' : 'Restore Purchases'}</Text>
          </TouchableOpacity>

          <TouchableOpacity style={s.skipBtn} onPress={() => dismiss('cancelled')} activeOpacity={0.8}>
            <Text style={s.skipText}>Not now</Text>
          </TouchableOpacity>

          <Text style={s.disclosure}>
            Payment will be charged to your Apple ID account at the confirmation of purchase.
            Subscription automatically renews unless it is canceled at least 24 hours before
            the end of the current period.{'\n\n'}
            <Text style={s.link} onPress={() => Linking.openURL(TERMS_URL)}>Terms of Use</Text>
            {'  |  '}
            <Text style={s.link} onPress={() => Linking.openURL(PRIVACY_URL)}>Privacy Policy</Text>
          </Text>
        </Animated.View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  content: { padding: Spacing.lg, alignItems: 'center' },

  // Ambient glow
  glowOrb1: {
    position: 'absolute', top: -100, right: -80,
    width: 320, height: 320, borderRadius: 160,
    backgroundColor: 'rgba(30,206,110,0.06)',
    ...Platform.select({
      ios: { shadowColor: '#1ECE6E', shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.25, shadowRadius: 100 },
    }),
  },
  glowOrb2: {
    position: 'absolute', bottom: 100, left: -120,
    width: 360, height: 360, borderRadius: 180,
    backgroundColor: 'rgba(30,206,110,0.04)',
    ...Platform.select({
      ios: { shadowColor: '#1ECE6E', shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.15, shadowRadius: 80 },
    }),
  },

  closeBtn: {
    alignSelf: 'flex-end', width: 36, height: 36, borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.md,
  },

  // Hero
  hero: { alignItems: 'center', marginBottom: Spacing.xl },
  diamondWrap: {
    width: 72, height: 72, borderRadius: 36,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: Spacing.md, overflow: 'hidden',
  },
  diamondGradient: { ...StyleSheet.absoluteFillObject, borderRadius: 36 },
  diamondGlow: {
    position: 'absolute', width: 72, height: 72, borderRadius: 36,
    ...Platform.select({
      ios: { shadowColor: '#1ECE6E', shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.7, shadowRadius: 30 },
    }),
  },
  title: { fontSize: 28, fontWeight: '800', color: '#fff', letterSpacing: -0.5 },
  subtitle: { fontSize: FontSize.sm, color: 'rgba(255,255,255,0.40)', marginTop: 4, textAlign: 'center' },
  trialPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(30,206,110,0.10)',
    borderWidth: 1, borderColor: 'rgba(30,206,110,0.18)',
    borderRadius: Radius.pill, paddingHorizontal: 14, paddingVertical: 6, marginTop: Spacing.md,
  },
  trialDot: {
    width: 6, height: 6, borderRadius: 3, backgroundColor: Colors.green,
    ...Platform.select({
      ios: { shadowColor: Colors.green, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 1, shadowRadius: 4 },
    }),
  },
  trialText: { fontSize: 12, fontWeight: '700', color: Colors.green },

  // Price display
  priceBlock: { alignItems: 'center', marginBottom: Spacing.lg },
  priceAmount: { fontSize: 44, fontWeight: '900', color: '#fff', letterSpacing: -1 },
  pricePeriod: { fontSize: FontSize.sm, color: 'rgba(255,255,255,0.35)', marginTop: -2 },
  priceEquiv: { fontSize: 13, fontWeight: '600', color: Colors.green, marginTop: 4 },

  // Features
  featuresWrap: {
    width: '100%', marginBottom: Spacing.xl,
    backgroundColor: 'rgba(255,255,255,0.025)',
    borderRadius: Radius.xl + 4, padding: Spacing.lg,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)',
  },
  featureRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    paddingVertical: 8,
  },
  featureIconWrap: {
    width: 30, height: 30, borderRadius: 9,
    backgroundColor: 'rgba(30,206,110,0.08)',
    borderWidth: 1, borderColor: 'rgba(30,206,110,0.12)',
    alignItems: 'center', justifyContent: 'center',
  },
  featureText: { fontSize: FontSize.sm, color: 'rgba(255,255,255,0.70)', flex: 1, fontWeight: '500' },

  // CTA
  ctaBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    borderRadius: Radius.xl, padding: Spacing.md + 4, overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: '#1ECE6E', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.45, shadowRadius: 28 },
    }),
  },
  ctaText: { color: '#fff', fontSize: FontSize.md + 1, fontWeight: '800', letterSpacing: 0.3 },
  ctaShine: {
    position: 'absolute', top: 0, left: 0, right: 0, height: '50%',
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderTopLeftRadius: Radius.xl, borderTopRightRadius: Radius.xl,
  },
  restoreBtn: { alignItems: 'center', padding: Spacing.md, marginTop: Spacing.xs },
  restoreText: { color: 'rgba(255,255,255,0.45)', fontSize: FontSize.sm, fontWeight: '600' },
  skipBtn: { alignItems: 'center', padding: Spacing.sm },
  skipText: { color: 'rgba(255,255,255,0.20)', fontSize: FontSize.sm },
  disclosure: {
    fontSize: 9, color: 'rgba(255,255,255,0.18)', textAlign: 'center',
    lineHeight: 13, marginTop: Spacing.md,
  },
  link: { color: 'rgba(255,255,255,0.30)', textDecorationLine: 'underline' },
});
