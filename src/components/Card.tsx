import React from 'react';
import { View, StyleSheet, ViewStyle, Platform } from 'react-native';
import { Colors, Spacing, Radius } from '../constants/theme';

interface Props {
  children: React.ReactNode;
  style?: ViewStyle;
  padding?: number;
  glass?: boolean;
}

export function Card({ children, style, padding = Spacing.md, glass = false }: Props) {
  return (
    <View style={[glass ? styles.glassCard : styles.card, style]}>
      {/* Top-edge glass highlight — simulates light refraction */}
      <View style={styles.highlight} />
      <View style={{ padding }}>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.glassHeavy,
    borderRadius: Radius.xl,
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
    borderTopColor: Colors.glassHighlight,
    borderTopWidth: 1,
    marginBottom: Spacing.sm,
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: Colors.glassShadow,
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.35,
        shadowRadius: 20,
      },
      android: {
        elevation: 6,
      },
    }),
  },
  glassCard: {
    backgroundColor: Colors.glass,
    borderRadius: Radius.xl,
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
    borderTopColor: Colors.glassHighlight,
    borderTopWidth: 1,
    marginBottom: Spacing.sm,
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: Colors.glassShadow,
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.4,
        shadowRadius: 24,
      },
      android: {
        elevation: 8,
      },
    }),
  },
  highlight: {
    height: 1,
    backgroundColor: 'rgba(30,206,110,0.15)',
    marginHorizontal: 8,
    borderRadius: 1,
  },
});
