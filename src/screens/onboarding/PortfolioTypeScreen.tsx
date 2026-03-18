import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { useOnboardingStore, PortfolioType } from '../../store/onboardingStore';
import { useUserStore } from '../../store/userStore';

const OPTIONS: { key: PortfolioType; label: string; sub: string; icon: string }[] = [
  { key: 'str', label: 'Short-Term Rentals', sub: 'Vacation rentals, Airbnb, VRBO', icon: 'bed-outline' },
  { key: 'ltr', label: 'Long-Term Rentals', sub: 'Annual leases, month-to-month', icon: 'home-outline' },
  { key: 'both', label: 'Both', sub: 'Mix of short and long-term', icon: 'business-outline' },
];

export function PortfolioTypeScreen({ navigation }: any) {
  const [selected, setSelected] = useState<PortfolioType>(null);
  const setPortfolioType = useOnboardingStore(s => s.setPortfolioType);
  const setProfile = useUserStore(s => s.setProfile);

  const handleNext = async () => {
    if (!selected) return;
    await setPortfolioType(selected);
    await setProfile({ portfolioType: selected });
    navigation.navigate('AddProperties');
  };

  return (
    <View style={styles.container}>
      <TouchableOpacity activeOpacity={0.7}
          style={styles.backBtn} onPress={() => navigation.goBack()}>
        <Ionicons name="chevron-back" size={20} color={Colors.primary} />
        <Text style={styles.backText}>Back</Text>
      </TouchableOpacity>

      <View style={styles.progress}>
        {[1, 2, 3, 4, 5, 6].map(s => (
          <View key={s} style={[styles.dot, s <= 2 && styles.dotActive]} />
        ))}
      </View>

      <Text style={styles.title}>What kind of properties do you manage?</Text>
      <Text style={styles.subtitle}>This helps us customize your dashboard</Text>

      {OPTIONS.map(opt => (
        <TouchableOpacity activeOpacity={0.7}
          key={opt.key}
          style={[styles.card, selected === opt.key && styles.cardActive]}
          onPress={() => setSelected(opt.key)}
        >
          <View style={[styles.iconWrap, selected === opt.key && styles.iconWrapActive]}>
            <Ionicons name={opt.icon as any} size={22} color={selected === opt.key ? Colors.primary : Colors.textSecondary} />
          </View>
          <View style={styles.cardText}>
            <Text style={[styles.cardLabel, selected === opt.key && styles.cardLabelActive]}>{opt.label}</Text>
            <Text style={styles.cardSub}>{opt.sub}</Text>
          </View>
          {selected === opt.key && (
            <Ionicons name="checkmark-circle" size={22} color={Colors.primary} />
          )}
        </TouchableOpacity>
      ))}

      <View style={{ flex: 1 }} />

      <TouchableOpacity
        style={[styles.primaryBtn, !selected && styles.btnDisabled]}
        onPress={handleNext}
        disabled={!selected}
        activeOpacity={0.8}
      >
        <Text style={styles.primaryBtnText}>Next</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg, padding: Spacing.lg, paddingTop: 60 },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, marginBottom: Spacing.lg },
  backText: { fontSize: FontSize.md, color: Colors.primary },
  progress: { flexDirection: 'row', justifyContent: 'center', gap: Spacing.sm, marginBottom: Spacing.xl },
  dot: { width: 8, height: 8, borderRadius: Radius.pill, backgroundColor: Colors.border },
  dotActive: { backgroundColor: Colors.primary, width: 24 },
  title: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text, marginBottom: Spacing.xs },
  subtitle: { fontSize: FontSize.sm, color: Colors.textSecondary, marginBottom: Spacing.lg, lineHeight: 20 },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.glassHeavy, borderWidth: 0.5, borderColor: Colors.glassBorder,
    borderRadius: Radius.xl, padding: Spacing.md, marginBottom: Spacing.sm,
    overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.12, shadowRadius: 10 },
    }),
  },
  cardActive: {
    borderColor: Colors.glassBorder, borderWidth: 0.5,
    backgroundColor: Colors.glass,
    borderTopColor: Colors.glassHighlight, borderTopWidth: 1,
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.45, shadowRadius: 12 },
    }),
  },
  iconWrap: {
    width: 44, height: 44, borderRadius: 12, backgroundColor: Colors.glassDark,
    alignItems: 'center', justifyContent: 'center',
  },
  iconWrapActive: { backgroundColor: Colors.primaryDim },
  cardText: { flex: 1 },
  cardLabel: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  cardLabelActive: { color: Colors.primary },
  cardSub: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  primaryBtn: {
    backgroundColor: Colors.primary, borderRadius: Radius.lg,
    padding: Spacing.md + 2, alignItems: 'center', marginBottom: Spacing.lg,
    ...Platform.select({
      ios: { shadowColor: Colors.primary, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 20 },
    }),
  },
  btnDisabled: { opacity: 0.5 },
  primaryBtnText: { color: '#FFFFFF', fontSize: FontSize.md, fontWeight: '600' },
});
