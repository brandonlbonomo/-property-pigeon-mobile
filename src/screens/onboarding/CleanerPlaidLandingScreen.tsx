import React from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';

const FEATURES = [
  { icon: 'card-outline', text: 'Auto-import income & expenses from your bank' },
  { icon: 'analytics-outline', text: 'See exactly how much each host earns you' },
  { icon: 'pie-chart-outline', text: 'Understand your profit margins per host' },
  { icon: 'trending-up-outline', text: 'Revenue projections based on real data' },
];

export function CleanerPlaidLandingScreen({ navigation }: any) {
  return (
    <View style={styles.container}>
      <TouchableOpacity activeOpacity={0.7}
        style={styles.backBtn} onPress={() => navigation.goBack()}>
        <Ionicons name="chevron-back" size={20} color={Colors.primary} />
        <Text style={styles.backText}>Back</Text>
      </TouchableOpacity>

      <View style={styles.progress}>
        {[1, 2, 3, 4].map(s => (
          <View key={s} style={[styles.dot, s <= 3 && styles.dotActive]} />
        ))}
      </View>

      <View style={styles.hero}>
        <View style={styles.iconCircle}>
          <Ionicons name="wallet-outline" size={40} color={Colors.primary} />
        </View>
        <Text style={styles.title}>Track your cleaning business</Text>
        <Text style={styles.subtitle}>
          Connect your bank account to automatically track income, expenses, and profitability across all your hosts.
        </Text>
      </View>

      <View style={styles.features}>
        {FEATURES.map((f, i) => (
          <View key={i} style={styles.featureRow}>
            <View style={styles.featureIcon}>
              <Ionicons name={f.icon as any} size={18} color={Colors.primary} />
            </View>
            <Text style={styles.featureText}>{f.text}</Text>
          </View>
        ))}
      </View>

      <View style={styles.bottom}>
        <TouchableOpacity
          activeOpacity={0.8}
          style={styles.primaryBtn}
          onPress={() => navigation.navigate('CleanerBilling')}
        >
          <Ionicons name="link-outline" size={18} color="#fff" />
          <Text style={styles.primaryBtnText}>Connect Bank Account</Text>
        </TouchableOpacity>

        <TouchableOpacity
          activeOpacity={0.7}
          style={styles.skipBtn}
          onPress={() => navigation.navigate('CleanerBilling')}
        >
          <Text style={styles.skipText}>Skip for now</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg, padding: Spacing.lg, paddingTop: 60 },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, marginBottom: Spacing.lg },
  backText: { fontSize: FontSize.md, color: Colors.primary },
  progress: { flexDirection: 'row', justifyContent: 'center', gap: Spacing.sm, marginBottom: Spacing.xl },
  dot: { width: 8, height: 8, borderRadius: Radius.pill, backgroundColor: Colors.border },
  dotActive: { backgroundColor: Colors.green, width: 24 },

  hero: { alignItems: 'center', marginBottom: Spacing.xl },
  iconCircle: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: Colors.greenDim,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: Spacing.md,
    ...Platform.select({
      ios: { shadowColor: Colors.primary, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.2, shadowRadius: 16 },
    }),
  },
  title: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text, textAlign: 'center', marginBottom: Spacing.sm },
  subtitle: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20, paddingHorizontal: Spacing.md },

  features: { gap: Spacing.md, marginBottom: Spacing.xl },
  featureRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  featureIcon: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: Colors.glass,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
    borderTopColor: Colors.glassHighlight, borderTopWidth: 1,
    alignItems: 'center', justifyContent: 'center',
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.3, shadowRadius: 8 },
    }),
  },
  featureText: { flex: 1, fontSize: FontSize.md, color: Colors.text, lineHeight: 20 },

  bottom: { marginTop: 'auto', gap: Spacing.sm, marginBottom: Spacing.lg },
  primaryBtn: {
    backgroundColor: Colors.green, borderRadius: Radius.lg,
    padding: Spacing.md + 2, alignItems: 'center',
    flexDirection: 'row', justifyContent: 'center', gap: Spacing.sm,
    ...Platform.select({
      ios: { shadowColor: Colors.primary, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 20 },
    }),
  },
  primaryBtnText: { color: '#FFFFFF', fontSize: FontSize.md, fontWeight: '600' },
  skipBtn: { alignItems: 'center', padding: Spacing.sm },
  skipText: { color: Colors.textDim, fontSize: FontSize.sm },
});
