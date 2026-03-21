import React, { useRef, useState, useCallback, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  Animated, Platform, Dimensions, LayoutChangeEvent,
} from 'react-native';
import { Colors, Radius } from '../constants/theme';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export interface PillTab {
  key: string;
  label: string;
  badge?: number;
}

interface Props {
  tabs: PillTab[];
  activeIndex: number;
  scrollOffset: Animated.AnimatedInterpolation<number> | Animated.Value;
  onPressTab: (index: number) => void;
}

const PILL_H = 38;
const PILL_GAP = 6;
const PILL_PX = 16;
const CONTAINER_H = 50;
const BLOB_PAD = 8;
const CHAR_W_EST = 8;

export function LiquidPillBar({ tabs, activeIndex, scrollOffset, onPressTab }: Props) {
  /* ── All hooks must be called unconditionally ── */
  const pillLayoutsRef = useRef<{ x: number; w: number }[]>([]);
  const measuredCountRef = useRef(0);
  const [layoutReady, setLayoutReady] = useState(false);
  const prevTabCountRef = useRef(tabs.length);
  const bounceVal = useRef(new Animated.Value(0)).current;
  const initialRef = useRef(true);

  // Reset layout tracking when tab count changes
  if (prevTabCountRef.current !== tabs.length) {
    prevTabCountRef.current = tabs.length;
    pillLayoutsRef.current = [];
    measuredCountRef.current = 0;
    if (layoutReady) setLayoutReady(false);
  }

  const onPillLayout = useCallback((i: number, e: LayoutChangeEvent) => {
    const { x, width } = e.nativeEvent.layout;
    pillLayoutsRef.current[i] = { x, w: width };
    measuredCountRef.current++;
    if (measuredCountRef.current >= tabs.length && !layoutReady) {
      setLayoutReady(true);
    }
  }, [tabs.length, layoutReady]);

  const estimated = React.useMemo(() => {
    let cx = 0;
    return tabs.map(t => {
      const w = Math.max(36, t.label.length * CHAR_W_EST + PILL_PX * 2);
      const d = { x: cx, w };
      cx += w + PILL_GAP;
      return d;
    });
  }, [tabs]);

  useEffect(() => {
    if (initialRef.current) {
      initialRef.current = false;
      return;
    }
    bounceVal.setValue(1);
    Animated.spring(bounceVal, {
      toValue: 0,
      tension: 60,
      friction: 14,
      useNativeDriver: true,
    }).start();
  }, [activeIndex]);

  const pills = layoutReady ? pillLayoutsRef.current : estimated;
  const indices = tabs.map((_, i) => i);

  // Guard: interpolation requires at least 2 data points in both arrays
  if (tabs.length < 2 || indices.length < 2 || pills.length < 2) {
    return <View style={styles.container}><View style={[styles.row, { justifyContent: 'center' }]}>
      {tabs.map((tab, i) => (
        <TouchableOpacity activeOpacity={0.7} key={tab.key} onPress={() => onPressTab(i)}>
          <View style={styles.pill}><Text style={styles.label}>{tab.label}</Text></View>
        </TouchableOpacity>
      ))}
    </View></View>;
  }

  /* ── Row centering ── */
  const rowTranslateX = (scrollOffset as any).interpolate({
    inputRange: indices,
    outputRange: pills.map(p => SCREEN_WIDTH / 2 - (p.x + p.w / 2)),
    extrapolate: 'clamp',
  });

  /* ── Blob position (slides to pill) ── */
  const blobTranslateX = (scrollOffset as any).interpolate({
    inputRange: indices,
    outputRange: pills.map(p => p.x - BLOB_PAD / 2),
    extrapolate: 'clamp',
  });

  /* ── Blob width (morphs to pill width) ── */
  const blobWidth = (scrollOffset as any).interpolate({
    inputRange: indices,
    outputRange: pills.map(p => p.w + BLOB_PAD),
    extrapolate: 'clamp',
  });

  /* ── Gooey scroll deformation at midpoints ── */
  const scaleIn: number[] = [];
  const sxOut: number[] = [];
  const syOut: number[] = [];
  for (let i = 0; i < tabs.length; i++) {
    scaleIn.push(i);
    sxOut.push(1);
    syOut.push(1);
    if (i < tabs.length - 1) {
      scaleIn.push(i + 0.5);
      sxOut.push(1.06);
      syOut.push(0.92);
    }
  }
  const gooeyScaleX = (scrollOffset as any).interpolate({
    inputRange: scaleIn,
    outputRange: sxOut,
    extrapolate: 'clamp',
  });
  const gooeyScaleY = (scrollOffset as any).interpolate({
    inputRange: scaleIn,
    outputRange: syOut,
    extrapolate: 'clamp',
  });

  const bounceScaleX = bounceVal.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.02],
  });
  const bounceScaleY = bounceVal.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 0.98],
  });

  const blobTop = (CONTAINER_H - PILL_H) / 2;

  return (
    <View style={styles.container}>
      <Animated.View
        style={[
          styles.row,
          { gap: PILL_GAP, transform: [{ translateX: rowTranslateX }] },
        ]}
      >
        {/* ── Blob ── */}
        <Animated.View
          style={[
            styles.blobOuter,
            {
              top: blobTop,
              height: PILL_H,
              width: blobWidth,
              transform: [
                { translateX: blobTranslateX },
                { scaleX: gooeyScaleX },
                { scaleY: gooeyScaleY },
              ],
            },
          ]}
        >
          <Animated.View
            style={[
              styles.blob,
              {
                transform: [
                  { scaleX: bounceScaleX },
                  { scaleY: bounceScaleY },
                ],
              },
            ]}
          >
            <View style={styles.blobShine} />
            <View style={styles.blobInnerGlow} />
          </Animated.View>
        </Animated.View>

        {/* ── Pill labels ── */}
        {tabs.map((tab, i) => {
          const scale = (scrollOffset as any).interpolate({
            inputRange: [i - 1, i, i + 1],
            outputRange: [0.92, 1.04, 0.92],
            extrapolate: 'clamp',
          });
          const opacity = (scrollOffset as any).interpolate({
            inputRange: [i - 1, i, i + 1],
            outputRange: [0.35, 1.0, 0.35],
            extrapolate: 'clamp',
          });

          return (
            <TouchableOpacity
              activeOpacity={0.7}
              key={tab.key}
              onPress={() => onPressTab(i)}
              onLayout={(e) => onPillLayout(i, e)}
            >
              <Animated.View style={[styles.pill, { transform: [{ scale }], opacity }]}>
                <Text style={styles.label} numberOfLines={1}>
                  {tab.label}
                </Text>
                {tab.badge != null && tab.badge > 0 && (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{tab.badge}</Text>
                  </View>
                )}
              </Animated.View>
            </TouchableOpacity>
          );
        })}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: CONTAINER_H,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    height: CONTAINER_H,
  },
  blobOuter: {
    position: 'absolute',
    overflow: 'visible',
  },
  blob: {
    width: '100%',
    height: '100%',
    borderRadius: Radius.pill,
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.08)',
    borderTopColor: 'rgba(255,255,255,1)',
    borderTopWidth: 2,
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: 'rgba(0,0,0,0.15)',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 1,
        shadowRadius: 12,
      },
      android: { elevation: 6 },
    }),
  },
  blobShine: {
    position: 'absolute',
    top: 2,
    left: 10,
    right: 10,
    height: 2,
    backgroundColor: 'rgba(255,255,255,0.8)',
    borderRadius: 1,
  },
  blobInnerGlow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '50%',
    backgroundColor: 'rgba(255,255,255,0.5)',
    borderTopLeftRadius: Radius.pill,
    borderTopRightRadius: Radius.pill,
  },
  pill: {
    height: PILL_H,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: PILL_PX,
  },
  label: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.text,
    zIndex: 1,
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#EF4444',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    zIndex: 2,
  },
  badgeText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#FFFFFF',
  },
});
