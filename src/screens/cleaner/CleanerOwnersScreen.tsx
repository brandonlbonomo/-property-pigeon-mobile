import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl,
  TouchableOpacity, TextInput, Alert, ActivityIndicator, Platform,
  KeyboardAvoidingView,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation } from '@react-navigation/native';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { useCleanerStore, FollowedOwner } from '../../store/cleanerStore';
import { usePropertyRequestStore } from '../../store/propertyRequestStore';
import { apiFetch } from '../../services/api';
import { PortfolioScoreBubble } from '../../components/PortfolioScoreBubble';
import { glassAlert } from '../../components/GlassAlert';

function OwnerCard({ owner, onSelectProperties, onUnfollow, onMessage }: {
  owner: FollowedOwner;
  onSelectProperties: (owner: FollowedOwner) => void;
  onUnfollow: (followId: string) => void;
  onMessage: (owner: FollowedOwner) => void;
}) {
  return (
    <View style={styles.ownerCard}>
      <View style={styles.ownerHeader}>
        {owner.portfolio_score != null ? (
          <PortfolioScoreBubble score={owner.portfolio_score} size={40} />
        ) : (
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {(owner.username || '?')[0].toUpperCase()}
            </Text>
          </View>
        )}
        <View style={styles.ownerInfo}>
          <Text style={styles.ownerName}>{owner.username}</Text>
          <Text style={styles.ownerSub}>
            {owner.property_count} properties · {owner.selected_properties.length} selected
          </Text>
        </View>
      </View>
      <View style={styles.ownerActions}>
        <TouchableOpacity activeOpacity={0.7}
          style={styles.actionBtn} onPress={() => onMessage(owner)}>
          <Ionicons name="chatbubble-outline" size={14} color={Colors.primary} />
          <Text style={styles.actionText}>Message</Text>
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.7}
          style={styles.actionBtn} onPress={() => onSelectProperties(owner)}>
          <Ionicons name="home-outline" size={14} color={Colors.primary} />
          <Text style={styles.actionText}>Properties</Text>
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.7}
          style={[styles.actionBtn, styles.actionBtnDanger]}
          onPress={() => onUnfollow(owner.id)}
        >
          <Ionicons name="close-outline" size={14} color={Colors.red} />
          <Text style={[styles.actionText, { color: Colors.red }]}>Unfollow</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export function CleanerOwnersScreen() {
  const navigation = useNavigation<any>();
  const { owners, fetchOwners, followOwner, selectProperties, unfollowOwner } = useCleanerStore();
  const { createRequest } = usePropertyRequestStore();
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showFollow, setShowFollow] = useState(false);
  const [followInput, setFollowInput] = useState('');
  const [followLoading, setFollowLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedUser, setSelectedUser] = useState<{ username: string; role: string } | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [propertyPicker, setPropertyPicker] = useState<{
    owner: FollowedOwner;
    properties: { id: string; label: string }[];
    selected: string[];
  } | null>(null);

  useEffect(() => {
    fetchOwners()
      .catch(() => setError('Could not load owners.'))
      .finally(() => setLoading(false));
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try { await fetchOwners(); }
    catch { setError('Could not load owners.'); }
    finally { setRefreshing(false); }
  }, [fetchOwners]);

  const handleFollow = async () => {
    if (!followInput.trim()) return;
    setFollowLoading(true);
    const res = await followOwner(followInput.trim());
    setFollowLoading(false);
    if (res.ok) {
      setShowFollow(false);
      setFollowInput('');
      fetchOwners();
      glassAlert('Following', 'You are now following this owner.');
    } else {
      glassAlert('Error', res.error || 'Could not follow this owner.');
    }
  };

  const handleUnfollow = (followId: string) => {
    glassAlert('Unfollow', 'Stop following this owner?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Unfollow', style: 'destructive', onPress: async () => {
          await unfollowOwner(followId);
          fetchOwners();
        },
      },
    ]);
  };

  const handleSelectProperties = async (owner: FollowedOwner) => {
    try {
      const res = await apiFetch(`/api/cleaner/owner-properties/${owner.user_id}`);
      setPropertyPicker({
        owner,
        properties: res.properties || [],
        selected: [...owner.selected_properties],
      });
    } catch {
      glassAlert('Error', 'Could not load properties.');
    }
  };

  const toggleProperty = (propId: string) => {
    if (!propertyPicker) return;
    const selected = propertyPicker.selected.includes(propId)
      ? propertyPicker.selected.filter(id => id !== propId)
      : [...propertyPicker.selected, propId];
    setPropertyPicker({ ...propertyPicker, selected });
  };

  const saveProperties = async () => {
    if (!propertyPicker) return;
    // New properties = ones not already selected
    const currentSelected = new Set(propertyPicker.owner.selected_properties);
    const newProps = propertyPicker.selected.filter(id => !currentSelected.has(id));
    const removedProps = propertyPicker.owner.selected_properties.filter(
      id => !propertyPicker.selected.includes(id)
    );

    // For removed properties, still use direct selectProperties
    if (removedProps.length > 0) {
      await selectProperties(propertyPicker.owner.id, propertyPicker.selected);
    }

    // For new properties, use the request flow
    if (newProps.length > 0) {
      const res = await createRequest(propertyPicker.owner.user_id, newProps, 'request');
      if (res.ok) {
        setPropertyPicker(null);
        glassAlert('Access Requested', 'Property access requested. Host will be notified.');
        return;
      } else {
        glassAlert('Error', res.error || 'Could not request access.');
        return;
      }
    }

    setPropertyPicker(null);
    if (removedProps.length > 0) {
      glassAlert('Saved', 'Property selections updated.');
    }
  };

  if (loading && owners.length === 0) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={Colors.green} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled"
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={"#1A1A1A"} colors={["#1A1A1A"]} />}
    >
      {error && (
        <View style={styles.errorBanner}>
          <Ionicons name="cloud-offline-outline" size={16} color={Colors.red} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}
      {/* Property picker view */}
      {propertyPicker ? (
        <View>
          <TouchableOpacity activeOpacity={0.7}
          style={styles.backBtn} onPress={() => setPropertyPicker(null)}>
            <Ionicons name="chevron-back" size={18} color={Colors.primary} />
            <Text style={styles.backText}>Back</Text>
          </TouchableOpacity>
          <Text style={styles.sectionTitle}>
            Select properties from {propertyPicker.owner.username}
          </Text>
          <Text style={styles.sectionSub}>
            You'll only see cleanings for selected properties
          </Text>
          {propertyPicker.properties.map(p => {
            const isSelected = propertyPicker.selected.includes(p.id);
            return (
              <TouchableOpacity activeOpacity={0.7}
          key={p.id}
                style={[styles.propRow, isSelected && styles.propRowActive]}
                onPress={() => toggleProperty(p.id)}
              >
                <Ionicons
                  name={isSelected ? 'checkbox' : 'square-outline'}
                  size={22}
                  color={isSelected ? Colors.primary : Colors.textDim}
                />
                <Text style={styles.propLabel}>{p.label}</Text>
              </TouchableOpacity>
            );
          })}
          <TouchableOpacity activeOpacity={0.7}
          style={styles.saveBtn} onPress={saveProperties}>
            <Text style={styles.saveBtnText}>
              {(() => {
                if (!propertyPicker) return 'Save';
                const currentSelected = new Set(propertyPicker.owner.selected_properties);
                const newProps = propertyPicker.selected.filter(id => !currentSelected.has(id));
                return newProps.length > 0 ? 'Request Access' : 'Save Selections';
              })()}
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {/* Follow new owner */}
          {showFollow ? (
            <View style={styles.followBox}>
              <Text style={styles.followLabel}>Follow code or username</Text>
              {/* Selected user bubble */}
              {selectedUser && (
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.sm }}>
                  <View style={{
                    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
                    backgroundColor: Colors.greenDim, borderRadius: Radius.pill,
                    paddingHorizontal: Spacing.sm + 4, paddingVertical: 6,
                    borderWidth: 1.5, borderColor: Colors.green + '40',
                  }}>
                    <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: Colors.green + '20', alignItems: 'center', justifyContent: 'center' }}>
                      <Text style={{ fontSize: 11, fontWeight: '800', color: Colors.green }}>{selectedUser.username[0].toUpperCase()}</Text>
                    </View>
                    <Text style={{ fontSize: FontSize.sm, fontWeight: '700', color: Colors.green }}>{selectedUser.username}</Text>
                    <TouchableOpacity activeOpacity={0.7} onPress={() => { setSelectedUser(null); setFollowInput(''); }}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                      <Ionicons name="close-circle" size={18} color={Colors.green} />
                    </TouchableOpacity>
                  </View>
                </View>
              )}
              {!selectedUser && (
                <TextInput
                  style={styles.followInput}
                  value={followInput}
                  onChangeText={(t) => {
                    setFollowInput(t);
                    if (searchTimer.current) clearTimeout(searchTimer.current);
                    if (t.trim().length >= 2 && !t.startsWith('PPG-')) {
                      setSearchLoading(true);
                      searchTimer.current = setTimeout(async () => {
                        try {
                          const res = await apiFetch(`/api/users/search?q=${encodeURIComponent(t.trim())}`);
                          setSearchResults(res.users || []);
                        } catch { setSearchResults([]); }
                        setSearchLoading(false);
                      }, 300);
                    } else {
                      setSearchResults([]);
                      setSearchLoading(false);
                    }
                  }}
                  placeholder="PPG-XXXXXX or username"
                  placeholderTextColor={Colors.textDim}
                  autoCapitalize="none"
                  autoFocus
                />
              )}
              {/* Auto-populated search results */}
              {searchLoading && <ActivityIndicator size="small" color={Colors.green} style={{ marginTop: Spacing.sm }} />}
              {!selectedUser && searchResults.length > 0 && (
                <View style={{ marginTop: Spacing.sm }}>
                  {searchResults.slice(0, 5).map((u: any) => (
                    <TouchableOpacity key={u.user_id} activeOpacity={0.7}
                      style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border }}
                      onPress={() => { setSelectedUser({ username: u.username, role: u.role }); setFollowInput(u.username); setSearchResults([]); }}
                    >
                      <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: Colors.greenDim, alignItems: 'center', justifyContent: 'center', marginRight: Spacing.sm }}>
                        <Text style={{ fontSize: 14, fontWeight: '700', color: Colors.green }}>{(u.username || '?')[0].toUpperCase()}</Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: FontSize.sm, fontWeight: '600', color: Colors.text }}>{u.username}</Text>
                        <Text style={{ fontSize: FontSize.xs, color: Colors.textDim }}>{u.role === 'owner' ? 'Host' : 'Cleaner'}</Text>
                      </View>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
              <View style={styles.followBtns}>
                <TouchableOpacity activeOpacity={0.7}
          style={styles.cancelBtn} onPress={() => { setShowFollow(false); setSearchResults([]); setSelectedUser(null); }}>
                  <Text style={styles.cancelBtnText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity activeOpacity={0.7}
          style={[styles.submitBtn, followLoading && { opacity: 0.5 }]}
                  onPress={handleFollow}
                  disabled={followLoading}
                >
                  {followLoading ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <Text style={styles.submitBtnText}>Follow</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <TouchableOpacity activeOpacity={0.7}
          style={styles.addBtn} onPress={() => setShowFollow(true)}>
              <Ionicons name="person-add-outline" size={18} color={Colors.primary} />
              <Text style={styles.addBtnText}>Follow New Host</Text>
            </TouchableOpacity>
          )}

          {/* Owners list */}
          {owners.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="people-outline" size={48} color={Colors.textDim} />
              <Text style={styles.emptyTitle}>No hosts followed</Text>
              <Text style={styles.emptySub}>
                Follow hosts to see their cleaning schedule
              </Text>
            </View>
          ) : (
            owners.map(owner => (
              <OwnerCard
                key={owner.id}
                owner={owner}
                onSelectProperties={handleSelectProperties}
                onUnfollow={handleUnfollow}
                onMessage={(o) => navigation.navigate('Chat', { userId: o.user_id, username: o.username })}
              />
            ))
          )}
        </>
      )}
    </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  content: { padding: Spacing.md, paddingTop: 170, paddingBottom: Spacing.xl * 2 },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, marginBottom: Spacing.sm },
  backText: { fontSize: FontSize.md, color: Colors.primary },
  sectionTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginBottom: Spacing.xs },
  sectionSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginBottom: Spacing.md },
  addBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    padding: Spacing.md, borderRadius: Radius.md,
    borderWidth: 1.5, borderColor: Colors.primary + '40', borderStyle: 'dashed',
    backgroundColor: Colors.greenDim, marginBottom: Spacing.md,
  },
  addBtnText: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.primary },
  ownerCard: {
    padding: Spacing.md,
    backgroundColor: Colors.glassHeavy, borderRadius: Radius.lg,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
    marginBottom: Spacing.sm,
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.35, shadowRadius: 20 },
      android: { elevation: 2 },
    }),
  },
  ownerHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  avatar: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: Colors.greenDim, alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.primary },
  ownerInfo: { flex: 1 },
  ownerName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  ownerSub: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 1 },
  ownerActions: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.sm },
  actionBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
    paddingVertical: 8, borderRadius: Radius.md,
    borderWidth: 1, borderColor: Colors.border,
  },
  actionBtnDanger: { borderColor: Colors.redDim },
  actionText: { fontSize: FontSize.xs, fontWeight: '500', color: Colors.primary },
  followBox: {
    padding: Spacing.md,
    backgroundColor: Colors.glassHeavy, borderRadius: Radius.lg,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
    marginBottom: Spacing.md,
  },
  followLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500', marginBottom: Spacing.xs },
  followInput: {
    backgroundColor: Colors.glassDark, borderWidth: 1, borderColor: Colors.border,
    borderRadius: Radius.md, padding: Spacing.md, color: Colors.text, fontSize: FontSize.md,
  },
  followBtns: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.sm },
  cancelBtn: {
    flex: 1, padding: Spacing.sm, borderRadius: Radius.md,
    backgroundColor: Colors.bg, alignItems: 'center', borderWidth: 1, borderColor: Colors.border,
  },
  cancelBtnText: { color: Colors.textSecondary, fontSize: FontSize.sm },
  submitBtn: {
    flex: 1, padding: Spacing.sm, borderRadius: Radius.md,
    backgroundColor: Colors.green, alignItems: 'center',
  },
  submitBtnText: { color: '#fff', fontSize: FontSize.sm, fontWeight: '600' },
  propRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    padding: Spacing.md, borderRadius: Radius.md,
    backgroundColor: Colors.glassHeavy, borderWidth: 0.5, borderColor: Colors.glassBorder,
    marginBottom: Spacing.xs,
  },
  propRowActive: { backgroundColor: Colors.greenDim, borderColor: Colors.primary },
  propLabel: { fontSize: FontSize.md, color: Colors.text },
  saveBtn: {
    padding: Spacing.md, borderRadius: Radius.md,
    backgroundColor: Colors.green, alignItems: 'center', marginTop: Spacing.md,
  },
  saveBtnText: { color: '#fff', fontSize: FontSize.md, fontWeight: '600' },
  empty: {
    alignItems: 'center', justifyContent: 'center', paddingVertical: Spacing.xl * 3,
  },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginTop: Spacing.md },
  emptySub: {
    fontSize: FontSize.sm, color: Colors.textSecondary,
    textAlign: 'center', marginTop: Spacing.xs, lineHeight: 20,
  },
  loadingContainer: { flex: 1, backgroundColor: Colors.bg, alignItems: 'center', justifyContent: 'center' },
  errorBanner: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: 'rgba(239,68,68,0.08)', borderRadius: Radius.md,
    padding: Spacing.sm, marginBottom: Spacing.md, borderWidth: 0.5, borderColor: 'rgba(239,68,68,0.20)',
  },
  errorText: { fontSize: FontSize.xs, color: Colors.red, flex: 1, lineHeight: 16 },
});
