import React, { useState, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, ScrollView, StyleSheet,
  TouchableOpacity, Platform, ActivityIndicator, Alert,
  KeyboardAvoidingView,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { apiFetch } from '../../services/api';
import { useMessageStore } from '../../store/messageStore';

interface UserResult {
  user_id: string;
  username: string;
  role: string;
}

export function ComposeGroupScreen() {
  const navigation = useNavigation<any>();
  const { createGroup } = useMessageStore();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<UserResult[]>([]);
  const [groupName, setGroupName] = useState('');
  const [creating, setCreating] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = useCallback((q: string) => {
    setQuery(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q.trim().length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const data = await apiFetch(`/api/users/search?q=${encodeURIComponent(q.trim())}`);
        setResults(data.users || []);
      } catch {
        setResults([]);
      }
      setSearching(false);
    }, 300);
  }, []);

  const toggleUser = (user: UserResult) => {
    setSelected(prev => {
      const exists = prev.find(u => u.user_id === user.user_id);
      if (exists) return prev.filter(u => u.user_id !== user.user_id);
      return [...prev, user];
    });
  };

  const removeUser = (userId: string) => {
    setSelected(prev => prev.filter(u => u.user_id !== userId));
  };

  const handleCreate = async () => {
    if (selected.length < 2) {
      Alert.alert('Not Enough Members', 'Select at least 2 people to create a group.');
      return;
    }
    setCreating(true);
    try {
      const convId = await createGroup(
        selected.map(u => u.user_id),
        groupName.trim() || undefined,
      );
      if (convId) {
        navigation.replace('Chat', {
          convId,
          groupName: groupName.trim() || 'Group Chat',
        });
      } else {
        Alert.alert('Error', 'Could not create group. Please try again.');
      }
    } catch {
      Alert.alert('Error', 'Could not create group. Please try again.');
    }
    setCreating(false);
  };

  const isSelected = (userId: string) => selected.some(u => u.user_id === userId);

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <View style={styles.container}>
      {/* Group name input */}
      <View style={styles.groupNameRow}>
        <TextInput
          style={styles.groupNameInput}
          value={groupName}
          onChangeText={setGroupName}
          placeholder="Group name (optional)"
          placeholderTextColor={Colors.textDim}
          maxLength={50}
        />
      </View>

      {/* Selected users pills */}
      {selected.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.selectedScroll}
          contentContainerStyle={styles.selectedContent}
        >
          {selected.map(user => (
            <TouchableOpacity
              key={user.user_id}
              activeOpacity={0.7}
              style={styles.selectedPill}
              onPress={() => removeUser(user.user_id)}
            >
              <Text style={styles.selectedPillText}>{user.username}</Text>
              <Ionicons name="close" size={14} color={Colors.text} />
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* Search input */}
      <View style={styles.searchBar}>
        <Ionicons name="search" size={18} color={Colors.textDim} />
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={search}
          placeholder="Search users to add..."
          placeholderTextColor={Colors.textDim}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
        />
        {query.length > 0 && (
          <TouchableOpacity activeOpacity={0.7} onPress={() => search('')}>
            <Ionicons name="close-circle" size={18} color={Colors.textDim} />
          </TouchableOpacity>
        )}
      </View>

      {searching && (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={Colors.primary} />
        </View>
      )}

      {/* Search results */}
      <ScrollView style={styles.results} keyboardDismissMode="on-drag">
        {results.map(user => {
          const initial = (user.username || '?')[0].toUpperCase();
          const checked = isSelected(user.user_id);
          return (
            <TouchableOpacity
              key={user.user_id}
              activeOpacity={0.7}
              style={styles.userRow}
              onPress={() => toggleUser(user)}
            >
              <View style={styles.userAvatar}>
                <Text style={styles.userAvatarText}>{initial}</Text>
              </View>
              <View style={styles.userInfo}>
                <Text style={styles.userName}>{user.username}</Text>
                <Text style={styles.userRole}>
                  {user.role === 'cleaner' ? 'Cleaner' : 'Host'}
                </Text>
              </View>
              <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
                {checked && <Ionicons name="checkmark" size={14} color="#fff" />}
              </View>
            </TouchableOpacity>
          );
        })}
        {!searching && query.length >= 2 && results.length === 0 && (
          <View style={styles.noResults}>
            <Text style={styles.noResultsText}>No users found</Text>
          </View>
        )}
      </ScrollView>

      {/* Create button */}
      <View style={styles.bottomBar}>
        <TouchableOpacity
          activeOpacity={0.7}
          style={[styles.createBtn, selected.length < 2 && styles.createBtnDisabled]}
          onPress={handleCreate}
          disabled={selected.length < 2 || creating}
        >
          {creating ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.createBtnText}>
              Create Group{selected.length > 0 ? ` (${selected.length})` : ''}
            </Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },

  groupNameRow: {
    paddingHorizontal: Spacing.md, paddingTop: Spacing.sm,
  },
  groupNameInput: {
    backgroundColor: Colors.glassHeavy,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.md,
    paddingVertical: Platform.OS === 'ios' ? 10 : 8,
    fontSize: FontSize.md, color: Colors.text,
  },

  selectedScroll: { maxHeight: 48, marginTop: Spacing.sm },
  selectedContent: {
    paddingHorizontal: Spacing.md, gap: Spacing.sm,
    alignItems: 'center',
  },
  selectedPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: Colors.glass,
    borderWidth: 1, borderColor: Colors.glassBorder,
    borderTopWidth: 1.5, borderTopColor: Colors.glassHighlight,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.sm + 2,
    paddingVertical: 5,
    ...Platform.select({
      ios: {
        shadowColor: Colors.glassShadow,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.15,
        shadowRadius: 4,
      },
    }),
  },
  selectedPillText: {
    fontSize: FontSize.xs, fontWeight: '600', color: Colors.text,
  },

  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    marginHorizontal: Spacing.md, marginTop: Spacing.sm,
    backgroundColor: Colors.glassHeavy,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.md,
    paddingVertical: Platform.OS === 'ios' ? 10 : 8,
  },
  searchInput: {
    flex: 1, fontSize: FontSize.md, color: Colors.text,
  },
  loadingRow: { alignItems: 'center', paddingVertical: Spacing.md },
  results: { flex: 1, marginTop: Spacing.sm },
  userRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm + 2,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border,
  },
  userAvatar: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: Colors.glassDark, borderWidth: 0.5, borderColor: Colors.glassBorder,
    alignItems: 'center', justifyContent: 'center',
  },
  userAvatarText: { fontSize: FontSize.md, fontWeight: '700', color: Colors.textSecondary },
  userInfo: { flex: 1 },
  userName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  userRole: { fontSize: FontSize.xs, color: Colors.textDim, marginTop: 1 },
  checkbox: {
    width: 24, height: 24, borderRadius: 12,
    borderWidth: 2, borderColor: Colors.glassBorder,
    alignItems: 'center', justifyContent: 'center',
  },
  checkboxChecked: {
    backgroundColor: Colors.green, borderColor: Colors.green,
  },
  noResults: { alignItems: 'center', paddingVertical: Spacing.xl },
  noResultsText: { fontSize: FontSize.sm, color: Colors.textDim },

  bottomBar: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border,
    backgroundColor: Colors.bg,
  },
  createBtn: {
    backgroundColor: Colors.primary,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.sm + 4,
    alignItems: 'center', justifyContent: 'center',
  },
  createBtnDisabled: { opacity: 0.4 },
  createBtnText: {
    fontSize: FontSize.md, fontWeight: '700', color: '#fff',
  },
});
