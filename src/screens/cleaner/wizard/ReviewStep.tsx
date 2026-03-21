import React, { useState, useMemo } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  TextInput, Alert, Platform, Modal, KeyboardAvoidingView,
  ActivityIndicator,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../../../constants/theme';
import { CleanerEvent, InvoiceLineItem } from '../../../store/cleanerStore';
import { fmt$ , localDateStr } from '../../../utils/format';
import { glassAlert } from '../../../components/GlassAlert';

const CLEANING_TYPES = [
  'Standard Cleaning',
  'Extra Cleaning',
  'Deep Cleaning',
  'Errand Run',
  'Supply Drop Off',
  'Purchase of Supplies',
] as const;

interface Props {
  selectedCleanings: Map<string, CleanerEvent>;
  manualLineItems: InvoiceLineItem[];
  rates: Record<string, number>;
  hostName: string;
  onRateChange: (propId: string, rate: number) => void;
  onRemoveCleaning: (uid: string) => void;
  onAddManualItem: (item: InvoiceLineItem) => void;
  onRemoveManualItem: (index: number) => void;
  onCreateInvoice: (lineItems: InvoiceLineItem[], total: number, period: string, eventUids: string[]) => void;
  creating: boolean;
}

export function ReviewStep({
  selectedCleanings, manualLineItems, rates, hostName,
  onRateChange, onRemoveCleaning, onAddManualItem, onRemoveManualItem,
  onCreateInvoice, creating,
}: Props) {
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  // Group cleanings by property
  const grouped = useMemo(() => {
    const groups = new Map<string, { propName: string; events: CleanerEvent[] }>();
    selectedCleanings.forEach((ev) => {
      const key = ev.prop_id;
      if (!groups.has(key)) groups.set(key, { propName: ev.prop_name, events: [] });
      groups.get(key)!.events.push(ev);
    });
    // Sort events by date within each group
    groups.forEach(g => g.events.sort((a, b) => a.check_out.localeCompare(b.check_out)));
    return groups;
  }, [selectedCleanings]);

  // Build line items
  const autoLineItems = useMemo((): InvoiceLineItem[] => {
    const items: InvoiceLineItem[] = [];
    grouped.forEach((group, propId) => {
      const rate = rates[propId] || 0;
      group.events.forEach(ev => {
        items.push({
          date: (ev.check_out || '').slice(0, 10),
          propertyName: ev.unit_name || ev.prop_name,
          cleaningType: 'Standard Cleaning',
          rate,
          amount: rate,
          uid: ev.uid,
          unit_name: ev.unit_name,
          feed_key: ev.feed_key,
        });
      });
    });
    return items;
  }, [grouped, rates]);

  const allLineItems = [...autoLineItems, ...manualLineItems];
  const total = allLineItems.reduce((s, li) => s + li.amount, 0);

  // Generate period label from date range
  const period = useMemo(() => {
    const dates = autoLineItems.map(li => li.date).filter(Boolean).sort();
    if (dates.length === 0) return 'Custom';
    const first = new Date(dates[0] + 'T12:00:00');
    const last = new Date(dates[dates.length - 1] + 'T12:00:00');
    const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
    if (first.getTime() === last.getTime()) {
      return first.toLocaleDateString('en-US', { ...opts, year: 'numeric' });
    }
    return `${first.toLocaleDateString('en-US', opts)} – ${last.toLocaleDateString('en-US', { ...opts, year: 'numeric' })}`;
  }, [autoLineItems]);

  const eventUids = useMemo(() => {
    return Array.from(selectedCleanings.keys());
  }, [selectedCleanings]);

  const handleCreate = () => {
    if (allLineItems.length === 0) {
      glassAlert('No Items', 'Add at least one cleaning or manual line item.');
      return;
    }
    onCreateInvoice(allLineItems, total, period, eventUids);
  };

  return (
    <ScrollView automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled" style={styles.scroll} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Review Invoice</Text>
      <Text style={styles.subHeading}>{hostName} · {period}</Text>

      {/* Auto-populated cleanings grouped by property */}
      {Array.from(grouped.entries()).map(([propId, group]) => {
        const rate = rates[propId] || 0;
        return (
          <View key={propId} style={styles.propGroup}>
            <View style={styles.propHeader}>
              <Text style={styles.propName}>{group.propName}</Text>
              <View style={styles.rateWrap}>
                <Text style={styles.rateLabel}>Rate: $</Text>
                <TextInput
                  style={styles.rateInput}
                  keyboardType="decimal-pad"
                  defaultValue={rate > 0 ? String(rate) : ''}
                  placeholder="0"
                  placeholderTextColor={Colors.textDim}
                  onEndEditing={(e) => {
                    const val = parseFloat(e.nativeEvent.text) || 0;
                    onRateChange(propId, val);
                  }}
                  returnKeyType="done"
                />
              </View>
            </View>
            {group.events.map((ev) => (
              <View key={ev.uid} style={styles.lineItem}>
                <View style={styles.lineLeft}>
                  <Text style={styles.lineDate}>
                    {ev.check_out ? new Date(ev.check_out.slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
                  </Text>
                  <Text style={styles.lineUnit} numberOfLines={1}>
                    {ev.unit_name || ev.prop_name}
                  </Text>
                </View>
                <Text style={styles.lineAmount}>{fmt$(rate)}</Text>
                <TouchableOpacity
                  activeOpacity={0.7}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  onPress={() => onRemoveCleaning(ev.uid)}
                >
                  <Ionicons name="close-circle" size={18} color={Colors.red} />
                </TouchableOpacity>
              </View>
            ))}
            <View style={styles.subtotalRow}>
              <Text style={styles.subtotalLabel}>Subtotal</Text>
              <Text style={styles.subtotalValue}>{fmt$(group.events.length * rate)}</Text>
            </View>
          </View>
        );
      })}

      {/* Manual line items */}
      {manualLineItems.length > 0 && (
        <View style={styles.propGroup}>
          <Text style={styles.propName}>Additional Items</Text>
          {manualLineItems.map((item, i) => (
            <TouchableOpacity key={i} activeOpacity={0.6} style={styles.lineItem}
              onPress={() => { setEditingIndex(i); setShowAddModal(true); }}>
              <View style={styles.lineLeft}>
                <Text style={styles.lineDate}>{item.cleaningType}</Text>
                {item.propertyName ? (
                  <Text style={styles.lineUnit} numberOfLines={1}>{item.propertyName}</Text>
                ) : null}
              </View>
              <Text style={styles.lineAmount}>{fmt$(item.amount)}</Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <TouchableOpacity activeOpacity={0.5}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  onPress={() => { setEditingIndex(i); setShowAddModal(true); }}>
                  <Ionicons name="pencil" size={16} color={Colors.textSecondary} />
                </TouchableOpacity>
                <TouchableOpacity activeOpacity={0.5}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  onPress={() => onRemoveManualItem(i)}>
                  <Ionicons name="close-circle" size={18} color={Colors.red} />
                </TouchableOpacity>
              </View>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Add manual item */}
      <TouchableOpacity
        activeOpacity={0.6}
        style={styles.addBtn}
        onPress={() => { setEditingIndex(null); setShowAddModal(true); }}
      >
        <Ionicons name="add-circle-outline" size={16} color={Colors.primary} />
        <Text style={styles.addBtnText}>Add Line Item</Text>
      </TouchableOpacity>

      {/* Grand total */}
      <View style={styles.totalRow}>
        <Text style={styles.totalLabel}>Grand Total</Text>
        <Text style={styles.totalValue}>{fmt$(total)}</Text>
      </View>

      {/* Create button */}
      <TouchableOpacity
        activeOpacity={0.7}
        style={[styles.createBtn, creating && { opacity: 0.6 }]}
        onPress={handleCreate}
        disabled={creating}
      >
        {creating ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <>
            <Ionicons name="document-text-outline" size={18} color="#fff" />
            <Text style={styles.createBtnText}>Create Invoice</Text>
          </>
        )}
      </TouchableOpacity>

      {/* Add manual item modal */}
      <AddManualItemModal
        visible={showAddModal}
        onClose={() => { setShowAddModal(false); setEditingIndex(null); }}
        onAdd={(item) => {
          if (editingIndex !== null) {
            // Edit: remove old, add updated
            onRemoveManualItem(editingIndex);
            onAddManualItem(item);
          } else {
            onAddManualItem(item);
          }
          setShowAddModal(false);
          setEditingIndex(null);
        }}
        editData={editingIndex !== null ? manualLineItems[editingIndex] : undefined}
        properties={Array.from(grouped.entries()).map(([pid, g]) => ({
          id: pid,
          label: g.propName,
          units: g.events.map(e => e.unit_name || e.prop_name).filter((v, i, a) => a.indexOf(v) === i),
        }))}
      />
    </ScrollView>
  );
}

function AddManualItemModal({ visible, onClose, onAdd, properties, editData }: {
  visible: boolean;
  onClose: () => void;
  onAdd: (item: InvoiceLineItem) => void;
  properties: { id: string; label: string; units: string[] }[];
  editData?: InvoiceLineItem;
}) {
  const isEditing = !!editData;
  const [type, setType] = useState<string>(editData?.cleaningType || CLEANING_TYPES[2]);
  const [description, setDescription] = useState(editData?.propertyName?.split(' — ')[1] || '');
  const [amount, setAmount] = useState(editData ? String(editData.amount) : '');
  const [selectedProp, setSelectedProp] = useState<string>(
    editData?.propertyName?.split(' — ')[0] || properties[0]?.label || ''
  );
  const hasMultiple = properties.length > 1 || properties.some(p => p.units.length > 1);

  // Reset when modal opens with new data
  React.useEffect(() => {
    if (visible) {
      setType(editData?.cleaningType || CLEANING_TYPES[2]);
      setDescription(editData?.propertyName?.split(' — ')[1] || '');
      setAmount(editData ? String(editData.amount) : '');
      setSelectedProp(editData?.propertyName?.split(' — ')[0] || properties[0]?.label || '');
    }
  }, [visible, editData]);

  const handleAdd = () => {
    const amountNum = parseFloat(amount) || 0;
    if (amountNum <= 0) return;
    onAdd({
      date: localDateStr(),
      propertyName: selectedProp + (description ? ` — ${description}` : ''),
      cleaningType: type,
      rate: amountNum,
      amount: amountNum,
    });
    setType(CLEANING_TYPES[2]);
    setDescription('');
    setAmount('');
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView style={modalStyles.overlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={modalStyles.card}>
          <Text style={modalStyles.title}>{isEditing ? 'Edit Line Item' : 'Add Line Item'}</Text>

          {/* Property picker — only show when multiple properties/units */}
          {hasMultiple && (
            <>
              <Text style={modalStyles.label}>Property / Unit</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: Spacing.sm }}>
                <View style={modalStyles.typePills}>
                  {properties.flatMap(p =>
                    p.units.length > 1
                      ? p.units.map(u => ({ key: u, label: u }))
                      : [{ key: p.label, label: p.label }]
                  ).map(opt => (
                    <TouchableOpacity
                      key={opt.key}
                      activeOpacity={0.6}
                      style={[modalStyles.typePill, selectedProp === opt.key && modalStyles.typePillActive]}
                      onPress={() => setSelectedProp(opt.key)}
                    >
                      <Text style={[modalStyles.typePillText, selectedProp === opt.key && modalStyles.typePillTextActive]}>
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </ScrollView>
            </>
          )}

          <Text style={modalStyles.label}>Type</Text>
          <View style={modalStyles.typePills}>
            {CLEANING_TYPES.map(t => (
              <TouchableOpacity
                key={t}
                activeOpacity={0.7}
                style={[modalStyles.typePill, type === t && modalStyles.typePillActive]}
                onPress={() => setType(t)}
              >
                <Text style={[modalStyles.typePillText, type === t && modalStyles.typePillTextActive]}>{t}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={modalStyles.label}>Description (optional)</Text>
          <TextInput
            style={modalStyles.input}
            value={description}
            onChangeText={setDescription}
            placeholder="e.g. Extra towels"
            placeholderTextColor={Colors.textDim}
          />

          <Text style={modalStyles.label}>Amount</Text>
          <View style={modalStyles.amountRow}>
            <Text style={modalStyles.dollar}>$</Text>
            <TextInput
              style={[modalStyles.input, { flex: 1 }]}
              value={amount}
              onChangeText={setAmount}
              placeholder="0.00"
              placeholderTextColor={Colors.textDim}
              keyboardType="decimal-pad"
            />
          </View>

          <View style={modalStyles.actions}>
            <TouchableOpacity activeOpacity={0.7} style={modalStyles.cancelBtn} onPress={onClose}>
              <Text style={modalStyles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              activeOpacity={0.7}
              style={[modalStyles.addBtn, (parseFloat(amount) || 0) <= 0 && { opacity: 0.4 }]}
              disabled={(parseFloat(amount) || 0) <= 0}
              onPress={handleAdd}
            >
              <Text style={modalStyles.addText}>{isEditing ? 'Save' : 'Add'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: Spacing.md, paddingBottom: Spacing.xl * 2 },
  heading: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text },
  subHeading: { fontSize: FontSize.sm, color: Colors.textSecondary, marginBottom: Spacing.lg },
  propGroup: {
    backgroundColor: Colors.glassHeavy, borderRadius: Radius.xl,
    padding: Spacing.md, marginBottom: Spacing.md,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
    borderTopColor: Colors.glassHighlight, borderTopWidth: 1,
    overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.35, shadowRadius: 20 },
    }),
  },
  propHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: Spacing.sm, paddingBottom: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: Colors.border,
  },
  propName: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, marginBottom: Spacing.xs },
  rateWrap: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.glassDark, borderRadius: Radius.sm,
    paddingHorizontal: Spacing.sm, paddingVertical: 4,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
  },
  rateLabel: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.textDim },
  rateInput: {
    fontSize: FontSize.sm, fontWeight: '600', color: Colors.text,
    minWidth: 40, padding: 0,
  },
  lineItem: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    paddingVertical: Spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: Colors.border,
  },
  lineLeft: { flex: 1 },
  lineDate: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.textSecondary },
  lineUnit: { fontSize: FontSize.xs, color: Colors.textDim, marginTop: 1 },
  lineAmount: { fontSize: FontSize.md, fontWeight: '600', color: Colors.green },
  subtotalRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    paddingTop: Spacing.sm,
  },
  subtotalLabel: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.textSecondary },
  subtotalValue: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.green },
  addBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: Spacing.sm, marginBottom: Spacing.md,
    borderWidth: 1, borderColor: Colors.primary, borderRadius: Radius.md,
    borderStyle: 'dashed',
  },
  addBtnText: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.primary },
  totalRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: Colors.glassHeavy, borderRadius: Radius.xl,
    padding: Spacing.md, marginBottom: Spacing.lg,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
    borderTopColor: Colors.glassHighlight, borderTopWidth: 1,
    overflow: 'hidden',
  },
  totalLabel: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  totalValue: { fontSize: FontSize.xl, fontWeight: '800', color: Colors.green },
  createBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: Colors.green, borderRadius: Radius.lg,
    paddingVertical: Spacing.md,
    ...Platform.select({
      ios: { shadowColor: Colors.primary, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 20 },
    }),
  },
  createBtnText: { color: '#fff', fontSize: FontSize.md, fontWeight: '600' },
});

const modalStyles = StyleSheet.create({
  overlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center', padding: Spacing.lg,
  },
  card: {
    backgroundColor: Colors.bg, borderRadius: Radius.xl, padding: Spacing.lg,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.15, shadowRadius: 24 },
    }),
  },
  title: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginBottom: Spacing.md },
  label: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.textSecondary, marginBottom: Spacing.xs, marginTop: Spacing.sm },
  input: {
    backgroundColor: Colors.glassHeavy, borderWidth: 1, borderColor: Colors.border,
    borderRadius: Radius.md, padding: Spacing.md, color: Colors.text, fontSize: FontSize.md,
  },
  typePills: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.xs },
  typePill: {
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: Radius.pill,
    backgroundColor: Colors.glassDark, borderWidth: 0.5, borderColor: Colors.glassBorder,
  },
  typePillActive: { backgroundColor: Colors.greenDim, borderColor: Colors.primary },
  typePillText: { fontSize: FontSize.xs, color: Colors.textDim, fontWeight: '500' },
  typePillTextActive: { color: Colors.primary, fontWeight: '600' },
  amountRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  dollar: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.text },
  actions: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.lg },
  cancelBtn: {
    flex: 1, alignItems: 'center', paddingVertical: Spacing.sm + 2,
    borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border,
  },
  cancelText: { fontSize: FontSize.md, color: Colors.textSecondary, fontWeight: '500' },
  addBtn: {
    flex: 1, alignItems: 'center', paddingVertical: Spacing.sm + 2,
    borderRadius: Radius.md, backgroundColor: Colors.green,
  },
  addText: { fontSize: FontSize.md, color: '#fff', fontWeight: '600' },
});
