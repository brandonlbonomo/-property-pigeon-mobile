import React from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, Alert,
} from 'react-native';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { useAuthStore } from '../../store/authStore';
import { useDataStore } from '../../store/dataStore';
import { Card } from '../../components/Card';
import { SectionHeader } from '../../components/SectionHeader';

export function SettingsScreen() {
  const signOut = useAuthStore(s => s.signOut);
  const invalidateAll = useDataStore(s => s.invalidateAll);

  function handleSignOut() {
    Alert.alert(
      'Sign Out',
      'Are you sure you want to sign out?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign Out',
          style: 'destructive',
          onPress: () => { signOut(); invalidateAll(); },
        },
      ]
    );
  }

  function handleRefresh() {
    invalidateAll();
    Alert.alert('Cache Cleared', 'Data will reload on next visit to each tab.');
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <SectionHeader title="Account" />
      <Card>
        <SettingRow
          label="Manage Account"
          sub="Visit propertypigeon.onrender.com to manage Plaid, PriceLabs, iCal, and more"
          icon="🌐"
        />
      </Card>

      <SectionHeader title="App" />
      <Card>
        <TouchableOpacity onPress={handleRefresh} activeOpacity={0.7}>
          <SettingRow label="Refresh All Data" sub="Clear cache and reload from server" icon="🔄" />
        </TouchableOpacity>
      </Card>

      <SectionHeader title="Session" />
      <Card>
        <TouchableOpacity onPress={handleSignOut} activeOpacity={0.7}>
          <SettingRow label="Sign Out" icon="🚪" labelColor={Colors.red} />
        </TouchableOpacity>
      </Card>

      <Text style={styles.version}>Property Pigeon Mobile · v1.0.0</Text>
    </ScrollView>
  );
}

function SettingRow({
  label, sub, icon, labelColor,
}: {
  label: string; sub?: string; icon?: string; labelColor?: string;
}) {
  return (
    <View style={styles.row}>
      {icon && <Text style={styles.icon}>{icon}</Text>}
      <View style={styles.rowText}>
        <Text style={[styles.rowLabel, labelColor ? { color: labelColor } : {}]}>{label}</Text>
        {sub && <Text style={styles.rowSub}>{sub}</Text>}
      </View>
      <Text style={styles.chevron}>›</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  content: { padding: Spacing.md, paddingBottom: Spacing.xl },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  icon: { fontSize: 20 },
  rowText: { flex: 1 },
  rowLabel: { fontSize: FontSize.md, color: Colors.text },
  rowSub: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  chevron: { color: Colors.textDim, fontSize: FontSize.md },
  version: {
    textAlign: 'center', color: Colors.textDim, fontSize: FontSize.xs,
    marginTop: Spacing.xl,
  },
});
