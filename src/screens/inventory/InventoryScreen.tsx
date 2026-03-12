import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl,
  TouchableOpacity, ActivityIndicator, TextInput, Alert, Modal,
  Linking,
} from 'react-native';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { useDataStore } from '../../store/dataStore';
import { apiFetch } from '../../services/api';
import { Card } from '../../components/Card';
import { SectionHeader } from '../../components/SectionHeader';
import { EmptyState } from '../../components/EmptyState';

export function InventoryScreen() {
  const { fetchInvGroups } = useDataStore();
  const [groups, setGroups] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [editItem, setEditItem] = useState<any>(null);
  const [editQty, setEditQty] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (force = false) => {
    try {
      const data = await fetchInvGroups(force);
      setGroups(data || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [fetchInvGroups]);

  useEffect(() => { load(); }, []);
  const onRefresh = () => { setRefreshing(true); load(true); };

  async function saveQty() {
    if (!editItem) return;
    const qty = parseFloat(editQty);
    if (isNaN(qty) || qty < 0) {
      Alert.alert('Invalid', 'Please enter a valid quantity');
      return;
    }
    setSaving(true);
    try {
      await apiFetch('/api/inventory/update', {
        method: 'POST',
        body: JSON.stringify({ itemId: editItem.id, quantity: qty }),
      });
      setEditItem(null);
      load(true);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  return (
    <>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
      >
        {groups.length === 0 ? (
          <EmptyState icon="📦" message="No inventory groups" sub="Add inventory on the web app to see it here" />
        ) : (
          groups.map((group: any) => (
            <View key={group.city || group.id || Math.random()}>
              <SectionHeader title={group.city || group.name || 'Inventory'} />
              {(group.items || []).map((item: any) => {
                const qty = item.current_qty ?? item.quantity ?? 0;
                const threshold = item.reorder_threshold ?? 0;
                const capacity = item.capacity ?? item.max_qty ?? 0;
                const isLow = threshold > 0 && qty <= threshold;
                const pct = capacity > 0 ? Math.min(qty / capacity, 1) : null;

                return (
                  <TouchableOpacity
                    key={item.id}
                    onPress={() => {
                      setEditItem(item);
                      setEditQty(String(qty));
                    }}
                    activeOpacity={0.7}
                  >
                    <Card padding={Spacing.sm}>
                      <View style={styles.itemRow}>
                        <View style={styles.itemInfo}>
                          <View style={styles.itemNameRow}>
                            <Text style={styles.itemName}>{item.name || item.label}</Text>
                            {isLow && (
                              <View style={styles.lowBadge}>
                                <Text style={styles.lowBadgeText}>LOW</Text>
                              </View>
                            )}
                          </View>
                          <Text style={styles.itemQty}>
                            {qty} {item.unit || ''}{capacity > 0 ? ` / ${capacity}` : ''}
                          </Text>
                          {pct !== null && (
                            <View style={styles.progressBar}>
                              <View
                                style={[
                                  styles.progressFill,
                                  {
                                    width: `${pct * 100}%` as any,
                                    backgroundColor: isLow ? Colors.red : Colors.green,
                                  },
                                ]}
                              />
                            </View>
                          )}
                        </View>
                        <View style={styles.itemActions}>
                          {item.reorder_url ? (
                            <TouchableOpacity
                              style={styles.reorderBtn}
                              onPress={() => Linking.openURL(item.reorder_url)}
                            >
                              <Text style={styles.reorderBtnText}>Reorder</Text>
                            </TouchableOpacity>
                          ) : null}
                          <Text style={styles.editHint}>Tap to edit</Text>
                        </View>
                      </View>
                    </Card>
                  </TouchableOpacity>
                );
              })}
            </View>
          ))
        )}
      </ScrollView>

      {/* Edit quantity modal */}
      <Modal visible={!!editItem} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Update Stock</Text>
            <Text style={styles.modalSub}>{editItem?.name || editItem?.label}</Text>
            <TextInput
              style={styles.modalInput}
              value={editQty}
              onChangeText={setEditQty}
              keyboardType="numeric"
              placeholder="Quantity"
              placeholderTextColor={Colors.textDim}
              autoFocus
            />
            <View style={styles.modalBtns}>
              <TouchableOpacity
                style={styles.modalCancelBtn}
                onPress={() => setEditItem(null)}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalSaveBtn, saving && styles.btnDisabled]}
                onPress={saveQty}
                disabled={saving}
              >
                <Text style={styles.modalSaveText}>{saving ? 'Saving…' : 'Save'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  content: { padding: Spacing.md, paddingBottom: Spacing.xl },
  center: { flex: 1, backgroundColor: Colors.bg, alignItems: 'center', justifyContent: 'center' },
  itemRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm },
  itemInfo: { flex: 1 },
  itemNameRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, flexWrap: 'wrap' },
  itemName: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  lowBadge: { backgroundColor: Colors.redDim, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  lowBadgeText: { fontSize: 9, fontWeight: '700', color: Colors.red, letterSpacing: 0.5 },
  itemQty: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  progressBar: {
    height: 4,
    backgroundColor: Colors.border,
    borderRadius: 2,
    marginTop: Spacing.xs,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', borderRadius: 2 },
  itemActions: { alignItems: 'flex-end', gap: 4 },
  reorderBtn: {
    backgroundColor: Colors.primaryDim,
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 4,
  },
  reorderBtnText: { fontSize: FontSize.xs, color: Colors.primary, fontWeight: '600' },
  editHint: { fontSize: 10, color: Colors.textDim },
  // Modal
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: '#1a2030',
    borderTopLeftRadius: Radius.xl, borderTopRightRadius: Radius.xl,
    padding: Spacing.lg, paddingBottom: Spacing.xl,
    borderTopWidth: 1, borderColor: Colors.cardBorder,
  },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginBottom: 4 },
  modalSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginBottom: Spacing.md },
  modalInput: {
    backgroundColor: Colors.card,
    borderWidth: 1, borderColor: Colors.cardBorder,
    borderRadius: Radius.md, padding: Spacing.md,
    color: Colors.text, fontSize: FontSize.lg, fontWeight: '600',
    textAlign: 'center', marginBottom: Spacing.md,
  },
  modalBtns: { flexDirection: 'row', gap: Spacing.sm },
  modalCancelBtn: {
    flex: 1, padding: Spacing.md, borderRadius: Radius.md,
    backgroundColor: Colors.card, alignItems: 'center',
    borderWidth: 1, borderColor: Colors.border,
  },
  modalCancelText: { color: Colors.textSecondary, fontSize: FontSize.md },
  modalSaveBtn: {
    flex: 1, padding: Spacing.md, borderRadius: Radius.md,
    backgroundColor: Colors.primary, alignItems: 'center',
  },
  btnDisabled: { opacity: 0.5 },
  modalSaveText: { color: '#fff', fontSize: FontSize.md, fontWeight: '600' },
});
