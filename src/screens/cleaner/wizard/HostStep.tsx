import React, { useState, useRef } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator, Alert, Platform } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../../../constants/theme';
import { FollowedOwner } from '../../../store/cleanerStore';
import { apiFetch } from '../../../services/api';
import { useCleanerStore } from '../../../store/cleanerStore';

interface Props {
  owners: FollowedOwner[];
  onSelect: (owner: FollowedOwner) => void;
}

export function HostStep({ owners, onSelect }: Props) {
  const [showSearch, setShowSearch] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { followOwner } = useCleanerStore();

  const handleFollow = async () => {
    const target = selectedUser || searchInput.trim();
    if (!target) return;
    setSearching(true);
    try {
      const res = await followOwner(target);
      if (res.ok) {
        Alert.alert('Host Followed', 'You are now following this host. Close and reopen this screen to see them.');
        setSearchInput('');
        setSelectedUser(null);
        setShowSearch(false);
      } else {
        Alert.alert('Error', res.error || 'Could not follow this host.');
      }
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Could not follow this host.');
    } finally {
      setSearching(false);
    }
  };

  if (owners.length === 0) {
    return (
      <View style={styles.empty}>
        <Ionicons name="people-outline" size={48} color={Colors.textDim} />
        <Text style={styles.emptyTitle}>No Hosts</Text>
        <Text style={styles.emptySub}>Follow a host to see their properties and create invoices.</Text>
        {showSearch ? (
          <View style={styles.searchBox}>
            {/* Selected user bubble */}
            {selectedUser ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.sm }}>
                <View style={{
                  flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
                  backgroundColor: Colors.greenDim, borderRadius: Radius.pill,
                  paddingHorizontal: Spacing.sm + 4, paddingVertical: 6,
                  borderWidth: 1.5, borderColor: Colors.green + '40',
                }}>
                  <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: Colors.green + '20', alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ fontSize: 10, fontWeight: '800', color: Colors.green }}>{selectedUser[0].toUpperCase()}</Text>
                  </View>
                  <Text style={{ fontSize: FontSize.sm, fontWeight: '700', color: Colors.green }}>{selectedUser}</Text>
                  <TouchableOpacity activeOpacity={0.7} onPress={() => { setSelectedUser(null); setSearchInput(''); }}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Ionicons name="close-circle" size={16} color={Colors.green} />
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <TextInput
                style={styles.searchInput}
                value={searchInput}
                onChangeText={(t) => {
                  setSearchInput(t);
                  if (searchTimer.current) clearTimeout(searchTimer.current);
                  if (t.trim().length >= 2 && !t.startsWith('PPG-')) {
                    setSearchLoading(true);
                    searchTimer.current = setTimeout(async () => {
                      try {
                        const res = await apiFetch(`/api/users/search?q=${encodeURIComponent(t.trim())}`);
                        setSearchResults((res.users || []).filter((u: any) => u.role === 'owner'));
                      } catch { setSearchResults([]); }
                      setSearchLoading(false);
                    }, 300);
                  } else {
                    setSearchResults([]);
                    setSearchLoading(false);
                  }
                }}
                placeholder="Follow code or username"
                placeholderTextColor={Colors.textDim}
                autoCapitalize="none"
                autoFocus
              />
            )}
            {searchLoading && <ActivityIndicator size="small" color={Colors.green} style={{ marginTop: Spacing.sm }} />}
            {!selectedUser && searchResults.length > 0 && (
              <View style={{ marginTop: Spacing.sm }}>
                {searchResults.slice(0, 5).map((u: any) => (
                  <TouchableOpacity key={u.user_id} activeOpacity={0.7}
                    style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.sm, borderBottomWidth: 0.5, borderBottomColor: Colors.border }}
                    onPress={() => { setSelectedUser(u.username); setSearchInput(u.username); setSearchResults([]); }}
                  >
                    <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: Colors.greenDim, alignItems: 'center', justifyContent: 'center', marginRight: Spacing.sm }}>
                      <Text style={{ fontSize: 12, fontWeight: '700', color: Colors.green }}>{(u.username || '?')[0].toUpperCase()}</Text>
                    </View>
                    <Text style={{ fontSize: FontSize.sm, fontWeight: '600', color: Colors.text }}>{u.username}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
            <View style={styles.searchBtns}>
              <TouchableOpacity activeOpacity={0.7} style={styles.searchCancel} onPress={() => setShowSearch(false)}>
                <Text style={styles.searchCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity activeOpacity={0.7} style={[styles.searchSubmit, searching && { opacity: 0.5 }]} onPress={handleFollow} disabled={searching}>
                {searching ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.searchSubmitText}>Follow</Text>}
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <TouchableOpacity activeOpacity={0.7} style={styles.searchBtn} onPress={() => setShowSearch(true)}>
            <Ionicons name="search-outline" size={16} color={Colors.green} />
            <Text style={styles.searchBtnText}>Search for a Host</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content} automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled">
      <Text style={styles.heading}>Select a host to invoice</Text>
      {owners.map((owner) => (
        <TouchableOpacity
          key={owner.id}
          activeOpacity={0.7}
          style={styles.card}
          onPress={() => onSelect(owner)}
        >
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {(owner.username || '?')[0].toUpperCase()}
            </Text>
          </View>
          <View style={styles.info}>
            <Text style={styles.name}>{owner.username}</Text>
            <Text style={styles.sub}>
              {owner.property_count || 0} propert{owner.property_count === 1 ? 'y' : 'ies'}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={Colors.textDim} />
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: Spacing.md },
  heading: {
    fontSize: FontSize.lg, fontWeight: '700', color: Colors.text,
    marginBottom: Spacing.md,
  },
  card: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.glassHeavy, borderRadius: Radius.xl,
    padding: Spacing.md, marginBottom: Spacing.sm,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
    borderTopColor: Colors.glassHighlight, borderTopWidth: 1,
    overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.35, shadowRadius: 20 },
    }),
  },
  avatar: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: Colors.greenDim,
    alignItems: 'center', justifyContent: 'center',
    marginRight: Spacing.md,
  },
  avatarText: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.primary },
  info: { flex: 1 },
  name: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.text },
  sub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  empty: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    padding: Spacing.xl,
  },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginTop: Spacing.md },
  emptySub: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', marginTop: Spacing.xs, marginBottom: Spacing.lg },
  searchBtn: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.greenDim, borderRadius: Radius.lg,
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm + 2,
  },
  searchBtnText: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.green },
  searchBox: { width: '100%', paddingHorizontal: Spacing.md, marginTop: Spacing.sm },
  searchInput: {
    backgroundColor: Colors.glassHeavy, borderWidth: 1, borderColor: Colors.glassBorder,
    borderRadius: Radius.md, padding: Spacing.md, color: Colors.text, fontSize: FontSize.md,
  },
  searchBtns: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.sm },
  searchCancel: {
    flex: 1, paddingVertical: Spacing.sm + 2, alignItems: 'center',
    borderRadius: Radius.md, backgroundColor: Colors.glassDark,
  },
  searchCancelText: { color: Colors.textSecondary, fontWeight: '600', fontSize: FontSize.sm },
  searchSubmit: {
    flex: 1, paddingVertical: Spacing.sm + 2, alignItems: 'center',
    borderRadius: Radius.md, backgroundColor: Colors.green,
  },
  searchSubmitText: { color: '#fff', fontWeight: '600', fontSize: FontSize.sm },
});
