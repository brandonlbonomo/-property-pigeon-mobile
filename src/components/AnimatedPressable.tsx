import React, { useRef, useCallback, useMemo, ReactNode } from 'react';
import {
  Animated, Pressable, StyleSheet, StyleProp, ViewStyle, GestureResponderEvent,
} from 'react-native';

interface Props {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  scaleValue?: number;
  opacityValue?: number;
  duration?: number;
  disabled?: boolean;
  onPress?: (e: GestureResponderEvent) => void;
  onLongPress?: (e: GestureResponderEvent) => void;
  hitSlop?: { top?: number; bottom?: number; left?: number; right?: number } | number;
  testID?: string;
}

// Layout keys that must live on the outer Pressable so flex/grid parents work
const LAYOUT_KEYS = new Set([
  'flex', 'flexGrow', 'flexShrink', 'flexBasis',
  'alignSelf', 'width', 'height', 'minWidth', 'minHeight',
  'maxWidth', 'maxHeight', 'margin', 'marginTop', 'marginBottom',
  'marginLeft', 'marginRight', 'marginHorizontal', 'marginVertical',
  'position', 'top', 'bottom', 'left', 'right', 'zIndex',
]);

/**
 * iOS-style button with opacity 0.7 + scale 0.97 + 150ms spring.
 * Drop-in replacement for TouchableOpacity on primary buttons.
 */
export function AnimatedPressable({
  children,
  style,
  scaleValue = 0.97,
  opacityValue = 0.7,
  duration = 150,
  disabled,
  onPress,
  onLongPress,
  hitSlop,
  testID,
}: Props) {
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  // Split layout styles (outer Pressable) from visual styles (inner Animated.View)
  const { outerStyle, innerStyle } = useMemo(() => {
    const flat = StyleSheet.flatten(style) || {};
    const outer: Record<string, any> = {};
    const inner: Record<string, any> = {};
    for (const [k, v] of Object.entries(flat)) {
      if (LAYOUT_KEYS.has(k)) outer[k] = v;
      else inner[k] = v;
    }
    return {
      outerStyle: Object.keys(outer).length ? outer : undefined,
      innerStyle: inner,
    };
  }, [style]);

  const onPressIn = useCallback(() => {
    Animated.parallel([
      Animated.timing(scale, { toValue: scaleValue, duration, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: opacityValue, duration, useNativeDriver: true }),
    ]).start();
  }, [scaleValue, opacityValue, duration]);

  const onPressOut = useCallback(() => {
    Animated.parallel([
      Animated.timing(scale, { toValue: 1, duration, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration, useNativeDriver: true }),
    ]).start();
  }, [duration]);

  return (
    <Pressable
      style={outerStyle}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      hitSlop={hitSlop}
      testID={testID}
    >
      <Animated.View style={[innerStyle, { transform: [{ scale }], opacity }]}>
        {children as any}
      </Animated.View>
    </Pressable>
  );
}
