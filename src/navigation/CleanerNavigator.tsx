import React, { useRef, useState, useCallback, useEffect } from 'react';
import {
  View, Text, Image, StyleSheet, TouchableOpacity,
  Animated, Dimensions, NativeSyntheticEvent, NativeScrollEvent,
  ScrollView, Modal, TextInput, Switch, Platform, KeyboardAvoidingView, Easing,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { Colors, FontSize, Spacing, Radius } from '../constants/theme';
import { LiquidPillBar, PillTab } from '../components/LiquidPillBar';
import { useNotificationStore } from '../store/notificationStore';
import { useMessageStore } from '../store/messageStore';
import { useUserStore } from '../store/userStore';
import { CleanerScheduleScreen } from '../screens/cleaner/CleanerScheduleScreen';
import { CleanerOwnersScreen } from '../screens/cleaner/CleanerOwnersScreen';
import { CleanerMoneyScreen } from '../screens/cleaner/CleanerMoneyScreen';
import { CleanerProfileScreen } from '../screens/cleaner/CleanerProfileScreen';
import { CleanerInvoicesScreen } from '../screens/cleaner/CleanerInvoicesScreen';

const SQFT_RATES_KEY = 'pp_cleaner_sqft_rates';

const SQ_FT_RANGES = [
  { key: 'small', label: 'Small', desc: '< 1,000 sqft' },
  { key: 'medium', label: 'Medium', desc: '1,000 – 2,000 sqft' },
  { key: 'large', label: 'Large', desc: '2,000 – 3,000 sqft' },
  { key: 'xl', label: 'XL', desc: '3,000+ sqft' },
] as const;

export interface SqftRates {
  showOnProfile: boolean;
  ranges: Record<string, number | null>;
}

const DEFAULT_RATES: SqftRates = {
  showOnProfile: false,
  ranges: { small: null, medium: null, large: null, xl: null },
};

export async function loadSqftRates(): Promise<SqftRates> {
  try {
    const raw = await SecureStore.getItemAsync(SQFT_RATES_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { ...DEFAULT_RATES, ranges: { ...DEFAULT_RATES.ranges } };
}

async function saveSqftRates(data: SqftRates) {
  await SecureStore.setItemAsync(SQFT_RATES_KEY, JSON.stringify(data));
}

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const DEFAULT_PILL_ORDER = ['profile', 'schedule', 'money', 'owners', 'invoices'];

const PILL_LABELS: Record<string, string> = {
  schedule: 'Schedule',
  money: 'Money',
  owners: 'Hosts',
  invoices: 'Invoices',
  profile: 'HQ',
};

function PageContent({ pageKey, sqftRates, onOpenRates }: { pageKey: string; sqftRates: SqftRates; onOpenRates?: () => void }) {
  switch (pageKey) {
    case 'schedule': return <CleanerScheduleScreen />;
    case 'money': return <CleanerMoneyScreen />;
    case 'owners': return <CleanerOwnersScreen />;
    case 'invoices': return <CleanerInvoicesScreen />;
    case 'profile': return <CleanerProfileScreen sqftRates={sqftRates} onOpenRates={onOpenRates} />;
    default: return <View />;
  }
}

export function CleanerPillNavigator() {
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const unreadCount = useNotificationStore(s => s.unreadCount);
  const profile = useUserStore(s => s.profile);
  const rawPillOrder = useUserStore(s => s.profile?.pillOrder);

  const pillOrder = React.useMemo(() => {
    let order = rawPillOrder || DEFAULT_PILL_ORDER;
    // Ensure all pills are present
    for (const pill of DEFAULT_PILL_ORDER) {
      if (!order.includes(pill)) order = [...order, pill];
    }
    // Remove unknown keys
    order = order.filter((k: string) => DEFAULT_PILL_ORDER.includes(k));
    // Pin Profile as always-first
    order = ['profile', ...order.filter((k: string) => k !== 'profile')];
    return order;
  }, [rawPillOrder]);

  const scrollRef = useRef<ScrollView>(null);
  const rawScroll = useRef(new Animated.Value(0)).current;
  const [activeIndex, setActiveIndex] = useState(0);

  // ── Dual liquid-glass FABs: message + hamburger (profile page only) ──
  const fabMsgAnim = useRef(new Animated.Value(0)).current;
  const fabMenuAnim = useRef(new Animated.Value(0)).current;
  const fabsVisibleRef = useRef(false);
  const profileIndex = pillOrder.indexOf('profile');
  const msgUnread = useMessageStore(s => s.unreadTotal);

  useEffect(() => { useMessageStore.getState().fetchUnreadCount(); }, []);

  const springFabs = useCallback((show: boolean) => {
    if (show === fabsVisibleRef.current) return;
    fabsVisibleRef.current = show;
    if (show) {
      Animated.stagger(120, [
        Animated.spring(fabMsgAnim, {
          toValue: 1, useNativeDriver: true, tension: 14, friction: 5,
        }),
        Animated.spring(fabMenuAnim, {
          toValue: 1, useNativeDriver: true, tension: 11, friction: 4.5,
        }),
      ]).start();
    } else {
      Animated.stagger(40, [
        Animated.timing(fabMenuAnim, {
          toValue: 0, useNativeDriver: true, duration: 400,
          easing: Easing.inOut(Easing.cubic),
        }),
        Animated.timing(fabMsgAnim, {
          toValue: 0, useNativeDriver: true, duration: 450,
          easing: Easing.inOut(Easing.cubic),
        }),
      ]).start();
    }
  }, []);

  useEffect(() => {
    springFabs(activeIndex === profileIndex);
  }, [activeIndex, profileIndex]);

  const onScrollBeginDrag = useCallback(() => {
    springFabs(false);
  }, []);

  // Menu + Rate modal state
  const [menuVisible, setMenuVisible] = useState(false);
  const [rateModalVisible, setRateModalVisible] = useState(false);
  const [sqftRates, setSqftRates] = useState<SqftRates>(DEFAULT_RATES);
  const [rateInputs, setRateInputs] = useState<Record<string, string>>({});

  useEffect(() => {
    loadSqftRates().then(r => {
      setSqftRates(r);
      const inputs: Record<string, string> = {};
      for (const k of Object.keys(r.ranges)) {
        inputs[k] = r.ranges[k] != null ? String(r.ranges[k]) : '';
      }
      setRateInputs(inputs);
    });
  }, []);

  const openRateModal = () => {
    setMenuVisible(false);
    const inputs: Record<string, string> = {};
    for (const k of Object.keys(sqftRates.ranges)) {
      inputs[k] = sqftRates.ranges[k] != null ? String(sqftRates.ranges[k]) : '';
    }
    setRateInputs(inputs);
    setRateModalVisible(true);
  };

  const saveRates = async () => {
    const ranges: Record<string, number | null> = {};
    for (const r of SQ_FT_RANGES) {
      const val = parseFloat(rateInputs[r.key] || '');
      ranges[r.key] = isNaN(val) ? null : val;
    }
    const updated: SqftRates = { ...sqftRates, ranges };
    await saveSqftRates(updated);
    setSqftRates(updated);
    setRateModalVisible(false);
  };

  const tabs: PillTab[] = pillOrder.map(key => ({
    key,
    label: PILL_LABELS[key] || key,
  }));

  const normalizedOffset = rawScroll.interpolate({
    inputRange: pillOrder.map((_, i) => i * SCREEN_WIDTH),
    outputRange: pillOrder.map((_, i) => i),
    extrapolate: 'clamp',
  });

  const onScroll = Animated.event(
    [{ nativeEvent: { contentOffset: { x: rawScroll } } }],
    { useNativeDriver: false }
  );

  const onMomentumScrollEnd = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const page = Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH);
    setActiveIndex(page);
  }, []);

  const onPressTab = useCallback((index: number) => {
    scrollRef.current?.scrollTo({ x: index * SCREEN_WIDTH, animated: true });
    setActiveIndex(index);
  }, []);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Subtle brand-green header glow */}
      <LinearGradient
        colors={[Colors.brandGlow, Colors.brandGlowMid, 'rgba(10,10,10,0)']}
        style={styles.headerGlow}
        pointerEvents="none"
      />
      {/* Header */}
      <View style={styles.header}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <TouchableOpacity activeOpacity={0.7}
            onPress={() => navigation.navigate('Settings')}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons name="settings-outline" size={22} color={Colors.textSecondary} />
          </TouchableOpacity>
        </View>
        <View style={styles.titleCenter}>
          <Image source={require('../../assets/logo.png')} style={styles.logo} />
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <TouchableOpacity activeOpacity={0.7}
            onPress={() => navigation.navigate('Search')}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons name="search-outline" size={22} color={Colors.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity activeOpacity={0.7}
            onPress={() => navigation.navigate('Notifications')}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons name="notifications-outline" size={22} color={Colors.textSecondary} />
            {unreadCount > 0 && <View style={styles.badge} />}
          </TouchableOpacity>
        </View>
      </View>

      <LiquidPillBar
        tabs={tabs}
        activeIndex={activeIndex}
        scrollOffset={normalizedOffset}
        onPressTab={onPressTab}
      />

      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        bounces={false}
        scrollEventThrottle={16}
        onScroll={onScroll}
        onScrollBeginDrag={onScrollBeginDrag}
        onMomentumScrollEnd={onMomentumScrollEnd}
        decelerationRate="fast"
      >
        {pillOrder.map(key => (
          <View key={key} style={[styles.page, { width: SCREEN_WIDTH }]}>
            <PageContent pageKey={key} sqftRates={sqftRates} onOpenRates={openRateModal} />
          </View>
        ))}
      </ScrollView>

      {/* ── Floating liquid-glass FABs (profile page only) ── */}

      {/* Message FAB (bottom) */}
      <Animated.View
        style={[
          styles.fab,
          {
            bottom: insets.bottom + 20,
            opacity: fabMsgAnim,
            transform: [
              { translateY: fabMsgAnim.interpolate({ inputRange: [0, 1], outputRange: [60, 0] }) },
              { scale: fabMsgAnim.interpolate({ inputRange: [0, 1], outputRange: [0.2, 1] }) },
            ],
          },
        ]}
        pointerEvents={activeIndex === profileIndex ? 'auto' : 'none'}
      >
        <TouchableOpacity
          activeOpacity={0.7}
          style={styles.fabTouch}
          onPress={() => navigation.navigate('Conversations')}
        >
          <Ionicons name="chatbubble" size={20} color={Colors.text} />
          {msgUnread > 0 && <View style={styles.fabBadge} />}
        </TouchableOpacity>
      </Animated.View>

      {/* Hamburger FAB (above message) */}
      <Animated.View
        style={[
          styles.fab,
          {
            bottom: insets.bottom + 78,
            opacity: fabMenuAnim,
            transform: [
              { translateY: fabMenuAnim.interpolate({ inputRange: [0, 1], outputRange: [120, 0] }) },
              { scale: fabMenuAnim.interpolate({ inputRange: [0, 1], outputRange: [0.1, 1] }) },
            ],
          },
        ]}
        pointerEvents={activeIndex === profileIndex ? 'auto' : 'none'}
      >
        <TouchableOpacity
          activeOpacity={0.7}
          style={styles.fabTouch}
          onPress={() => setMenuVisible(true)}
        >
          <Ionicons name="menu" size={22} color={Colors.text} />
        </TouchableOpacity>
      </Animated.View>

      {/* Hamburger menu */}
      <Modal visible={menuVisible} transparent animationType="fade" onRequestClose={() => setMenuVisible(false)}>
        <TouchableOpacity activeOpacity={1} style={styles.menuOverlay} onPress={() => setMenuVisible(false)}>
          <View style={[styles.menuSheet, { paddingBottom: insets.bottom + Spacing.md }]}>
            <View style={styles.menuHandle} />

            <TouchableOpacity activeOpacity={0.7} style={styles.menuItem} onPress={openRateModal}>
              <Ionicons name="pricetag-outline" size={20} color={Colors.text} />
              <Text style={styles.menuItemText}>Set Cleaning Rates</Text>
              <Ionicons name="chevron-forward" size={16} color={Colors.textDim} />
            </TouchableOpacity>

            <TouchableOpacity activeOpacity={0.7} style={[styles.menuItem, { borderBottomWidth: 0 }]}
              onPress={() => setMenuVisible(false)}>
              <Text style={[styles.menuItemText, { color: Colors.textDim, textAlign: 'center', flex: 1 }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Rate-setting modal */}
      <Modal visible={rateModalVisible} transparent animationType="slide" onRequestClose={() => setRateModalVisible(false)}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <TouchableOpacity activeOpacity={1} style={styles.menuOverlay} onPress={() => setRateModalVisible(false)}>
            <TouchableOpacity activeOpacity={1} style={[styles.rateSheet, { paddingBottom: insets.bottom + Spacing.md }]}>
              <View style={styles.menuHandle} />
              <Text style={styles.rateTitle}>Cleaning Rates</Text>
              <Text style={styles.rateSubtitle}>Set your rates by property size. Hosts will see these when browsing cleaners.</Text>

              <View style={styles.rateToggleRow}>
                <Text style={styles.rateToggleLabel}>Show rates on profile</Text>
                <Switch
                  value={sqftRates.showOnProfile}
                  onValueChange={async (val) => {
                    const updated = { ...sqftRates, showOnProfile: val };
                    setSqftRates(updated);
                    await saveSqftRates(updated);
                  }}
                  trackColor={{ false: Colors.glassDark, true: Colors.primary }}
                  thumbColor="#fff"
                />
              </View>

              {SQ_FT_RANGES.map(r => (
                <View key={r.key} style={styles.rateFieldRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rateFieldLabel}>{r.label}</Text>
                    <Text style={styles.rateFieldDesc}>{r.desc}</Text>
                  </View>
                  <View style={styles.rateInputWrap}>
                    <Text style={styles.ratePrefix}>$</Text>
                    <TextInput
                      style={styles.rateInput}
                      value={rateInputs[r.key] || ''}
                      onChangeText={v => setRateInputs(prev => ({ ...prev, [r.key]: v }))}
                      keyboardType="decimal-pad"
                      placeholder="0"
                      placeholderTextColor={Colors.textDim}
                    />
                  </View>
                </View>
              ))}

              <TouchableOpacity activeOpacity={0.7} style={styles.rateSaveBtn} onPress={saveRates}>
                <Text style={styles.rateSaveBtnText}>Save Rates</Text>
              </TouchableOpacity>
            </TouchableOpacity>
          </TouchableOpacity>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  headerGlow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 180,
    zIndex: 0,
  },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingTop: Spacing.xs, paddingBottom: Spacing.xs,
  },
  titleCenter: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    pointerEvents: 'none',
  },
  logo: {
    width: 32,
    height: 32,
    resizeMode: 'contain',
  },
  badge: {
    position: 'absolute', top: -2, right: -4,
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: Colors.red,
  },
  page: { flex: 1 },

  // Liquid Glass FABs
  fab: {
    position: 'absolute',
    right: Spacing.md,
    zIndex: 50,
  },
  fabTouch: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: Colors.glass,
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
    borderTopColor: Colors.glassHighlight,
    borderTopWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      ios: {
        shadowColor: Colors.glassShadow,
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.5,
        shadowRadius: 16,
      },
    }),
  },
  fabBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: Colors.red,
    borderWidth: 1.5,
    borderColor: Colors.glass,
  },

  // Menu
  menuOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.60)',
    justifyContent: 'flex-end',
  },
  menuSheet: {
    backgroundColor: Colors.glassOverlay, borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl, padding: Spacing.md, paddingTop: Spacing.sm,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.15, shadowRadius: 20 },
    }),
  },
  menuHandle: {
    width: 36, height: 4, borderRadius: 2, backgroundColor: Colors.glassBorder,
    alignSelf: 'center', marginBottom: Spacing.md,
  },
  menuItem: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    paddingVertical: Spacing.md, borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  menuItemText: { flex: 1, fontSize: FontSize.md, fontWeight: '500', color: Colors.text },

  // Rate modal
  rateSheet: {
    backgroundColor: Colors.glassOverlay, borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl, padding: Spacing.lg, paddingTop: Spacing.sm,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.15, shadowRadius: 20 },
    }),
  },
  rateTitle: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text, marginBottom: 4 },
  rateSubtitle: { fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 18, marginBottom: Spacing.md },
  rateToggleRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: Spacing.sm, marginBottom: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border,
  },
  rateToggleLabel: { fontSize: FontSize.md, fontWeight: '500', color: Colors.text },
  rateFieldRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border,
  },
  rateFieldLabel: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  rateFieldDesc: { fontSize: FontSize.xs, color: Colors.textDim, marginTop: 1 },
  rateInputWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 2,
    backgroundColor: Colors.glassDark, borderWidth: 0.5, borderColor: Colors.glassBorder,
    borderRadius: Radius.md, paddingHorizontal: Spacing.sm, paddingVertical: 6,
  },
  ratePrefix: { fontSize: FontSize.md, color: Colors.textSecondary, fontWeight: '600' },
  rateInput: { fontSize: FontSize.md, color: Colors.text, width: 70, textAlign: 'right' },
  rateSaveBtn: {
    backgroundColor: Colors.green, borderRadius: Radius.lg,
    padding: Spacing.md, alignItems: 'center', marginTop: Spacing.lg,
    ...Platform.select({
      ios: { shadowColor: Colors.primary, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 20 },
    }),
  },
  rateSaveBtnText: { color: '#fff', fontSize: FontSize.md, fontWeight: '600' },
});
