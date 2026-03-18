import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, Modal, StyleSheet, TouchableOpacity, ScrollView,
  ActivityIndicator, Platform, TextInput, Alert,
  KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../constants/theme';
import { useDataStore } from '../store/dataStore';
import { apiFetch } from '../services/api';
import { fmt$ } from '../utils/format';

interface Props {
  visible: boolean;
  yearMonth: string; // e.g. '2026-03'
  onClose: () => void;
}

type Tab = 'income' | 'expenses';

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

function formatMonthTitle(ym: string): string {
  if (!ym) return '';
  // Quarterly: "2026-Q1"
  if (ym.includes('-Q')) {
    const [year, q] = ym.split('-Q');
    return `Q${q} ${year}`;
  }
  // Year only: "2026"
  if (!ym.includes('-')) return ym;
  // Monthly: "2026-03"
  const [year, month] = ym.split('-');
  const mi = parseInt(month, 10) - 1;
  return `${MONTH_NAMES[mi] || month} ${year}`;
}

export function MonthDetailModal({ visible, yearMonth, onClose }: Props) {
  const { fetchTransactionsByMonth, fetchProps } = useDataStore();
  const invalidateAll = useDataStore(s => s.invalidateAll);
  const [tab, setTab] = useState<Tab>('income');
  const [transactions, setTransactions] = useState<any[]>([]);
  const [properties, setProperties] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editFields, setEditFields] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [txs, props] = await Promise.all([
        fetchTransactionsByMonth(yearMonth, true),
        fetchProps().catch(() => []),
      ]);
      setTransactions(txs);
      setProperties(props || []);
    } catch {
      setTransactions([]);
    }
    setLoading(false);
  }, [yearMonth, fetchTransactionsByMonth, fetchProps]);

  useEffect(() => {
    if (visible && yearMonth) {
      setEditingId(null);
      reload();
    }
  }, [visible, yearMonth]);

  const INCOME_CATS = new Set(['__rental_income__', '__cleaning_income__']);
  const EXCLUDED_CATS = new Set(['__delete__', '__internal_transfer__']);

  // Only show tagged transactions (matches bar chart calculation exactly)
  const tagged = transactions.filter(t => {
    const propTag = t.property_tag;
    const catTag = t.category_tag;
    if (!propTag && !catTag) return false;
    if (EXCLUDED_CATS.has(catTag)) return false;
    if (propTag === 'deleted' || propTag === 'transfer') return false;
    return true;
  });

  const income = tagged.filter(t => {
    const catTag = t.category_tag;
    if (INCOME_CATS.has(catTag)) return true;
    if (catTag) return false; // has a non-income category tag = expense
    return t.type === 'in' || (t.amount ?? 0) < 0; // Plaid: negative = money in
  });
  const expenseList = tagged.filter(t => !income.includes(t));
  const displayList = tab === 'income' ? income : expenseList;
  const total = displayList.reduce((s, t) => s + Math.abs(t.amount ?? 0), 0);

  const startEdit = (t: any) => {
    if (editingId === t.id) {
      // Cancel edit
      setEditingId(null);
      setEditFields({});
      return;
    }
    setEditingId(t.id);
    setEditFields({
      amount: String(Math.abs(t.amount ?? 0)),
      name: t.name || t.merchant || t.description || '',
      date: t.date || '',
      category: t.category || '',
      property_tag: t.property_tag || '',
    });
  };

  const handleSave = async () => {
    if (!editingId) return;
    setSaving(true);
    try {
      const tx = transactions.find(t => t.id === editingId);
      if (!tx) return;

      const isExpense = (tx.amount ?? 0) < 0;
      const newAmount = parseFloat(editFields.amount || '0');
      const finalAmount = isExpense ? -Math.abs(newAmount) : Math.abs(newAmount);

      await apiFetch('/api/transactions/update', {
        method: 'POST',
        body: JSON.stringify({
          id: editingId,
          amount: finalAmount,
          name: editFields.name,
          date: editFields.date,
          category: editFields.category,
          property_tag: editFields.property_tag || null,
        }),
      });

      setEditingId(null);
      setEditFields({});
      invalidateAll();
      await reload();
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Could not save changes.');
    } finally {
      setSaving(false);
    }
  };

  const propLabel = (pid: string) => {
    const p = properties.find((p: any) => (p.id || p.prop_id) === pid);
    return p?.label || pid;
  };

  return (
    <Modal visible={visible} animationType="fade" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.safe}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>{formatMonthTitle(yearMonth)}</Text>
            <TouchableOpacity activeOpacity={0.7} onPress={onClose} style={styles.closeBtn}>
              <Ionicons name="close-circle" size={28} color={Colors.textDim} />
            </TouchableOpacity>
          </View>

          {/* Tab bar */}
          <View style={styles.tabBar}>
            <TouchableOpacity activeOpacity={0.7}
              style={[styles.tab, tab === 'income' && styles.tabActive]}
              onPress={() => { setTab('income'); setEditingId(null); }}
            >
              <Text style={[styles.tabText, tab === 'income' && styles.tabTextActive]}>
                Income ({income.length})
              </Text>
            </TouchableOpacity>
            <TouchableOpacity activeOpacity={0.7}
              style={[styles.tab, tab === 'expenses' && styles.tabActive]}
              onPress={() => { setTab('expenses'); setEditingId(null); }}
            >
              <Text style={[styles.tabText, tab === 'expenses' && styles.tabTextActive]}>
                Expenses ({expenses.length})
              </Text>
            </TouchableOpacity>
          </View>

          {loading ? (
            <View style={styles.center}>
              <ActivityIndicator size="large" color={Colors.green} />
            </View>
          ) : displayList.length === 0 ? (
            <View style={styles.emptyState}>
              <Ionicons name="receipt-outline" size={40} color={Colors.textDim} />
              <Text style={styles.emptyTitle}>No {tab} data</Text>
              <Text style={styles.emptySub}>
                Connect Plaid or add manual {tab} in Settings to see transaction details here.
              </Text>
            </View>
          ) : (
            <ScrollView style={styles.list} contentContainerStyle={styles.listContent}
              keyboardShouldPersistTaps="handled">
              {displayList.map((t, i) => {
                const isEditing = editingId === t.id;
                return (
                  <View key={t.id || i}>
                    {i > 0 && <View style={styles.txBorder} />}

                    {/* Read mode row */}
                    <TouchableOpacity activeOpacity={0.7} onPress={() => startEdit(t)} style={styles.txRow}>
                      <View style={styles.txInfo}>
                        <Text style={styles.txName} numberOfLines={1}>
                          {t.payee || t.name || t.merchant || t.description || 'Unknown Payee'}
                        </Text>
                        <Text style={styles.txMeta}>
                          {t.date || ''}
                          {t.property_tag && !t.property_tag.startsWith('__') ? ` · ${propLabel(t.property_tag)}` : ''}
                          {t.category_tag === '__rental_income__' ? ' · Airbnb Income' : ''}
                          {t.category_tag === '__cleaning_income__' ? ' · Cleaning Income' : ''}
                          {t.category_tag === '__internal_transfer__' ? ' · Transfer' : ''}
                          {t.category_tag && !t.category_tag.startsWith('__') ? ` · ${t.category_tag}` : ''}
                          {t.auto_tagged ? ' · auto' : ''}
                        </Text>
                        {t.account && <Text style={styles.txSource}>{t.account}</Text>}
                      </View>
                      <View style={styles.txRight}>
                        <Text style={[styles.txAmount, {
                          color: tab === 'income' ? Colors.green : Colors.red,
                        }]}>
                          {fmt$(Math.abs(t.amount ?? 0))}
                        </Text>
                        <Ionicons
                          name={isEditing ? 'chevron-up' : 'create-outline'}
                          size={14}
                          color={isEditing ? Colors.primary : Colors.textDim}
                          style={{ marginTop: 2 }}
                        />
                      </View>
                    </TouchableOpacity>

                    {/* Edit mode */}
                    {isEditing && (
                      <View style={styles.editCard}>
                        <View style={styles.editRow}>
                          <Text style={styles.editLabel}>Amount</Text>
                          <TextInput
                            style={styles.editInput}
                            value={editFields.amount}
                            onChangeText={v => setEditFields(f => ({ ...f, amount: v }))}
                            keyboardType="decimal-pad"
                            placeholder="0.00"
                            placeholderTextColor={Colors.textDim}
                          />
                        </View>
                        <View style={styles.editRow}>
                          <Text style={styles.editLabel}>Name</Text>
                          <TextInput
                            style={styles.editInput}
                            value={editFields.name}
                            onChangeText={v => setEditFields(f => ({ ...f, name: v }))}
                            placeholder="Transaction name"
                            placeholderTextColor={Colors.textDim}
                          />
                        </View>
                        <View style={styles.editRow}>
                          <Text style={styles.editLabel}>Date</Text>
                          <TextInput
                            style={styles.editInput}
                            value={editFields.date}
                            onChangeText={v => setEditFields(f => ({ ...f, date: v }))}
                            placeholder="YYYY-MM-DD"
                            placeholderTextColor={Colors.textDim}
                          />
                        </View>
                        <View style={styles.editRow}>
                          <Text style={styles.editLabel}>Category</Text>
                          <TextInput
                            style={styles.editInput}
                            value={editFields.category}
                            onChangeText={v => setEditFields(f => ({ ...f, category: v }))}
                            placeholder="e.g. utilities, rent"
                            placeholderTextColor={Colors.textDim}
                          />
                        </View>

                        {/* Property tag picker */}
                        {properties.length > 0 && (
                          <View style={styles.editRow}>
                            <Text style={styles.editLabel}>Property</Text>
                            <ScrollView horizontal showsHorizontalScrollIndicator={false}
                              style={styles.tagScroll} contentContainerStyle={styles.tagScrollContent}>
                              <TouchableOpacity activeOpacity={0.7}
                                style={[styles.tagPill, !editFields.property_tag && styles.tagPillActive]}
                                onPress={() => setEditFields(f => ({ ...f, property_tag: '' }))}
                              >
                                <Text style={[styles.tagPillText, !editFields.property_tag && styles.tagPillTextActive]}>
                                  None
                                </Text>
                              </TouchableOpacity>
                              {properties.map(p => (
                                <TouchableOpacity key={p.id} activeOpacity={0.7}
                                  style={[styles.tagPill, editFields.property_tag === p.id && styles.tagPillActive]}
                                  onPress={() => setEditFields(f => ({ ...f, property_tag: p.id }))}
                                >
                                  <Text style={[styles.tagPillText, editFields.property_tag === p.id && styles.tagPillTextActive]}>
                                    {p.label || p.id}
                                  </Text>
                                </TouchableOpacity>
                              ))}
                            </ScrollView>
                          </View>
                        )}

                        {/* Save / Cancel */}
                        <View style={styles.editBtns}>
                          <TouchableOpacity activeOpacity={0.7}
                            style={styles.editCancelBtn}
                            onPress={() => { setEditingId(null); setEditFields({}); }}>
                            <Text style={styles.editCancelText}>Cancel</Text>
                          </TouchableOpacity>
                          <TouchableOpacity activeOpacity={0.7}
                            style={[styles.editSaveBtn, saving && { opacity: 0.5 }]}
                            onPress={handleSave}
                            disabled={saving}>
                            {saving ? (
                              <ActivityIndicator size="small" color="#fff" />
                            ) : (
                              <>
                                <Ionicons name="checkmark" size={16} color="#fff" />
                                <Text style={styles.editSaveText}>Save</Text>
                              </>
                            )}
                          </TouchableOpacity>
                        </View>
                      </View>
                    )}
                  </View>
                );
              })}
            </ScrollView>
          )}

          {/* Totals footer */}
          {!loading && displayList.length > 0 && (
            <View style={styles.footer}>
              <View>
                <Text style={styles.footerLabel}>Total {tab === 'income' ? 'Income' : 'Expenses'}</Text>
                <Text style={styles.footerCount}>{displayList.length} transaction{displayList.length !== 1 ? 's' : ''}</Text>
              </View>
              <Text style={[styles.footerValue, {
                color: tab === 'income' ? Colors.green : Colors.red,
              }]}>
                {fmt$(total)}
              </Text>
            </View>
          )}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border,
  },
  title: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text },
  closeBtn: { padding: 4 },
  tabBar: {
    flexDirection: 'row', marginHorizontal: Spacing.md, marginTop: Spacing.sm,
    backgroundColor: Colors.glassDark, borderRadius: Radius.pill, padding: 2,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
  },
  tab: {
    flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: Radius.pill,
  },
  tabActive: { backgroundColor: Colors.glass },
  tabText: { fontSize: FontSize.sm, color: Colors.textDim, fontWeight: '500' },
  tabTextActive: { color: Colors.text, fontWeight: '600' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyState: {
    flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.lg,
  },
  emptyTitle: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text, marginTop: Spacing.md },
  emptySub: { fontSize: FontSize.sm, color: Colors.textDim, textAlign: 'center', marginTop: Spacing.xs },
  list: { flex: 1 },
  listContent: { padding: Spacing.md },
  txRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: Spacing.sm,
  },
  txBorder: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.border },
  txInfo: { flex: 1, marginRight: Spacing.sm },
  txName: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.text },
  txMeta: { fontSize: FontSize.xs, color: Colors.textDim, marginTop: 2 },
  txSource: { fontSize: 9, color: Colors.textDim, marginTop: 1, fontStyle: 'italic' },
  txRight: { alignItems: 'flex-end', gap: 2 },
  txAmount: { fontSize: FontSize.md, fontWeight: '700' },

  // Edit card
  editCard: {
    backgroundColor: Colors.glassHeavy,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 12 },
    }),
  },
  editRow: { marginBottom: Spacing.sm },
  editLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '500', marginBottom: 4 },
  editInput: {
    backgroundColor: Colors.bg, borderWidth: 1, borderColor: Colors.border,
    borderRadius: Radius.md, padding: Spacing.sm, paddingHorizontal: Spacing.md,
    color: Colors.text, fontSize: FontSize.sm,
  },
  tagScroll: { maxHeight: 36 },
  tagScrollContent: { gap: 6 },
  tagPill: {
    paddingHorizontal: Spacing.sm, paddingVertical: 6,
    borderRadius: Radius.pill, borderWidth: 0.5,
    borderColor: Colors.glassBorder, backgroundColor: Colors.glassDark,
  },
  tagPillActive: { backgroundColor: Colors.greenDim, borderColor: Colors.primary },
  tagPillText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  tagPillTextActive: { color: Colors.primary, fontWeight: '600' },
  editBtns: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.xs },
  editCancelBtn: {
    flex: 1, padding: Spacing.sm, borderRadius: Radius.md,
    backgroundColor: Colors.glassDark, alignItems: 'center',
    borderWidth: 0.5, borderColor: Colors.glassBorder,
  },
  editCancelText: { color: Colors.textSecondary, fontSize: FontSize.sm },
  editSaveBtn: {
    flex: 1, padding: Spacing.sm, borderRadius: Radius.md,
    backgroundColor: Colors.green, alignItems: 'center',
    flexDirection: 'row', justifyContent: 'center', gap: 4,
  },
  editSaveText: { color: '#fff', fontSize: FontSize.sm, fontWeight: '600' },

  footer: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border,
    backgroundColor: Colors.glassHeavy,
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: -2 }, shadowOpacity: 0.12, shadowRadius: 16 },
    }),
  },
  footerLabel: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  footerCount: { fontSize: FontSize.xs, color: Colors.textDim, marginTop: 1 },
  footerValue: { fontSize: FontSize.xl, fontWeight: '800' },
});
