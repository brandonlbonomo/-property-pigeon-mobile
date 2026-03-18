import React, { useRef, useMemo, useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Platform,
  PanResponder, Animated,
} from 'react-native';
import { Colors, FontSize, Radius, Spacing } from '../constants/theme';

interface Props<T extends string> {
  items: { key: T; label: string }[];
  selected: T;
  onSelect: (key: T) => void;
  compact?: boolean;
  /** Pass a scroll offset (in px) from a horizontal paginated ScrollView for
   *  continuous scroll-driven glass movement — matches the main pill bar feel. */
  scrollOffset?: Animated.Value;
  /** Width of each page in the scroll view (usually screen width). Required with scrollOffset. */
  pageWidth?: number;
}

const CONTAINER_PAD = 3;

export function SwipePills<T extends string>({
  items, selected, onSelect, compact,
  scrollOffset, pageWidth,
}: Props<T>) {
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const glideX = useRef(new Animated.Value(0)).current;
  const [containerWidth, setContainerWidth] = useState(0);
  const didInit = useRef(false);
  const pad = compact ? 2 : CONTAINER_PAD;

  const pillWidth = containerWidth > 0
    ? (containerWidth - pad * 2) / items.length
    : 0;
  const pillWidthRef = useRef(0);
  pillWidthRef.current = pillWidth;

  const isScrollDriven = !!scrollOffset && !!pageWidth;

  // ── Scroll-driven: glass position interpolated from scroll offset ──
  const scrollGlideX = useMemo(() => {
    if (!scrollOffset || !pageWidth || pillWidth <= 0) return null;
    return scrollOffset.interpolate({
      inputRange: items.map((_, i) => i * pageWidth),
      outputRange: items.map((_, i) => pad + i * pillWidth),
      extrapolate: 'clamp',
    });
  }, [scrollOffset, pageWidth, pillWidth, items.length, pad]);

  // Per-label animated values for scroll-driven mode
  const scrollLabelAnims = useMemo(() => {
    if (!scrollOffset || !pageWidth) return null;
    return items.map((_, i) =>
      scrollOffset.interpolate({
        inputRange: [(i - 1) * pageWidth, i * pageWidth, (i + 1) * pageWidth],
        outputRange: [0, 1, 0],
        extrapolate: 'clamp',
      })
    );
  }, [scrollOffset, pageWidth, items.length]);

  // ── Spring-fallback mode ──
  const labelAnims = useRef<Animated.Value[]>([]);
  if (labelAnims.current.length !== items.length) {
    labelAnims.current = items.map((item) =>
      new Animated.Value(item.key === selected ? 1 : 0)
    );
  }

  useEffect(() => {
    if (isScrollDriven) return; // Skip spring — driven by scroll
    if (pillWidth <= 0) return;
    const idx = items.findIndex(i => i.key === selected);
    const target = pad + Math.max(0, idx) * pillWidth;

    if (!didInit.current) {
      didInit.current = true;
      glideX.setValue(target);
    } else {
      Animated.spring(glideX, {
        toValue: target,
        useNativeDriver: true,
        tension: 65,
        friction: 11,
      }).start();
    }

    items.forEach((item, i) => {
      Animated.spring(labelAnims.current[i], {
        toValue: item.key === selected ? 1 : 0,
        tension: 80,
        friction: 12,
        useNativeDriver: true,
      }).start();
    });
  }, [selected, pillWidth, items.length, isScrollDriven]);

  // Init scroll-driven position
  useEffect(() => {
    if (!isScrollDriven || pillWidth <= 0) return;
    const idx = items.findIndex(i => i.key === selected);
    glideX.setValue(pad + Math.max(0, idx) * pillWidth);
  }, [isScrollDriven, pillWidth]);

  // Drag PanResponder — only in spring mode
  const panResponder = useMemo(() => {
    if (isScrollDriven) return { panHandlers: {} };
    let startX = 0;
    return PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponderCapture: (_, gs) =>
        Math.abs(gs.dx) > 8 && Math.abs(gs.dx) > Math.abs(gs.dy) * 1.5,
      onPanResponderGrant: () => {
        const tw = pillWidthRef.current;
        const curItems = itemsRef.current;
        const curIdx = curItems.findIndex(i => i.key === selectedRef.current);
        startX = (compact ? 2 : CONTAINER_PAD) + Math.max(0, curIdx) * tw;
      },
      onPanResponderMove: (_, gs) => {
        const tw = pillWidthRef.current;
        if (tw <= 0) return;
        const p = compact ? 2 : CONTAINER_PAD;
        const maxX = p + (itemsRef.current.length - 1) * tw;
        const newX = Math.max(p, Math.min(maxX, startX + gs.dx));
        glideX.setValue(newX);
      },
      onPanResponderRelease: (_, gs) => {
        const tw = pillWidthRef.current;
        if (tw <= 0) return;
        const p = compact ? 2 : CONTAINER_PAD;
        const finalX = startX + gs.dx;
        const idx = Math.round((finalX - p) / tw);
        const curItems = itemsRef.current;
        const clampedIdx = Math.max(0, Math.min(curItems.length - 1, idx));
        onSelectRef.current(curItems[clampedIdx].key);
      },
    });
  }, [compact, isScrollDriven]);

  // Choose the glass translateX source
  const glassTranslateX = (isScrollDriven && scrollGlideX) ? scrollGlideX : glideX;

  return (
    <View
      style={[styles.container, compact && styles.containerCompact]}
      onLayout={e => setContainerWidth(e.nativeEvent.layout.width)}
      {...(panResponder.panHandlers || {})}
    >
      {pillWidth > 0 && (
        <Animated.View style={[
          styles.glass,
          compact && styles.glassCompact,
          {
            width: pillWidth,
            transform: [{ translateX: glassTranslateX }],
          },
        ]} />
      )}
      {items.map(({ key, label }, i) => {
        // Choose animation source
        const anim = isScrollDriven
          ? scrollLabelAnims?.[i]
          : labelAnims.current[i];

        const opacity = anim
          ? (anim as any).interpolate
            ? (anim as Animated.AnimatedInterpolation<number>).interpolate({
                inputRange: [0, 1],
                outputRange: [0.35, 1],
                extrapolate: 'clamp',
              })
            : (anim as Animated.Value).interpolate({
                inputRange: [0, 1],
                outputRange: [0.35, 1],
                extrapolate: 'clamp',
              })
          : selected === key ? 1 : 0.35;

        const scale = anim
          ? (anim as any).interpolate
            ? (anim as Animated.AnimatedInterpolation<number>).interpolate({
                inputRange: [0, 1],
                outputRange: [0.92, 1.04],
                extrapolate: 'clamp',
              })
            : (anim as Animated.Value).interpolate({
                inputRange: [0, 1],
                outputRange: [0.92, 1.04],
                extrapolate: 'clamp',
              })
          : selected === key ? 1.04 : 0.92;

        return (
          <TouchableOpacity
            activeOpacity={0.7}
            key={key}
            style={[styles.pill, compact && styles.pillCompact]}
            onPress={() => onSelect(key)}
          >
            <Animated.Text style={[
              styles.text,
              compact && styles.textCompact,
              { opacity, transform: [{ scale }] },
              selected === key && styles.textActive,
            ]}>
              {label}
            </Animated.Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    backgroundColor: Colors.glassDark,
    borderRadius: Radius.pill,
    padding: CONTAINER_PAD,
    marginBottom: Spacing.md,
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
  },
  containerCompact: {
    padding: 2,
  },
  glass: {
    position: 'absolute',
    top: CONTAINER_PAD,
    bottom: CONTAINER_PAD,
    borderRadius: Radius.pill,
    backgroundColor: Colors.glass,
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
    borderTopColor: Colors.glassHighlight,
    borderTopWidth: 1,
    ...Platform.select({
      ios: {
        shadowColor: Colors.glassShadow,
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.45,
        shadowRadius: 8,
      },
    }),
  },
  glassCompact: {
    top: 2,
    bottom: 2,
  },
  pill: {
    flex: 1,
    paddingVertical: 14,
    alignItems: 'center',
    borderRadius: Radius.pill,
  },
  pillCompact: {
    paddingVertical: 5,
  },
  text: {
    fontSize: FontSize.lg,
    color: Colors.text,
    fontWeight: '500',
  },
  textActive: {
    color: Colors.text,
    fontWeight: '700',
  },
  textCompact: {
    fontSize: FontSize.xs,
  },
});
