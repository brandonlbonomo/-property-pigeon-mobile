import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl, Platform,
  TouchableOpacity, ActivityIndicator, TextInput, Alert, Modal,
  KeyboardAvoidingView,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';

import { useDataStore } from '../../store/dataStore';
import { useUserStore } from '../../store/userStore';
import { apiFetch } from '../../services/api';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import {
  CATEGORIES, CATALOG_ITEMS, getCatalogByCategory, findCatalogItem,
  type InventoryCategory, type CatalogItem,
} from '../../constants/inventoryCatalog';

type UnitType = 'count' | 'oz' | 'gal';
const UNIT_LABELS: Record<UnitType, string> = { count: '', oz: 'oz', gal: 'gal' };

/** Count iCal feeds for a property — uses property.icalFeeds array or falls back to dataStore feeds. */
function countFeedsForProperty(property: any): number {
  return (property.icalFeeds || []).length;
}

// ── Add Group Modal (tap a property or city to instantly create) ──

function AddGroupModal({ visible, onClose, onSave, existingGroupIds }: {
  visible: boolean; onClose: () => void;
  onSave: (data: { name: string; linkType: string; propertyId?: string; city?: string }) => void;
  existingGroupIds: Set<string>;
}) {
  const properties = useUserStore(s => s.profile?.properties) || [];

  // Group properties by market/city
  const airbnbProps = properties.filter((p: any) => p.isAirbnb);
  const cities = [...new Set(airbnbProps.map((p: any) => p.market).filter(Boolean))] as string[];

  const icalCountByProp = (p: any) => countFeedsForProperty(p);

  // Check if group already exists for this property/city
  const hasGroup = (id: string) => existingGroupIds.has(id);

  const handleTapProperty = (p: any) => {
    if (hasGroup(p.id || p.name)) return;
    onSave({
      name: p.label || p.name,
      linkType: 'property',
      propertyId: p.id || p.name,
    });
    onClose();
  };

  const handleTapCity = (city: string) => {
    const cityId = `city_${city.toLowerCase().replace(/\s+/g, '_')}`;
    if (hasGroup(cityId)) return;
    onSave({
      name: city,
      linkType: 'city',
      city,
    });
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide">
      <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.modalCard}>
          <View style={styles.modalHandle} />
          <Text style={styles.modalSectionLabel}>ADD INVENTORY GROUP</Text>
          <Text style={styles.modalHelpText}>
            Tap a property or city to start tracking its supplies.
          </Text>

          <ScrollView style={{ maxHeight: 340 }} showsVerticalScrollIndicator={false}>
            {/* ── By Property ── */}
            {airbnbProps.length > 0 && (
              <>
                <Text style={styles.pickerSectionLabel}>PROPERTIES</Text>
                {airbnbProps.map((p: any) => {
                  const feeds = icalCountByProp(p);
                  const already = hasGroup(p.id || p.name);
                  return (
                    <TouchableOpacity key={p.id || p.name} activeOpacity={already ? 1 : 0.7}
                      style={[styles.propPickerRow, already && styles.propPickerRowDone]}
                      onPress={() => handleTapProperty(p)}>
                      <View style={styles.propPickerIcon}>
                        <Ionicons name="home" size={18} color={already ? Colors.textDim : Colors.text} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.propPickerName, already && { color: Colors.textDim }]}>
                          {p.label || p.name}
                        </Text>
                        <View style={styles.propPickerMetaRow}>
                          {p.market && (
                            <Text style={styles.propPickerMeta}>{p.market}</Text>
                          )}
                          <Text style={styles.propPickerMeta}>
                            {p.units || 1} unit{(p.units || 1) !== 1 ? 's' : ''}
                          </Text>
                          <Text style={[styles.propPickerMeta, feeds > 0 && { color: Colors.green }]}>
                            {feeds} iCal feed{feeds !== 1 ? 's' : ''}
                          </Text>
                        </View>
                      </View>
                      {already ? (
                        <View style={styles.alreadyBadge}>
                          <Ionicons name="checkmark-circle" size={14} color={Colors.green} />
                          <Text style={styles.alreadyText}>Added</Text>
                        </View>
                      ) : (
                        <Ionicons name="add-circle" size={22} color={Colors.green} />
                      )}
                    </TouchableOpacity>
                  );
                })}
              </>
            )}

            {/* ── By City ── */}
            {cities.length > 0 && (
              <>
                <Text style={[styles.pickerSectionLabel, { marginTop: Spacing.md }]}>BY CITY</Text>
                <Text style={styles.pickerSectionHint}>
                  Aggregate all properties in a city into one inventory group
                </Text>
                {cities.map(city => {
                  const cityId = `city_${city.toLowerCase().replace(/\s+/g, '_')}`;
                  const already = hasGroup(cityId);
                  const propCount = airbnbProps.filter((p: any) => p.market === city).length;
                  const feedCount = airbnbProps
                    .filter((p: any) => p.market === city)
                    .reduce((sum: number, p: any) => sum + icalCountByProp(p), 0);
                  return (
                    <TouchableOpacity key={city} activeOpacity={already ? 1 : 0.7}
                      style={[styles.propPickerRow, already && styles.propPickerRowDone]}
                      onPress={() => handleTapCity(city)}>
                      <View style={styles.propPickerIcon}>
                        <Ionicons name="business" size={18} color={already ? Colors.textDim : Colors.text} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.propPickerName, already && { color: Colors.textDim }]}>{city}</Text>
                        <View style={styles.propPickerMetaRow}>
                          <Text style={styles.propPickerMeta}>
                            {propCount} propert{propCount !== 1 ? 'ies' : 'y'}
                          </Text>
                          <Text style={[styles.propPickerMeta, feedCount > 0 && { color: Colors.green }]}>
                            {feedCount} iCal feed{feedCount !== 1 ? 's' : ''}
                          </Text>
                        </View>
                      </View>
                      {already ? (
                        <View style={styles.alreadyBadge}>
                          <Ionicons name="checkmark-circle" size={14} color={Colors.green} />
                          <Text style={styles.alreadyText}>Added</Text>
                        </View>
                      ) : (
                        <Ionicons name="add-circle" size={22} color={Colors.green} />
                      )}
                    </TouchableOpacity>
                  );
                })}
              </>
            )}

            {airbnbProps.length === 0 && (
              <View style={styles.noPropWrap}>
                <Ionicons name="home-outline" size={32} color={Colors.textDim} />
                <Text style={styles.noPropText}>No Airbnb properties added yet.</Text>
                <Text style={styles.noPropHint}>Add properties in Settings to start tracking inventory.</Text>
              </View>
            )}
          </ScrollView>

          <TouchableOpacity activeOpacity={0.7} style={styles.modalCancelBtnFull} onPress={onClose}>
            <Text style={styles.modalCancelText}>Close</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Restock Modal ──

function RestockModal({ item, onClose, onSave }: {
  item: any; onClose: () => void;
  onSave: (itemId: string, newQty: number) => void;
}) {
  const [qty, setQty] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const num = parseFloat(qty);
    if (isNaN(num) || num <= 0) { Alert.alert('Invalid', 'Enter a valid quantity'); return; }
    setSaving(true);
    await onSave(item.id, (item.base_qty ?? item.current_qty ?? 0) + num);
    setSaving(false);
  };

  const effectiveQty = item?.effective_qty ?? item?.current_qty ?? 0;
  const baseQty = item?.base_qty ?? effectiveQty;
  const parsed = parseFloat(qty);
  const unitLabel = item?.unit ? ` ${item.unit}` : '';

  return (
    <Modal visible={!!item} transparent animationType="slide">
      <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.modalCard}>
          <View style={styles.modalHandle} />
          <Text style={styles.modalSectionLabel}>RESTOCK: {(item?.name ?? '').toUpperCase()}</Text>
          <Text style={styles.restockCurrent}>
            Effective stock: <Text style={{ fontWeight: '700' }}>{Math.round(effectiveQty)}{unitLabel}</Text>
          </Text>
          {baseQty !== effectiveQty && (
            <Text style={[styles.restockCurrent, { fontSize: FontSize.xs - 1, marginTop: -8 }]}>
              Base (pre-depletion): {Math.round(baseQty)}{unitLabel}
            </Text>
          )}
          <TextInput
            style={styles.restockInput} value={qty} onChangeText={setQty}
            keyboardType="numeric" placeholder="Quantity to add" placeholderTextColor={Colors.textDim}
          />
          {qty && !isNaN(parsed) && parsed > 0 && (
            <Text style={styles.restockNewTotal}>
              New base: {Math.round(baseQty + parsed)}{unitLabel}
            </Text>
          )}
          <View style={styles.modalBtns}>
            <TouchableOpacity activeOpacity={0.7} style={styles.modalCancelBtn} onPress={onClose}>
              <Text style={styles.modalCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity activeOpacity={0.7}
              style={[styles.restockSaveBtn, saving && { opacity: 0.5 }]}
              onPress={handleSave} disabled={saving}>
              <Ionicons name="add-circle" size={16} color="#fff" />
              <Text style={styles.modalSaveText}>{saving ? 'Saving...' : 'Add Stock'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Inline Add Item Form (Category-based) ──

interface AddItemPayload {
  name: string; unit: UnitType; initialQty: number; perStay: number;
  threshold: number; category?: string; catalogName?: string; isCleanerOnly?: boolean;
}

function AddItemForm({ onAdd, onCancel }: {
  onAdd: (item: AddItemPayload) => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<'category' | 'item'>('category');
  const [selectedCategory, setSelectedCategory] = useState<InventoryCategory | null>(null);
  const [selectedCatalog, setSelectedCatalog] = useState<CatalogItem | null>(null);
  const [name, setName] = useState('');
  const [unit, setUnit] = useState<UnitType>('count');
  const [initialQty, setInitialQty] = useState('');
  const [perStay, setPerStay] = useState('');
  const [threshold, setThreshold] = useState('5');
  const [isCleanerOnly, setIsCleanerOnly] = useState(false);

  const catMeta = selectedCategory ? CATEGORIES.find(c => c.key === selectedCategory) : null;
  const catalogItems = selectedCategory ? getCatalogByCategory(selectedCategory) : [];

  const defaultRate = selectedCatalog
    ? (isCleanerOnly ? (selectedCatalog.cleanerPerStay ?? selectedCatalog.defaultPerStay) : selectedCatalog.defaultPerStay)
    : 0;

  const handleSelectCategory = (cat: InventoryCategory) => {
    setSelectedCategory(cat);
    setStep('item');
    setSelectedCatalog(null);
    setName('');
    setIsCleanerOnly(false);
  };

  const handleSelectCatalogItem = (item: CatalogItem) => {
    setSelectedCatalog(item);
    setName(item.name);
    setUnit(item.defaultUnit === '' ? 'count' : item.defaultUnit as UnitType);
    setPerStay('');
    setIsCleanerOnly(false);
  };

  const handleAdd = () => {
    if (!name.trim()) { Alert.alert('Required', 'Enter an item name'); return; }
    const effectivePerStay = parseFloat(perStay) || defaultRate;
    onAdd({
      name: name.trim(),
      unit,
      initialQty: parseFloat(initialQty) || 0,
      perStay: effectivePerStay,
      threshold: parseInt(threshold) || 5,
      category: selectedCategory || undefined,
      catalogName: selectedCatalog?.name || undefined,
      isCleanerOnly,
    });
  };

  // Step 1: Category Selection
  if (step === 'category') {
    return (
      <View style={styles.addItemForm}>
        <Text style={styles.addItemTitle}>SELECT CATEGORY</Text>
        <View style={styles.catGrid}>
          {CATEGORIES.map(cat => (
            <AnimatedPressable key={cat.key} style={styles.catPill}
              onPress={() => handleSelectCategory(cat.key)} scaleValue={0.95} opacityValue={0.7}>
              <Ionicons name={cat.icon as any} size={18} color={Colors.primary} />
              <Text style={styles.catPillText}>{cat.label}</Text>
            </AnimatedPressable>
          ))}
        </View>
        <TouchableOpacity activeOpacity={0.7} style={styles.addItemCancelBtn} onPress={onCancel}>
          <Text style={styles.addItemCancelText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Step 2: Item Selection + Config
  return (
    <View style={styles.addItemForm}>
      <View style={styles.stepHeader}>
        <TouchableOpacity activeOpacity={0.7} onPress={() => setStep('category')}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Ionicons name="chevron-back" size={16} color={Colors.primary} />
          <Text style={{ fontSize: FontSize.xs, color: Colors.primary, fontWeight: '600' }}>
            {catMeta?.label}
          </Text>
        </TouchableOpacity>
        <Text style={styles.addItemTitle}>ADD ITEM</Text>
      </View>

      {/* Catalog items as tappable chips */}
      {!selectedCatalog && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}
          style={{ marginBottom: Spacing.sm, marginHorizontal: -Spacing.md }}
          contentContainerStyle={{ paddingHorizontal: Spacing.md, gap: 6 }}>
          {catalogItems.map(ci => (
            <TouchableOpacity key={ci.name} activeOpacity={0.7}
              style={styles.catalogChip} onPress={() => handleSelectCatalogItem(ci)}>
              <Text style={styles.catalogChipText}>{ci.name}</Text>
              {ci.isStatic && <Text style={styles.catalogChipStatic}>STATIC</Text>}
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* Name input */}
      <TextInput style={styles.addItemInput} value={name} onChangeText={(t) => {
        setName(t);
        if (selectedCatalog && t !== selectedCatalog.name) setSelectedCatalog(null);
      }}
        placeholder={selectedCatalog ? selectedCatalog.name : 'Custom item name'}
        placeholderTextColor={Colors.textDim} />

      {/* Cleaner Only toggle (cleaning category only) */}
      {catMeta?.hasCleanerToggle && (
        <TouchableOpacity activeOpacity={0.7} style={styles.cleanerToggle}
          onPress={() => setIsCleanerOnly(!isCleanerOnly)}>
          <View style={[styles.cleanerCheck, isCleanerOnly && styles.cleanerCheckActive]}>
            {isCleanerOnly && <Ionicons name="checkmark" size={12} color="#fff" />}
          </View>
          <Text style={styles.cleanerToggleText}>Cleaner Only</Text>
          <Text style={styles.cleanerToggleHint}>
            {isCleanerOnly ? 'Higher depletion rate' : 'Guest-provided rate'}
          </Text>
        </TouchableOpacity>
      )}

      {/* Unit type */}
      <Text style={styles.addItemLabel}>Unit Type</Text>
      <View style={styles.unitToggleRow}>
        {(['count', 'oz', 'gal'] as UnitType[]).map(u => (
          <TouchableOpacity key={u} activeOpacity={0.7}
            style={[styles.unitBtn, unit === u && styles.unitBtnActive]}
            onPress={() => setUnit(u)}>
            <Text style={[styles.unitBtnText, unit === u && styles.unitBtnTextActive]}>
              {u === 'count' ? 'Count' : u === 'oz' ? 'Ounces' : 'Gallons'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Qty fields */}
      <View style={styles.addItemRow}>
        <View style={styles.addItemField}>
          <Text style={styles.addItemLabel}>Initial Qty</Text>
          <TextInput style={styles.addItemInput} value={initialQty} onChangeText={setInitialQty}
            placeholder="0" placeholderTextColor={Colors.textDim} keyboardType="numeric" />
        </View>
        <View style={styles.addItemField}>
          <Text style={styles.addItemLabel}>Per Stay</Text>
          <TextInput style={styles.addItemInput} value={perStay} onChangeText={setPerStay}
            placeholder={defaultRate ? String(defaultRate) : '0'}
            placeholderTextColor={Colors.textDim} keyboardType="numeric" />
          <Text style={styles.perStayHint}>
            {perStay
              ? `Custom: ${perStay} ${unit === 'count' ? '' : unit + ' '}per checkout`
              : defaultRate
                ? `Auto-depletes ${defaultRate} ${unit === 'count' ? '' : unit + ' '}per checkout`
                : selectedCatalog?.isStatic
                  ? 'Tracked manually — no auto-depletion'
                  : 'Set a rate to enable auto-depletion'}
          </Text>
        </View>
        <View style={styles.addItemField}>
          <Text style={styles.addItemLabel}>Alert At</Text>
          <TextInput style={styles.addItemInput} value={threshold} onChangeText={setThreshold}
            placeholder="5" placeholderTextColor={Colors.textDim} keyboardType="numeric" />
        </View>
      </View>

      <View style={styles.addItemBtns}>
        <TouchableOpacity activeOpacity={0.7} style={styles.addItemCancelBtn} onPress={onCancel}>
          <Text style={styles.addItemCancelText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.7} style={styles.addItemSaveBtn} onPress={handleAdd}>
          <Ionicons name="add-circle" size={14} color="#fff" />
          <Text style={styles.addItemSaveText}>Add</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ══════════════════════════════════════
// ── Main Screen ──
// ══════════════════════════════════════

export function InventoryScreen() {
  const { fetchInvGroups } = useDataStore();
  const [groups, setGroups] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [restockItem, setRestockItem] = useState<any>(null);
  const [showAddGroup, setShowAddGroup] = useState(false);
  const [addingItemGroup, setAddingItemGroup] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const properties = useUserStore(s => s.profile?.properties) || [];

  // Count iCal feeds linked to a group
  const getGroupFeedCount = useCallback((group: any) => {
    if (group.linkType === 'property' && group.propertyId) {
      const prop = properties.find((p: any) => (p.id || p.name) === group.propertyId);
      if (!prop) return 0;
      return countFeedsForProperty(prop);
    } else if (group.linkType === 'city' && group.city) {
      const cityProps = properties.filter((p: any) =>
        p.isAirbnb && p.market?.toLowerCase() === group.city.toLowerCase()
      );
      return cityProps.reduce((sum: number, p: any) =>
        sum + countFeedsForProperty(p), 0);
    }
    return 0;
  }, [properties]);

  const load = useCallback(async (force = false) => {
    try {
      const data = await fetchInvGroups(force);
      setGroups(Array.isArray(data) ? data : []);
    } catch (e) {
      // save failed
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [fetchInvGroups]);

  useEffect(() => { load(); }, []);
  const onRefresh = () => { setRefreshing(true); load(true); };

  const toggleGroup = (id: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // ── Handlers ──

  const handleAddGroup = (data: { name: string; linkType: string; propertyId?: string; city?: string }) => {
    const tempId = `temp_${Date.now()}`;
    const newGroup = { id: tempId, ...data, items: [] };
    setGroups(prev => [...prev, newGroup]);

    apiFetch('/api/inv-groups', {
      method: 'POST',
      body: JSON.stringify(data),
    }).then((res) => {
      const serverGroup = res?.group;
      if (serverGroup?.id) {
        setGroups(prev => prev.map(g =>
          g.id === tempId ? { ...serverGroup, items: serverGroup.items || [] } : g
        ));
      }
      useDataStore.setState({ invGroups: null });
    }).catch((e: any) => {
      Alert.alert('Error', `Could not save group: ${e?.message || 'unknown error'}`);
      setGroups(prev => prev.filter(g => g.id !== tempId));
    });
  };

  const handleDeleteGroup = (groupId: string, name: string) => {
    Alert.alert('Delete Group', `Delete "${name}" and all its items?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try {
          await apiFetch(`/api/inv-groups/${groupId}`, { method: 'DELETE' });
          setGroups(prev => prev.filter(g => g.id !== groupId));
          useDataStore.setState({ invGroups: null });
        } catch { Alert.alert('Error', 'Could not delete group.'); }
      }},
    ]);
  };

  const handleAddItem = async (groupId: string, item: AddItemPayload) => {
    try {
      await apiFetch(`/api/inv-groups/${groupId}/items`, {
        method: 'POST',
        body: JSON.stringify({
          name: item.name,
          unit: item.unit === 'count' ? '' : item.unit,
          initialQty: item.initialQty,
          perStay: item.perStay || undefined,
          threshold: item.threshold,
          category: item.category,
          catalogName: item.catalogName,
          isCleanerOnly: item.isCleanerOnly || false,
        }),
      });
      setAddingItemGroup(null);
      useDataStore.setState({ invGroups: null });
      load(true);
    } catch { Alert.alert('Error', 'Could not add item.'); }
  };

  const handleRestock = async (itemId: string, newQty: number) => {
    try {
      await apiFetch('/api/inventory/update', {
        method: 'POST',
        body: JSON.stringify({ itemId, quantity: newQty }),
      });
      setRestockItem(null);
      useDataStore.setState({ invGroups: null });
      load(true);
    } catch { Alert.alert('Error', 'Could not update stock.'); }
  };

  // ── Derived data ──

  const totalLow = groups.reduce((sum, g) => {
    return sum + (g.items || []).filter((it: any) => {
      const t = it.reorder_threshold ?? 0;
      return t > 0 && (it.effective_qty ?? it.current_qty ?? 0) <= t;
    }).length;
  }, 0);

  // ── Render ──

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Colors.green} />
      </View>
    );
  }

  return (
    <>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={"#FFFFFF"} colors={["#FFFFFF"]} />}
      >
        {/* ── iCal Banner ── */}
        {!groups.some(g => getGroupFeedCount(g) > 0) && groups.length > 0 && (
          <View style={styles.icalBanner}>
            <Ionicons name="calendar-outline" size={16} color={Colors.yellow} />
            <Text style={styles.icalBannerText}>
              Connect iCal feeds in Settings for accurate inventory auto-depletion
            </Text>
          </View>
        )}

        {/* ── Top Header ── */}
        <View style={styles.topHeader}>
          <View>
            <Text style={styles.topSubtitle}>Supplies · Inventory</Text>
            <Text style={styles.topCounts}>
              {groups.length} group{groups.length !== 1 ? 's' : ''}
              {totalLow > 0 && (
                <Text style={{ color: Colors.red }}> · {totalLow} low stock</Text>
              )}
            </Text>
          </View>
          <AnimatedPressable style={styles.addGroupBtn} onPress={() => setShowAddGroup(true)}
            scaleValue={0.95} opacityValue={0.7}>
            <Ionicons name="add" size={16} color={Colors.primary} />
            <Text style={styles.addGroupBtnText}>Group</Text>
          </AnimatedPressable>
        </View>

        {groups.length === 0 ? (
          <View style={styles.emptyContainer}>
            <View style={styles.emptyIconWrap}>
              <Ionicons name="cube-outline" size={52} color={Colors.textDim} />
            </View>
            <Text style={styles.emptyHeading}>Start tracking supplies</Text>
            <Text style={styles.emptySub}>
              Create a group for each property or city
            </Text>
            <AnimatedPressable style={styles.emptyCta} onPress={() => setShowAddGroup(true)}
              scaleValue={0.95} opacityValue={0.7}>
              <Ionicons name="add-circle" size={18} color={Colors.primary} />
              <Text style={styles.emptyCtaText}>Create First Group</Text>
            </AnimatedPressable>
          </View>
        ) : (
          groups.map((group: any) => {
            const items: any[] = group.items || [];
            const lowCount = items.filter((it: any) => {
              const t = it.reorder_threshold ?? 0;
              return t > 0 && (it.effective_qty ?? it.current_qty ?? 0) <= t;
            }).length;
            const isCollapsed = collapsedGroups.has(group.id);
            const hasWarning = lowCount > 0;

            // Group items by catalog category
            const categorized: Record<string, any[]> = {};
            items.forEach(item => {
              const cat = item.category
                ? (CATEGORIES.find(c => c.key === item.category)?.label || 'Other')
                : 'Other';
              if (!categorized[cat]) categorized[cat] = [];
              categorized[cat].push(item);
            });
            const catOrder = [...CATEGORIES.map(c => c.label), 'Other'];
            const sortedCategories = catOrder.filter(c => categorized[c]);

            const feedCount = getGroupFeedCount(group);

            return (
              <View key={group.id || Math.random()} style={styles.groupCard}>
                {/* ── Group Header ── */}
                <View style={styles.groupHeader}>
                  <View style={styles.groupHeaderTop}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.groupName}>{(group.name || 'Inventory').toUpperCase()}</Text>
                      {group.linkType && (
                        <View style={styles.linkBadge}>
                          <Ionicons
                            name={group.linkType === 'property' ? 'home' : 'business'}
                            size={10} color={Colors.primary} />
                          <Text style={styles.linkBadgeText}>
                            {group.linkType === 'property' ? 'Property' : 'City'}
                          </Text>
                        </View>
                      )}
                    </View>
                    <View style={styles.groupActions}>
                      {hasWarning && (
                        <Ionicons name="warning" size={16} color={Colors.yellow} style={{ marginRight: 4 }} />
                      )}
                      <AnimatedPressable onPress={() => setAddingItemGroup(group.id)} style={styles.groupActionBtn}
                        scaleValue={0.95} opacityValue={0.7}>
                        <Ionicons name="add" size={14} color={Colors.primary} />
                        <Text style={styles.groupActionText}>Item</Text>
                      </AnimatedPressable>
                      <AnimatedPressable onPress={() => toggleGroup(group.id)} style={styles.groupActionBtn}
                        scaleValue={0.95} opacityValue={0.7}>
                        <Ionicons name={isCollapsed ? 'chevron-down' : 'chevron-up'} size={14} color={Colors.textSecondary} />
                      </AnimatedPressable>
                      <AnimatedPressable onPress={() => handleDeleteGroup(group.id, group.name)} style={styles.groupCloseBtn}
                        scaleValue={0.95} opacityValue={0.7}>
                        <Ionicons name="close" size={16} color={Colors.textDim} />
                      </AnimatedPressable>
                    </View>
                  </View>
                  <View style={styles.groupMeta}>
                    <Text style={styles.groupMetaText}>
                      {items.length} item{items.length !== 1 ? 's' : ''}
                      {lowCount > 0 && (
                        <Text style={{ color: Colors.red }}> · {lowCount} low</Text>
                      )}
                    </Text>
                    {feedCount > 0 ? (
                      <View style={styles.icalLinkedBadge}>
                        <Ionicons name="checkmark-circle" size={11} color={Colors.green} />
                        <Text style={styles.icalLinkedText}>{feedCount} iCal linked</Text>
                      </View>
                    ) : (
                      <Text style={styles.noIcalText}>No iCal feeds</Text>
                    )}
                  </View>
                </View>

                {/* ── Inline Add Item ── */}
                {addingItemGroup === group.id && (
                  <AddItemForm
                    onAdd={(item) => handleAddItem(group.id, item)}
                    onCancel={() => setAddingItemGroup(null)}
                  />
                )}

                {/* ── Items ── */}
                {!isCollapsed && sortedCategories.map(category => (
                  <View key={category}>
                    <View style={styles.catHeader}>
                      <Text style={styles.catTitle}>{category.toUpperCase()}</Text>
                      <View style={styles.catLine} />
                    </View>
                    {categorized[category].map((item: any) => {
                      const qty = item.effective_qty ?? item.current_qty ?? 0;
                      const threshold = item.reorder_threshold ?? 0;
                      const isLow = threshold > 0 && qty <= threshold;
                      const isStatic = item.isStatic;
                      const unitLabel = UNIT_LABELS[item.unit as UnitType] || item.unit || '';
                      const daysLeft = item.perStay && item.perStay > 0
                        ? Math.floor(qty / item.perStay) : null;
                      const showDaysWarning = isLow && daysLeft !== null && daysLeft <= 7;

                      return (
                        <View key={item.id} style={styles.itemCard}>
                          <View style={styles.itemRow}>
                            <View style={styles.itemInfo}>
                              <View style={styles.itemNameRow}>
                                <Text style={styles.itemName}>{item.name}</Text>
                                {item.isCleanerOnly && (
                                  <View style={styles.cleanerBadge}>
                                    <Text style={styles.cleanerBadgeText}>CLEANER</Text>
                                  </View>
                                )}
                                {isStatic && (
                                  <View style={styles.staticBadge}>
                                    <Text style={styles.staticBadgeText}>IN STOCK</Text>
                                  </View>
                                )}
                              </View>
                              {showDaysWarning && (
                                <View style={styles.daysWarning}>
                                  <Ionicons name="warning" size={11} color={Colors.red} />
                                  <Text style={styles.daysWarningText}>~{daysLeft}d left</Text>
                                </View>
                              )}
                            </View>

                            <View style={styles.itemRight}>
                              <View style={[styles.qtyBadge, isLow ? styles.qtyBadgeLow : styles.qtyBadgeOk]}>
                                <Text style={[styles.qtyText, isLow ? styles.qtyTextLow : styles.qtyTextOk]}>
                                  {Math.round(qty)}{unitLabel ? ` ${unitLabel}` : ''}
                                </Text>
                              </View>
                              {!isStatic && (
                                <AnimatedPressable style={styles.stockBtn} onPress={() => setRestockItem(item)}
                                  scaleValue={0.95} opacityValue={0.7}>
                                  <Ionicons name="add" size={13} color={Colors.primary} />
                                  <Text style={styles.stockBtnText}>Stock</Text>
                                </AnimatedPressable>
                              )}
                            </View>
                          </View>
                        </View>
                      );
                    })}
                  </View>
                ))}
              </View>
            );
          })
        )}
      </ScrollView>

      {/* ── Modals ── */}
      <AddGroupModal visible={showAddGroup} onClose={() => setShowAddGroup(false)} onSave={handleAddGroup}
        existingGroupIds={new Set(groups.map(g => g.propertyId || (g.city ? `city_${g.city.toLowerCase().replace(/\s+/g, '_')}` : g.id)))} />
      {restockItem && (
        <RestockModal item={restockItem} onClose={() => setRestockItem(null)} onSave={handleRestock} />
      )}
    </>
  );
}

// ══════════════════════════════════════
// ── Styles ──
// ══════════════════════════════════════

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  content: { padding: Spacing.md, paddingBottom: Spacing.xl * 2 },
  center: { flex: 1, backgroundColor: Colors.bg, alignItems: 'center', justifyContent: 'center' },

  // iCal Banner
  icalBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: Colors.yellowDim, borderRadius: Radius.xl,
    padding: Spacing.md, marginBottom: Spacing.md,
    borderWidth: 0.5, borderColor: 'rgba(245,158,11,0.2)',
  },
  icalBannerText: { flex: 1, fontSize: FontSize.xs, color: Colors.textSecondary, lineHeight: 16 },

  // Top Header
  topHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
    marginBottom: Spacing.lg,
  },
  topSubtitle: {
    fontSize: FontSize.xs, fontWeight: '600', color: Colors.textDim,
    textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 2,
  },
  topCounts: { fontSize: FontSize.sm, color: Colors.textSecondary },
  addGroupBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: Radius.pill, backgroundColor: Colors.glass,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
    borderTopColor: Colors.glassHighlight, borderTopWidth: 1,
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.35, shadowRadius: 10 },
      android: { elevation: 2 },
    }),
  },
  addGroupBtnText: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.primary },

  // Empty State
  emptyContainer: { alignItems: 'center', paddingTop: Spacing.xl * 2, paddingBottom: Spacing.xl },
  emptyIconWrap: {
    width: 88, height: 88, borderRadius: 44,
    backgroundColor: Colors.glass, alignItems: 'center', justifyContent: 'center',
    borderWidth: 0.5, borderColor: Colors.glassBorder,
    borderTopColor: Colors.glassHighlight, borderTopWidth: 1,
    marginBottom: Spacing.lg,
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 16 },
      android: { elevation: 3 },
    }),
  },
  emptyHeading: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginBottom: Spacing.xs },
  emptySub: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', marginBottom: Spacing.lg, paddingHorizontal: Spacing.xl },
  emptyCta: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 20, paddingVertical: 12,
    borderRadius: Radius.pill, backgroundColor: Colors.glass,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
    borderTopColor: Colors.glassHighlight, borderTopWidth: 1,
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.35, shadowRadius: 12 },
      android: { elevation: 2 },
    }),
  },
  emptyCtaText: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.primary },

  // Group Card
  groupCard: {
    backgroundColor: Colors.glassHeavy, borderRadius: Radius.xl,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
    borderTopColor: Colors.glassHighlight, borderTopWidth: 1,
    marginBottom: Spacing.md, overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.35, shadowRadius: 20 },
      android: { elevation: 3 },
    }),
  },
  groupHeader: { padding: Spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: Colors.glassBorder },
  groupHeaderTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  groupName: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, letterSpacing: 0.5 },
  groupActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  groupActionBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 2,
    paddingHorizontal: 8, paddingVertical: 4,
    borderRadius: Radius.pill, backgroundColor: Colors.glass,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
  },
  groupActionText: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.primary },
  groupCloseBtn: {
    padding: 4, borderRadius: Radius.pill,
    backgroundColor: Colors.glass, borderWidth: 0.5, borderColor: Colors.glassBorder,
  },
  groupMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  groupMetaText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  linkBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 3,
    backgroundColor: Colors.primaryDim, borderRadius: Radius.pill,
    paddingHorizontal: 6, paddingVertical: 2, alignSelf: 'flex-start',
  },
  linkBadgeText: { fontSize: 10, fontWeight: '600', color: Colors.primary },
  icalLinkedBadge: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  icalLinkedText: { fontSize: 10, fontWeight: '600', color: Colors.green },
  noIcalText: { fontSize: 10, color: Colors.textDim },

  // Category headers
  catHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: Spacing.md, paddingTop: Spacing.md, paddingBottom: Spacing.xs,
  },
  catTitle: { fontSize: FontSize.xs - 1, fontWeight: '700', color: Colors.textDim, letterSpacing: 0.8 },
  catLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: Colors.glassBorder },

  // Item Card
  itemCard: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: Colors.glassBorder,
  },
  itemRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  itemInfo: { flex: 1, marginRight: Spacing.sm },
  itemNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  itemName: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  cleanerBadge: { backgroundColor: Colors.primaryDim, borderRadius: Radius.pill, paddingHorizontal: 6, paddingVertical: 1 },
  cleanerBadgeText: { fontSize: 9, fontWeight: '700', color: Colors.primary, letterSpacing: 0.5 },
  staticBadge: { backgroundColor: Colors.greenDim, borderRadius: Radius.pill, paddingHorizontal: 6, paddingVertical: 1 },
  staticBadgeText: { fontSize: 9, fontWeight: '700', color: Colors.green, letterSpacing: 0.5 },
  daysWarning: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2 },
  daysWarningText: { fontSize: FontSize.xs - 1, fontWeight: '600', color: Colors.red },

  itemRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  qtyBadge: { minWidth: 36, paddingHorizontal: 8, paddingVertical: 4, borderRadius: Radius.pill, alignItems: 'center' },
  qtyBadgeOk: { backgroundColor: Colors.greenDim },
  qtyBadgeLow: { backgroundColor: Colors.redDim },
  qtyText: { fontSize: FontSize.xs, fontWeight: '700' },
  qtyTextOk: { color: Colors.green },
  qtyTextLow: { color: Colors.red },
  stockBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 2,
    borderWidth: 0.5, borderColor: Colors.glassBorder, borderRadius: Radius.pill,
    paddingHorizontal: 10, paddingVertical: 4, backgroundColor: Colors.glass,
  },
  stockBtnText: { fontSize: FontSize.xs, color: Colors.primary, fontWeight: '600' },

  // Add Item Inline Form
  addItemForm: {
    padding: Spacing.md, backgroundColor: Colors.glassDark,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: Colors.glassBorder,
  },
  addItemTitle: { fontSize: FontSize.xs, fontWeight: '700', color: Colors.textDim, letterSpacing: 0.8, marginBottom: Spacing.sm },
  stepHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.sm },
  addItemInput: {
    backgroundColor: Colors.glassDark, borderWidth: 1, borderColor: Colors.glassBorder,
    borderRadius: Radius.md, padding: Spacing.sm + 2, color: Colors.text,
    fontSize: FontSize.sm, marginBottom: Spacing.sm,
  },
  addItemLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '500', marginBottom: 4 },
  addItemRow: { flexDirection: 'row', gap: Spacing.sm },
  addItemField: { flex: 1 },
  perStayHint: { fontSize: 10, color: Colors.textDim, marginTop: -4, marginBottom: Spacing.xs },

  // Category grid
  catGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, marginBottom: Spacing.md },
  catPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: Radius.pill, backgroundColor: Colors.glass,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
  },
  catPillText: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.text },

  // Catalog chips
  catalogChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: Radius.pill, backgroundColor: Colors.glass,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
  },
  catalogChipText: { fontSize: FontSize.xs, color: Colors.text },
  catalogChipStatic: { fontSize: 8, fontWeight: '700', color: Colors.green, letterSpacing: 0.5 },

  // Cleaner toggle
  cleanerToggle: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: Spacing.sm, marginBottom: Spacing.sm,
  },
  cleanerCheck: {
    width: 20, height: 20, borderRadius: 6,
    borderWidth: 1.5, borderColor: Colors.glassBorder,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: Colors.glass,
  },
  cleanerCheckActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  cleanerToggleText: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  cleanerToggleHint: { fontSize: FontSize.xs, color: Colors.textDim },

  unitToggleRow: { flexDirection: 'row', gap: Spacing.xs, marginBottom: Spacing.sm },
  unitBtn: {
    flex: 1, paddingVertical: 6, borderRadius: Radius.pill,
    borderWidth: 0.5, borderColor: Colors.glassBorder, alignItems: 'center',
    backgroundColor: Colors.glass,
  },
  unitBtnActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryDim },
  unitBtnText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  unitBtnTextActive: { color: Colors.primary, fontWeight: '600' },
  addItemBtns: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.sm },
  addItemCancelBtn: {
    flex: 1, paddingVertical: Spacing.sm, borderRadius: Radius.pill,
    backgroundColor: Colors.glass, alignItems: 'center',
    borderWidth: 0.5, borderColor: Colors.glassBorder,
  },
  addItemCancelText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  addItemSaveBtn: {
    flex: 1, paddingVertical: Spacing.sm, borderRadius: Radius.pill,
    backgroundColor: Colors.green, alignItems: 'center',
    flexDirection: 'row', justifyContent: 'center', gap: 4,
  },
  addItemSaveText: { fontSize: FontSize.sm, fontWeight: '600', color: '#fff' },

  // Modals
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.60)', justifyContent: 'flex-end' },
  modalCard: {
    backgroundColor: Colors.glassOverlay, borderTopLeftRadius: Radius.xl, borderTopRightRadius: Radius.xl,
    padding: Spacing.lg, paddingBottom: Spacing.xl * 2,
    borderTopColor: Colors.glassHighlight, borderTopWidth: 1,
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.25, shadowRadius: 16 },
      android: { elevation: 8 },
    }),
  },
  modalHandle: { width: 36, height: 4, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 2, alignSelf: 'center', marginBottom: Spacing.lg },
  modalSectionLabel: { fontSize: FontSize.xs, fontWeight: '700', letterSpacing: 0.8, color: Colors.textDim, textTransform: 'uppercase', marginBottom: Spacing.sm },
  modalHelpText: { fontSize: FontSize.sm, color: Colors.textSecondary, marginBottom: Spacing.md, lineHeight: 20 },
  modalInput: {
    backgroundColor: Colors.glassDark, borderWidth: 1, borderColor: Colors.glassBorder,
    borderRadius: Radius.md, padding: Spacing.md, color: Colors.text, fontSize: FontSize.md, marginBottom: Spacing.sm,
  },
  modalBtns: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.md },
  modalCancelBtn: {
    flex: 1, padding: Spacing.md, borderRadius: Radius.pill,
    backgroundColor: Colors.glass, alignItems: 'center',
    borderWidth: 0.5, borderColor: Colors.glassBorder,
  },
  modalCancelText: { color: Colors.textSecondary, fontSize: FontSize.md },
  modalSaveBtn: {
    flex: 1, padding: Spacing.md, borderRadius: Radius.pill,
    backgroundColor: Colors.green, alignItems: 'center',
    flexDirection: 'row', justifyContent: 'center', gap: 6,
  },
  modalSaveText: { color: '#fff', fontSize: FontSize.md, fontWeight: '600' },

  // Property / City picker
  pickerSectionLabel: {
    fontSize: FontSize.xs - 2, fontWeight: '700', color: Colors.textDim,
    letterSpacing: 0.8, marginBottom: Spacing.xs,
  },
  pickerSectionHint: { fontSize: FontSize.xs - 1, color: Colors.textDim, marginBottom: Spacing.sm, lineHeight: 16 },
  propPickerRow: {
    flexDirection: 'row', alignItems: 'center', padding: Spacing.sm + 4,
    borderRadius: Radius.md, marginBottom: Spacing.xs,
    backgroundColor: Colors.glass, borderWidth: 0.5, borderColor: Colors.glassBorder,
  },
  propPickerRowDone: { opacity: 0.5 },
  propPickerIcon: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: Colors.glassDark, alignItems: 'center', justifyContent: 'center',
    marginRight: Spacing.sm,
  },
  propPickerName: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  propPickerMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  propPickerMeta: { fontSize: FontSize.xs - 2, color: Colors.textDim },
  alreadyBadge: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  alreadyText: { fontSize: FontSize.xs - 1, fontWeight: '600', color: Colors.green },
  noPropWrap: { alignItems: 'center', paddingVertical: Spacing.xl, gap: Spacing.sm },
  noPropText: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.textDim, textAlign: 'center' },
  noPropHint: { fontSize: FontSize.xs, color: Colors.textDim, textAlign: 'center' },
  modalCancelBtnFull: {
    marginTop: Spacing.md, padding: Spacing.md, borderRadius: Radius.pill,
    backgroundColor: Colors.glass, alignItems: 'center',
    borderWidth: 0.5, borderColor: Colors.glassBorder,
  },

  // Restock modal
  restockSaveBtn: {
    flex: 1, padding: Spacing.md, borderRadius: Radius.pill,
    backgroundColor: Colors.primary, alignItems: 'center',
    flexDirection: 'row', justifyContent: 'center', gap: 6,
  },
  restockCurrent: { fontSize: FontSize.sm, color: Colors.textSecondary, marginBottom: Spacing.md },
  restockInput: {
    backgroundColor: Colors.glassDark, borderWidth: 1, borderColor: Colors.glassBorder,
    borderRadius: Radius.md, padding: Spacing.md,
    color: Colors.text, fontSize: FontSize.lg, fontWeight: '600',
    textAlign: 'center', marginBottom: Spacing.sm,
  },
  restockNewTotal: { fontSize: FontSize.sm, color: Colors.green, fontWeight: '500', textAlign: 'center', marginBottom: Spacing.md },
});
