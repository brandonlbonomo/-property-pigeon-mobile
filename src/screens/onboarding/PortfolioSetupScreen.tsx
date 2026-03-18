import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Platform, KeyboardAvoidingView } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { useUserStore } from '../../store/userStore';

type ProjectionStyle = 'conservative' | 'normal' | 'bullish';

const PROJECTIONS: { key: ProjectionStyle; label: string; sub: string; icon: string }[] = [
  { key: 'conservative', label: 'Conservative', sub: '2% rent growth, 3% appreciation', icon: 'shield-outline' },
  { key: 'normal', label: 'Normal', sub: '3.5% rent growth, 4% appreciation', icon: 'trending-up-outline' },
  { key: 'bullish', label: 'Bullish', sub: '5% rent growth, 5% appreciation', icon: 'rocket-outline' },
];

export function PortfolioSetupScreen({ navigation }: any) {
  const profile = useUserStore(s => s.profile);
  const setProfile = useUserStore(s => s.setProfile);

  // Pre-fill unit count from sum of property units
  const defaultUnits = (profile?.properties ?? []).reduce((sum, p) => sum + p.units, 0);
  const [unitCount, setUnitCount] = useState(String(defaultUnits || ''));
  const [projection, setProjection] = useState<ProjectionStyle | null>(null);

  const canSubmit = projection !== null;

  const handleNext = async () => {
    if (!projection) return;
    await setProfile({
      unitCount: parseInt(unitCount) || 0,
      projectionStyle: projection,
    });
    navigation.navigate('Done');
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <View style={styles.container}>
      <TouchableOpacity activeOpacity={0.7}
          style={styles.backBtn} onPress={() => navigation.goBack()}>
        <Ionicons name="chevron-back" size={20} color={Colors.primary} />
        <Text style={styles.backText}>Back</Text>
      </TouchableOpacity>

      <View style={styles.progress}>
        {[1, 2, 3, 4, 5, 6].map(s => (
          <View key={s} style={[styles.dot, s <= 5 && styles.dotActive]} />
        ))}
      </View>

      <Text style={styles.title}>Portfolio setup</Text>
      <Text style={styles.subtitle}>Configure your portfolio projections and total unit count</Text>

      {/* Unit count */}
      <Text style={styles.label}>Total Units</Text>
      <TextInput
        style={styles.input}
        value={unitCount}
        onChangeText={setUnitCount}
        placeholder="Number of units"
        placeholderTextColor={Colors.textDim}
        keyboardType="number-pad"
      />

      {/* Projection style */}
      <Text style={[styles.label, { marginTop: Spacing.lg }]}>Projection Style</Text>

      {PROJECTIONS.map(opt => (
        <TouchableOpacity activeOpacity={0.7}
          key={opt.key}
          style={[styles.card, projection === opt.key && styles.cardActive]}
          onPress={() => setProjection(opt.key)}
        >
          <View style={[styles.iconWrap, projection === opt.key && styles.iconWrapActive]}>
            <Ionicons name={opt.icon as any} size={22} color={projection === opt.key ? Colors.primary : Colors.textSecondary} />
          </View>
          <View style={styles.cardText}>
            <Text style={[styles.cardLabel, projection === opt.key && styles.cardLabelActive]}>{opt.label}</Text>
            <Text style={styles.cardSub}>{opt.sub}</Text>
          </View>
          {projection === opt.key && (
            <Ionicons name="checkmark-circle" size={22} color={Colors.primary} />
          )}
        </TouchableOpacity>
      ))}

      <View style={{ flex: 1 }} />

      <TouchableOpacity
        style={[styles.primaryBtn, !canSubmit && styles.btnDisabled]}
        onPress={handleNext}
        disabled={!canSubmit}
        activeOpacity={0.8}
      >
        <Text style={styles.primaryBtnText}>Next</Text>
      </TouchableOpacity>
    </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg, padding: Spacing.lg, paddingTop: 60 },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, marginBottom: Spacing.lg },
  backText: { fontSize: FontSize.md, color: Colors.primary },
  progress: { flexDirection: 'row', justifyContent: 'center', gap: Spacing.sm, marginBottom: Spacing.xl },
  dot: { width: 8, height: 8, borderRadius: Radius.pill, backgroundColor: Colors.border },
  dotActive: { backgroundColor: Colors.green, width: 24 },
  title: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text, marginBottom: Spacing.xs },
  subtitle: { fontSize: FontSize.sm, color: Colors.textSecondary, marginBottom: Spacing.lg, lineHeight: 20 },
  label: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500', marginBottom: Spacing.xs },
  input: {
    backgroundColor: Colors.glassHeavy, borderWidth: 1, borderColor: Colors.border,
    borderRadius: Radius.md, padding: Spacing.md, color: Colors.text, fontSize: FontSize.md,
  },
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
  iconWrapActive: { backgroundColor: Colors.greenDim },
  cardText: { flex: 1 },
  cardLabel: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  cardLabelActive: { color: Colors.primary },
  cardSub: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  primaryBtn: {
    backgroundColor: Colors.green, borderRadius: Radius.lg,
    padding: Spacing.md + 2, alignItems: 'center', marginBottom: Spacing.lg,
    ...Platform.select({
      ios: { shadowColor: Colors.primary, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 20 },
    }),
  },
  btnDisabled: { opacity: 0.5 },
  primaryBtnText: { color: '#FFFFFF', fontSize: FontSize.md, fontWeight: '600' },
});
