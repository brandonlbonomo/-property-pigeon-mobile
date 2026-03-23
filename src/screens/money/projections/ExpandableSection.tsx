import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../../../constants/theme';

interface Props {
  title: string;
  subtitle?: string;
  iconName: string;
  badge?: string;
  defaultExpanded?: boolean;
  children: React.ReactNode;
}

export function ExpandableSection({ title, subtitle, iconName, badge, defaultExpanded = false, children }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <View style={styles.container}>
      <TouchableOpacity activeOpacity={0.7} style={styles.header} onPress={() => setExpanded(e => !e)}>
        <View style={styles.headerLeft}>
          <View style={styles.iconWrap}>
            <Ionicons name={iconName as any} size={15} color={Colors.green} />
          </View>
          <View style={styles.headerText}>
            <View style={styles.titleRow}>
              <Text style={styles.title}>{title}</Text>
              {badge ? <View style={styles.badge}><Text style={styles.badgeText}>{badge}</Text></View> : null}
            </View>
            {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
          </View>
        </View>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={15} color={Colors.textDim} />
      </TouchableOpacity>
      {expanded && <View style={styles.body}>{children}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: Colors.glassHeavy,
    borderRadius: Radius.xl,
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
    borderTopColor: Colors.glassHighlight,
    borderTopWidth: 1,
    marginBottom: Spacing.md,
    overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.28, shadowRadius: 16 },
      android: { elevation: 2 },
    }),
  },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    padding: Spacing.md,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, flex: 1 },
  iconWrap: {
    width: 30, height: 30, borderRadius: 10,
    backgroundColor: Colors.greenDim,
    alignItems: 'center', justifyContent: 'center',
  },
  headerText: { flex: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  title: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  subtitle: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  badge: {
    backgroundColor: Colors.greenDim, borderRadius: Radius.pill,
    paddingHorizontal: 6, paddingVertical: 2,
  },
  badgeText: { fontSize: 10, fontWeight: '700', color: Colors.green, letterSpacing: 0.3 },
  body: { paddingHorizontal: Spacing.md, paddingBottom: Spacing.md },
});
