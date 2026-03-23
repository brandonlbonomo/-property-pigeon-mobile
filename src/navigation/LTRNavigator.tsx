import React, { useRef, useState, useCallback, useEffect } from 'react';
import {
  View, Text, Image, StyleSheet, TouchableOpacity,
  Animated, Dimensions, NativeSyntheticEvent, NativeScrollEvent,
  ScrollView, Modal, Platform, Easing,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { Colors, FontSize, Spacing, Radius } from '../constants/theme';
import { useUserStore } from '../store/userStore';
import { useNotificationStore } from '../store/notificationStore';
import { useMessageStore } from '../store/messageStore';
import { LiquidPillBar, PillTab } from '../components/LiquidPillBar';
import { ProfileScreen, triggerCustomize } from '../screens/profile/ProfileScreen';
import { MoneyScreen } from '../screens/money/MoneyScreen';
import { ProjectionsScreen } from '../screens/money/ProjectionsScreen';
import { CleaningsScreen, useCleaningsBadgeCount } from '../screens/cleanings/CleaningsScreen';
import { NetworkMapScreen } from '../screens/network/NetworkMapScreen';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const BASE_ORDER = ['profile', 'performance', 'projections'];
const STR_PILLS = ['logistics'];

const PILL_LABELS: Record<string, string> = {
  profile: 'HQ',
  performance: 'Money',
  projections: 'Projections',
  logistics: 'Logistics',
  network: 'Map',
};

// Each screen's internal ScrollView needs top padding so the first card
// starts below the header, but scrolled content slides behind the header.
// We export this so screens can use it in their contentContainerStyle.
export const HEADER_SCROLL_PADDING = 100;

function PageContent({ pageKey }: { pageKey: string }) {
  switch (pageKey) {
    case 'profile': return <ProfileScreen />;
    case 'performance': return <MoneyScreen />;
    case 'projections': return <ProjectionsScreen />;
    case 'logistics': return <CleaningsScreen />;
    case 'network': return <NetworkMapScreen />;
    default: return <View />;
  }
}

export { PillNavigator as LTRNavigator };

export function PillNavigator() {
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const rawPillOrder = useUserStore(s => s.profile?.pillOrder);
  const portfolioType = useUserStore(s => s.profile?.portfolioType);
  const unreadCount = useNotificationStore(s => s.unreadCount);
  const cleaningsBadge = useCleaningsBadgeCount();

  const isSTR = portfolioType === 'str' || portfolioType === 'both';
  const DEFAULT_ORDER = isSTR ? [...BASE_ORDER, ...STR_PILLS] : BASE_ORDER;

  // Migrate old pill orders
  const pillOrder = React.useMemo(() => {
    let order = rawPillOrder || DEFAULT_ORDER;
    // Remove legacy keys
    const hasLegacy = order.some(k => k === 'monthly' || k === 'quarterly' || k === 'annual');
    if (hasLegacy) {
      const migrated: string[] = [];
      let addedPerformance = false;
      for (const key of order) {
        if (key === 'monthly' || key === 'quarterly' || key === 'annual') {
          if (!addedPerformance) { migrated.push('performance'); addedPerformance = true; }
        } else { migrated.push(key); }
      }
      order = migrated;
    }
    // Remove deprecated and cleaner-only pills from owner pill order
    order = order.filter(k => k !== 'feed' && k !== 'occupancy' && k !== 'cleanings' && k !== 'home' && k !== 'calendar' && k !== 'inventory'
      && k !== 'schedule' && k !== 'owners' && k !== 'invoices' && k !== 'money');
    // Ensure base pills exist
    if (!order.includes('performance')) order.push('performance');
    if (!order.includes('projections')) {
      const perfIdx = order.indexOf('performance');
      order.splice(perfIdx + 1, 0, 'projections');
    }
    // Handle STR pills based on portfolio type
    if (isSTR) {
      for (const pill of STR_PILLS) {
        if (!order.includes(pill)) order.push(pill);
      }
    } else {
      order = order.filter(k => !STR_PILLS.includes(k));
    }
    // Pin Profile as always-first
    order = ['profile', ...order.filter(k => k !== 'profile')];
    return order;
  }, [rawPillOrder, isSTR]);

  const scrollRef = useRef<ScrollView>(null);
  const startIndex = 0; // Profile is always first
  const rawScroll = useRef(new Animated.Value(startIndex * SCREEN_WIDTH)).current;
  const [activeIndex, setActiveIndex] = useState(startIndex);

  const tabs: PillTab[] = pillOrder.map(key => ({
    key,
    label: PILL_LABELS[key] || key,
    badge: undefined,
  }));

  // Convert pixel scroll → normalized page index (0, 1, 2, ...)
  // Guard: interpolate requires at least 2 elements
  const safeInputRange = pillOrder.length >= 2
    ? pillOrder.map((_, i) => i * SCREEN_WIDTH)
    : [0, SCREEN_WIDTH];
  const safeOutputRange = pillOrder.length >= 2
    ? pillOrder.map((_, i) => i)
    : [0, 1];
  const normalizedOffset = rawScroll.interpolate({
    inputRange: safeInputRange,
    outputRange: safeOutputRange,
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

  // Swipe right past HQ → open Settings
  const dragStartX = useRef(0);
  const onScrollEndDrag = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const x = e.nativeEvent.contentOffset.x;
    // If on first page and user dragged right (offset went negative or stayed at 0 while starting from 0)
    if (activeIndex === 0 && x <= 0) {
      navigation.navigate('Settings');
    }
  }, [navigation, activeIndex]);

  const onPressTab = useCallback((index: number) => {
    scrollRef.current?.scrollTo({ x: index * SCREEN_WIDTH, animated: true });
    setActiveIndex(index);
  }, []);

  // ── Dual liquid-glass FABs: message + hamburger (profile page only) ──
  const fabMsgAnim = useRef(new Animated.Value(0)).current;
  const fabMenuAnim = useRef(new Animated.Value(0)).current;
  const fabsVisibleRef = useRef(false);
  const profileIndex = pillOrder.indexOf('profile');
  const msgUnread = useMessageStore(s => s.unreadTotal);

  useEffect(() => { useMessageStore.getState().fetchUnreadCount(); }, []);

  const springFabs = useCallback((show: boolean) => {
    // Always stop running animations first to prevent stuck states
    fabMsgAnim.stopAnimation();
    fabMenuAnim.stopAnimation();

    if (show) {
      Animated.stagger(100, [
        Animated.spring(fabMsgAnim, {
          toValue: 1, useNativeDriver: true, tension: 18, friction: 6,
        }),
        Animated.spring(fabMenuAnim, {
          toValue: 1, useNativeDriver: true, tension: 14, friction: 5.5,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(fabMenuAnim, {
          toValue: 0, useNativeDriver: true, duration: 250,
          easing: Easing.out(Easing.cubic),
        }),
        Animated.timing(fabMsgAnim, {
          toValue: 0, useNativeDriver: true, duration: 300,
          easing: Easing.out(Easing.cubic),
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

  // Header row (~48) + pills (~44) = ~92 below safe area inset
  // Content starts right at the bottom of the pills — the gradient tail
  // extends ~40px below, so scrolled content fades behind the header
  const headerContentHeight = 92;

  return (
    <View style={styles.container}>
      {/* Swipeable Pages — full bleed, content scrolls behind the header */}
      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        bounces
        alwaysBounceHorizontal
        scrollEventThrottle={16}
        onScroll={onScroll}
        onScrollBeginDrag={onScrollBeginDrag}
        onScrollEndDrag={onScrollEndDrag}
        onMomentumScrollEnd={onMomentumScrollEnd}
        contentOffset={{ x: startIndex * SCREEN_WIDTH, y: 0 }}
        decelerationRate="fast"
      >
        {pillOrder.map(key => (
          <View key={key} style={[styles.page, { width: SCREEN_WIDTH }]}>
            <PageContent pageKey={key} />
          </View>
        ))}
      </ScrollView>

      {/* ── Frosted glass header — floats over content ── */}
      <View style={[styles.headerOverlay, { paddingTop: insets.top }]} pointerEvents="box-none">
        {/* Frosted glass: semi-transparent so cards are visible behind it */}
        <LinearGradient
          colors={[
            'rgba(248,249,250,0.85)',
            'rgba(248,249,250,0.75)',
            'rgba(248,249,250,0.55)',
            'rgba(248,249,250,0.25)',
            'rgba(248,249,250,0)',
          ]}
          locations={[0, 0.4, 0.65, 0.85, 1]}
          style={StyleSheet.absoluteFillObject}
          pointerEvents="none"
        />
        {/* Green brand tint — deeper green matching logo */}
        <LinearGradient
          colors={[
            'rgba(22,163,74,0.55)',
            'rgba(30,206,110,0.28)',
            'rgba(30,206,110,0.08)',
            'rgba(30,206,110,0)',
          ]}
          locations={[0, 0.35, 0.65, 1]}
          style={StyleSheet.absoluteFillObject}
          pointerEvents="none"
        />
        {/* Header row */}
        <View style={styles.header} pointerEvents="box-none">
          <TouchableOpacity activeOpacity={0.7}
            onPress={() => navigation.navigate('Settings')}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons name="settings-outline" size={22} color={Colors.textSecondary} />
          </TouchableOpacity>
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
              {unreadCount > 0 && (
                <View style={{
                  position: 'absolute', top: -2, right: -4,
                  width: 8, height: 8, borderRadius: 4,
                  backgroundColor: Colors.red,
                }} />
              )}
            </TouchableOpacity>
          </View>
        </View>
        {/* Pill bar */}
        <LiquidPillBar
          tabs={tabs}
          activeIndex={activeIndex}
          scrollOffset={normalizedOffset}
          onPressTab={onPressTab}
        />
      </View>

      {/* ── Floating liquid-glass FAB stack (right side) ── */}
      {/* Map FAB (bottom — always visible, persistent) */}
      <View
        style={[styles.fab, { bottom: insets.bottom + 20 }]}
      >
        <TouchableOpacity
          activeOpacity={0.7}
          style={[styles.fabTouch, { borderColor: Colors.green + '40' }]}
          onPress={() => navigation.navigate('NetworkMap')}
        >
          <Ionicons name="globe" size={20} color={Colors.green} />
        </TouchableOpacity>
      </View>

      {/* Message FAB (above map — slides out from map bubble on profile) */}
      <Animated.View
        style={[
          styles.fab,
          {
            bottom: insets.bottom + 20,
            opacity: fabMsgAnim,
            transform: [
              { translateY: fabMsgAnim.interpolate({ inputRange: [0, 1], outputRange: [0, -58] }) },
              { scale: fabMsgAnim.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.3, 0.8, 1] }) },
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

      {/* Hamburger FAB (above message — slides out from message bubble) */}
      <Animated.View
        style={[
          styles.fab,
          {
            bottom: insets.bottom + 20,
            opacity: fabMenuAnim,
            transform: [
              { translateY: fabMenuAnim.interpolate({ inputRange: [0, 1], outputRange: [0, -116] }) },
              { scale: fabMenuAnim.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.1, 0.6, 1] }) },
            ],
          },
        ]}
        pointerEvents={activeIndex === profileIndex ? 'auto' : 'none'}
      >
        <TouchableOpacity
          activeOpacity={0.7}
          style={styles.fabTouch}
          onPress={() => triggerCustomize()}
        >
          <Ionicons name="menu" size={22} color={Colors.text} />
        </TouchableOpacity>
      </Animated.View>

    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  headerOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    paddingBottom: 50,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.xs,
    paddingBottom: Spacing.xs,
  },
  titleCenter: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    pointerEvents: 'none',
  },
  logo: {
    width: 36,
    height: 36,
    resizeMode: 'contain',
  },
  page: {
    flex: 1,
  },

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
    flex: 1, backgroundColor: 'rgba(0,0,0,0.30)',
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
  menuItemText: { flex: 1, fontSize: FontSize.md, fontWeight: '500' as const, color: Colors.text },
});
